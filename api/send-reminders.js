const {initializeApp, cert, getApps} = require('firebase-admin/app');
const {getFirestore, FieldValue} = require('firebase-admin/firestore');
const {getMessaging} = require('firebase-admin/messaging');

const ADMIN_URL = 'https://beka-davet.vercel.app/admin.html';
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'bekadavet-bfe6f';

function parseServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const json = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
    return JSON.parse(json);
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }

  if (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    return {
      project_id: PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    };
  }

  throw new Error('Firebase service account env vars are missing.');
}

function getAdminClients() {
  if (!getApps().length) {
    const serviceAccount = parseServiceAccount();
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    initializeApp({
      credential: cert(serviceAccount),
      projectId: PROJECT_ID
    });
  }

  return {
    db: getFirestore(),
    messaging: getMessaging()
  };
}

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.authorization || '';
  const querySecret = req.query && req.query.secret;
  return auth === `Bearer ${secret}` || querySecret === secret;
}

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

function buildReminderItems(agenda, offers, today, slot = 'morning') {
  const items = [];

  agenda.forEach(item => {
    const date = item.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return;
    const diff = dayDiff(today, date);
    const lead = reminderLeadDays(item.hatirlatma);
    if (lead < 0 || diff < 0) return;
    const isDue = slot === 'evening'
      ? diff === 1 && lead >= 1
      : diff === 0 || (lead > 1 && diff === lead);
    if (!isDue) return;

    const title = item.baslik || 'Ajanda notu';
    const body = [relativeDayLabel(diff), item.saat, item.konum].filter(Boolean).join(' · ');
    items.push({
      key: `ajanda:${slot}:${item.id || title}:${date}:${item.saat || ''}`,
      title: 'Beka Davet Ajanda',
      body: `${title}${body ? ' · ' + body : ''}`,
      sort: diff * 1440 + (item.saat ? Number(String(item.saat).replace(':', '')) : 9999)
    });
  });

  offers.forEach(offer => {
    const status = offer.durum || 'yeni';
    if (status === 'yeni' && !offer.pushNotifiedAt) {
      const created = tsToDate(offer.tarihEklendi);
      const createdKey = created ? istanbulParts(created) : null;
      const createdText = createdKey ? `${createdKey.day}.${createdKey.month}.${createdKey.year}` : 'yeni talep';
      items.push({
        key: `teklif:${offer.id || offer.tel || offer.ad || createdText}`,
        kind: 'new-offer',
        offerId: offer.id,
        title: 'Yeni Teklif Talebi',
        body: [offer.ad || 'İsimsiz', offer.tel, offer.tur, createdText].filter(Boolean).join(' · '),
        sort: -20
      });
    }

    if (offer.tarih && !['onaylandi', 'kaybedildi'].includes(status)) {
      const diff = dayDiff(today, offer.tarih);
      const isDue = slot === 'evening' ? diff === 1 : diff === 0 || diff === 3;
      if (isDue) {
        items.push({
          key: `teklif-date:${slot}:${offer.id || offer.tel || offer.ad}:${offer.tarih}`,
          title: 'Teklif Tarihi Yaklaşıyor',
          body: [offer.ad || 'Teklif', relativeDayLabel(diff), offer.tur, status].filter(Boolean).join(' · '),
          sort: diff * 1440 - 10
        });
      }
    }
  });

  return items.sort((a, b) => a.sort - b.sort).slice(0, 10);
}

async function markInvalidTokens(db, invalidTokens) {
  for (let i = 0; i < invalidTokens.length; i += 30) {
    const chunk = invalidTokens.slice(i, i + 30);
    const snap = await db.collection('pushTokens').where('token', 'in', chunk).get();
    await Promise.all(snap.docs.map(doc => doc.ref.set({
      active: false,
      disabledAt: FieldValue.serverTimestamp()
    }, {merge: true})));
  }
}

async function sendToTokens(db, messaging, tokens, payload) {
  const invalidTokens = [];
  let successCount = 0;
  let failureCount = 0;

  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
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

    successCount += res.successCount;
    failureCount += res.failureCount;
    res.responses.forEach((r, idx) => {
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        invalidTokens.push(chunk[idx]);
      }
    });
  }

  if (invalidTokens.length) await markInvalidTokens(db, invalidTokens);
  return {successCount, failureCount, invalidTokenCount: invalidTokens.length};
}

async function runReminderPushes({force = false, slot = 'morning'} = {}) {
  const {db, messaging} = getAdminClients();
  const settingsSnap = await db.collection('settings').doc('push').get();
  const settings = settingsSnap.exists ? settingsSnap.data() : {};
  if (settings.enabled === false) return {skipped: true, reason: 'push-disabled'};

  const today = todayKey();
  const agendaEnd = addDays(today, 7);
  const [tokensSnap, agendaSnap, offersSnap, sentSnap] = await Promise.all([
    db.collection('pushTokens').where('active', '==', true).get(),
    db.collection('ajanda').where('date', '>=', today).where('date', '<=', agendaEnd).get(),
    db.collection('teklifler').get(),
    db.collection('pushState').doc(today).get()
  ]);

  const tokens = [...new Set(tokensSnap.docs.map(d => d.data().token).filter(Boolean))];
  if (!tokens.length) return {skipped: true, reason: 'no-active-tokens'};

  const agenda = agendaSnap.docs.map(d => ({id: d.id, ...d.data()}));
  const offers = offersSnap.docs.map(d => ({id: d.id, ...d.data()}));
  const sentKeys = new Set(sentSnap.exists ? (sentSnap.data().sentKeys || []) : []);
  const candidates = buildReminderItems(agenda, offers, today, slot);
  const due = force ? candidates : candidates.filter(item => !sentKeys.has(item.key));
  if (!due.length) return {
    skipped: true,
    reason: 'no-due-reminders',
    today,
    tokenCount: tokens.length,
    agendaCount: agenda.length,
    offerCount: offers.length,
    candidateCount: candidates.length,
    alreadySentCount: candidates.filter(item => sentKeys.has(item.key)).length
  };

  const first = due[0];
  const body = due.length === 1 ? first.body : `${first.body} · +${due.length - 1} uyarı daha`;
  const sendResult = await sendToTokens(db, messaging, tokens, {
    title: first.title,
    body,
    tag: `beka-reminders-${today}`
  });

  if (sendResult.successCount > 0) {
    const notifiedOfferIds = due.filter(item => item.kind === 'new-offer' && item.offerId).map(item => item.offerId);
    await Promise.all([
      db.collection('pushState').doc(today).set({
        sentKeys: FieldValue.arrayUnion(...due.map(item => item.key)),
        updatedAt: FieldValue.serverTimestamp()
      }, {merge: true}),
      ...notifiedOfferIds.map(id => db.collection('teklifler').doc(id).set({
        pushNotifiedAt: FieldValue.serverTimestamp()
      }, {merge: true}))
    ]);
  }

  return {
    skipped: false,
    today,
    slot,
    reminderCount: due.length,
    tokenCount: tokens.length,
    ...sendResult
  };
}

module.exports = async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ok: false, error: 'method-not-allowed'});
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ok: false, error: 'unauthorized'});
  }

  try {
    const force = req.query && req.query.force === '1';
    const requestedSlot = req.query && req.query.slot;
    const schedule = String(req.headers['x-vercel-cron-schedule'] || '');
    const slot = requestedSlot === 'evening' || schedule === '0 15 * * *' ? 'evening' : 'morning';
    const result = await runReminderPushes({force, slot});
    console.log('send-reminders result', result);
    return res.status(200).json({ok: true, ...result});
  } catch (error) {
    console.error('send-reminders failed', error);
    return res.status(500).json({ok: false, error: error.message || 'internal-error'});
  }
};
