const {initializeApp, cert, getApps} = require('firebase-admin/app');
const {getFirestore, FieldValue} = require('firebase-admin/firestore');
const {getMessaging} = require('firebase-admin/messaging');

const ADMIN_URL = 'https://beka-davet.vercel.app/admin.html';
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'bekadavet-bfe6f';

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

async function markInvalidTokens(db, invalidTokens) {
  for (let i = 0; i < invalidTokens.length; i += 30) {
    const snap = await db.collection('pushTokens').where('token', 'in', invalidTokens.slice(i, i + 30)).get();
    await Promise.all(snap.docs.map(doc => doc.ref.set({
      active: false,
      disabledAt: FieldValue.serverTimestamp()
    }, {merge: true})));
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ok: false, error: 'method-not-allowed'});
  }

  try {
    const offerId = String((req.body && req.body.offerId) || '').trim();
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(offerId)) {
      return res.status(400).json({ok: false, error: 'invalid-offer-id'});
    }

    const {db, messaging} = getAdminClients();
    const offerRef = db.collection('teklifler').doc(offerId);
    const offerSnap = await offerRef.get();
    if (!offerSnap.exists) return res.status(404).json({ok: false, error: 'offer-not-found'});

    const offer = offerSnap.data();
    if (offer.pushNotifiedAt) return res.status(200).json({ok: true, skipped: true, reason: 'already-notified'});

    const settingsSnap = await db.collection('settings').doc('push').get();
    if (settingsSnap.exists && settingsSnap.data().enabled === false) {
      return res.status(200).json({ok: true, skipped: true, reason: 'push-disabled'});
    }

    const tokensSnap = await db.collection('pushTokens').where('active', '==', true).get();
    const tokens = [...new Set(tokensSnap.docs.map(d => d.data().token).filter(Boolean))];
    if (!tokens.length) return res.status(200).json({ok: true, skipped: true, reason: 'no-active-tokens'});

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
      await offerRef.set({pushNotifiedAt: FieldValue.serverTimestamp()}, {merge: true});
    }
    return res.status(200).json({ok: true, tokenCount: tokens.length, successCount, failureCount});
  } catch (error) {
    console.error('notify-new-offer failed', error);
    return res.status(500).json({ok: false, error: error.message || 'internal-error'});
  }
};
