const crypto = require('crypto');
const {initializeApp, cert, getApps} = require('firebase-admin/app');
const {getFirestore, FieldValue} = require('firebase-admin/firestore');
const {getMessaging} = require('firebase-admin/messaging');

const ADMIN_URL = 'https://beka-davet.vercel.app/admin.html';
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'bekadavet-bfe6f';
const OFFER_LIMIT_PER_HOUR = 8;

function parseServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    return JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'));
  }
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
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
    if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    initializeApp({credential: cert(serviceAccount), projectId: PROJECT_ID});
  }
  return {db: getFirestore(), messaging: getMessaging()};
}

function cleanString(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown');
}

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hourKey(date = new Date()) {
  return date.toISOString().slice(0, 13);
}

function validateOffer(body) {
  const ad = cleanString(body.ad, 120);
  const tel = cleanString(body.tel, 32);
  const cleanTel = tel.replace(/\D/g, '');
  if (ad.length < 2) return {error: 'invalid-name'};
  if (cleanTel.length < 10) return {error: 'invalid-phone'};
  return {
    value: {
      ad,
      tel,
      tur: cleanString(body.tur, 80),
      tarih: cleanString(body.tarih, 32),
      butce: cleanString(body.butce, 80),
      kaynak: cleanString(body.kaynak, 80),
      mesaj: cleanString(body.mesaj, 1000),
      durum: 'yeni'
    }
  };
}

function requestBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  return req.body || {};
}

async function checkRateLimit(db, req) {
  const ipHash = hashValue(clientIp(req)).slice(0, 32);
  const key = `${hourKey()}_${ipHash}`;
  const ref = db.collection('rateLimits').doc(`offer_${key}`);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const count = snap.exists ? Number(snap.data().count || 0) : 0;
    if (count >= OFFER_LIMIT_PER_HOUR) {
      const err = new Error('rate-limited');
      err.statusCode = 429;
      throw err;
    }
    tx.set(ref, {
      count: count + 1,
      updatedAt: FieldValue.serverTimestamp()
    }, {merge: true});
  });
}

async function markInvalidTokens(db, invalidTokens) {
  for (let i = 0; i < invalidTokens.length; i += 30) {
    const snap = await db.collection('pushTokens').where('token', 'in', invalidTokens.slice(i, i + 30)).get();
    await Promise.all(snap.docs.map(doc => doc.ref.set({
      active: false,
      disabledAt: FieldValue.serverTimestamp()
    }, {merge: true})));
  }
}

async function notifyNewOffer(db, messaging, offerId, offer) {
  const settingsSnap = await db.collection('settings').doc('push').get();
  if (settingsSnap.exists && settingsSnap.data().enabled === false) {
    return {skipped: true, reason: 'push-disabled'};
  }

  const tokensSnap = await db.collection('pushTokens').where('active', '==', true).get();
  const tokens = [...new Set(tokensSnap.docs.map(d => d.data().token).filter(Boolean))];
  if (!tokens.length) return {skipped: true, reason: 'no-active-tokens'};

  let successCount = 0;
  let failureCount = 0;
  const invalidTokens = [];
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const result = await messaging.sendEachForMulticast({
      tokens: chunk,
      notification: {
        title: 'Yeni Fiyat Teklifi',
        body: [offer.ad || 'İsimsiz', offer.tel, offer.tur].filter(Boolean).join(' · ')
      },
      data: {url: ADMIN_URL, tag: `beka-new-offer-${offerId}`},
      webpush: {
        fcmOptions: {link: ADMIN_URL},
        notification: {tag: `beka-new-offer-${offerId}`, requireInteraction: true}
      }
    });
    successCount += result.successCount;
    failureCount += result.failureCount;
    result.responses.forEach((item, index) => {
      const code = item.error && item.error.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        invalidTokens.push(chunk[index]);
      }
    });
  }

  if (invalidTokens.length) await markInvalidTokens(db, invalidTokens);
  if (successCount > 0) {
    await db.collection('teklifler').doc(offerId).set({pushNotifiedAt: FieldValue.serverTimestamp()}, {merge: true});
  }
  return {tokenCount: tokens.length, successCount, failureCount};
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ok: false, error: 'method-not-allowed'});
  }

  try {
    const parsed = validateOffer(requestBody(req));
    if (parsed.error) return res.status(400).json({ok: false, error: parsed.error});

    const {db, messaging} = getAdminClients();
    await checkRateLimit(db, req);

    const ref = await db.collection('teklifler').add({
      ...parsed.value,
      tarihEklendi: FieldValue.serverTimestamp(),
      source: 'public-form'
    });
    const notification = await notifyNewOffer(db, messaging, ref.id, parsed.value);
    return res.status(200).json({ok: true, offerId: ref.id, notification});
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('create-offer failed', error);
    return res.status(status).json({ok: false, error: status >= 500 ? 'internal-error' : error.message});
  }
};
