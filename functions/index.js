const {onSchedule} = require('firebase-functions/v2/scheduler');
const {initializeApp} = require('firebase-admin/app');
const {getFirestore, FieldValue} = require('firebase-admin/firestore');
const {getMessaging} = require('firebase-admin/messaging');

initializeApp();

const db = getFirestore();
const messaging = getMessaging();
const ADMIN_URL = 'https://beka-davet.vercel.app/admin.html';

function istanbulParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}

function todayKey() {
  const p = istanbulParts();
  return `${p.year}-${p.month}-${p.day}`;
}

function addDays(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
  return date.toISOString().slice(0, 10);
}

function dayDiff(fromKey, toKey) {
  const [fy, fm, fd] = fromKey.split('-').map(Number);
  const [ty, tm, td] = toKey.split('-').map(Number);
  const from = Date.UTC(fy, fm - 1, fd, 12, 0, 0);
  const to = Date.UTC(ty, tm - 1, td, 12, 0, 0);
  return Math.round((to - from) / 86400000);
}

function reminderLeadDays(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 1;
}

function relativeDayLabel(diff) {
  if (diff === 0) return 'bugün';
  if (diff === 1) return 'yarın';
  if (diff > 1) return `${diff} gün sonra`;
  return `${Math.abs(diff)} gün geçti`;
}

function tsToDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function buildReminderItems(agenda, offers, today) {
  const items = [];
  agenda.forEach(item => {
    const date = item.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return;
    const diff = dayDiff(today, date);
    const lead = reminderLeadDays(item.hatirlatma);
    if (lead < 0 || diff < 0 || diff > lead) return;
    const title = item.baslik || 'Ajanda notu';
    const body = [relativeDayLabel(diff), item.saat, item.konum].filter(Boolean).join(' · ');
    items.push({
      key: `ajanda:${item.id || title}:${date}:${item.saat || ''}`,
      title: 'Beka Davet Ajanda',
      body: `${title}${body ? ' · ' + body : ''}`,
      sort: diff * 1440 + (item.saat ? Number(String(item.saat).replace(':', '')) : 9999)
    });
  });

  offers.forEach(offer => {
    const status = offer.durum || 'yeni';
    if (status === 'yeni') {
      const created = tsToDate(offer.tarihEklendi);
      const createdKey = created ? istanbulParts(created) : null;
      const createdText = createdKey ? `${createdKey.day}.${createdKey.month}.${createdKey.year}` : 'yeni talep';
      items.push({
        key: `teklif:${offer.id || offer.tel || offer.ad || createdText}`,
        title: 'Yeni Teklif Talebi',
        body: [offer.ad || 'İsimsiz', offer.tel, offer.tur, createdText].filter(Boolean).join(' · '),
        sort: -20
      });
    }

    if (offer.tarih && !['onaylandi', 'kaybedildi'].includes(status)) {
      const diff = dayDiff(today, offer.tarih);
      if (diff >= 0 && diff <= 3) {
        items.push({
          key: `teklif-date:${offer.id || offer.tel || offer.ad}:${offer.tarih}`,
          title: 'Teklif Tarihi Yaklaşıyor',
          body: [offer.ad || 'Teklif', relativeDayLabel(diff), offer.tur, status].filter(Boolean).join(' · '),
          sort: diff * 1440 - 10
        });
      }
    }
  });

  return items.sort((a, b) => a.sort - b.sort).slice(0, 10);
}

async function sendToTokens(tokens, payload) {
  const chunks = [];
  for (let i = 0; i < tokens.length; i += 500) chunks.push(tokens.slice(i, i + 500));
  const invalidTokens = [];

  for (const chunk of chunks) {
    const res = await messaging.sendEachForMulticast({
      tokens: chunk,
      notification: {
        title: payload.title,
        body: payload.body
      },
      data: {
        url: ADMIN_URL,
        tag: payload.tag
      },
      webpush: {
        fcmOptions: {link: ADMIN_URL},
        notification: {
          tag: payload.tag,
          requireInteraction: true
        }
      }
    });

    res.responses.forEach((r, idx) => {
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        invalidTokens.push(chunk[idx]);
      }
    });
  }

  if (invalidTokens.length) {
    const snap = await db.collection('pushTokens').where('token', 'in', invalidTokens.slice(0, 30)).get();
    await Promise.all(snap.docs.map(doc => doc.ref.set({active: false, disabledAt: FieldValue.serverTimestamp()}, {merge: true})));
  }
}

exports.sendReminderPushes = onSchedule({
  schedule: 'every 30 minutes',
  timeZone: 'Europe/Istanbul',
  region: 'europe-west1'
}, async () => {
  const settingsSnap = await db.collection('settings').doc('push').get();
  const settings = settingsSnap.exists ? settingsSnap.data() : {};
  if (settings.enabled === false) return;

  const today = todayKey();
  const agendaEnd = addDays(today, 7);
  const [tokensSnap, agendaSnap, offersSnap, sentSnap] = await Promise.all([
    db.collection('pushTokens').where('active', '==', true).get(),
    db.collection('ajanda').where('date', '>=', today).where('date', '<=', agendaEnd).get(),
    db.collection('teklifler').get(),
    db.collection('pushState').doc(today).get()
  ]);

  const tokens = [...new Set(tokensSnap.docs.map(d => d.data().token).filter(Boolean))];
  if (!tokens.length) return;

  const agenda = agendaSnap.docs.map(d => ({id: d.id, ...d.data()}));
  const offers = offersSnap.docs.map(d => ({id: d.id, ...d.data()}));
  const sentKeys = new Set(sentSnap.exists ? (sentSnap.data().sentKeys || []) : []);
  const due = buildReminderItems(agenda, offers, today).filter(item => !sentKeys.has(item.key));
  if (!due.length) return;

  const first = due[0];
  const body = due.length === 1 ? first.body : `${first.body} · +${due.length - 1} uyarı daha`;
  await sendToTokens(tokens, {
    title: first.title,
    body,
    tag: `beka-reminders-${today}`
  });

  await db.collection('pushState').doc(today).set({
    sentKeys: FieldValue.arrayUnion(...due.map(item => item.key)),
    updatedAt: FieldValue.serverTimestamp()
  }, {merge: true});
});
