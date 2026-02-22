// api/stripe-webhook.js

const crypto = require('crypto');

// Vérification signature Stripe manuelle
function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = sigHeader.split(',');
  let timestamp = '';
  const signatures = [];
  for (const part of parts) {
    const [key, value] = part.trim().split('=');
    if (key === 't') timestamp = value;
    if (key === 'v1') signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) return false;
  const signedPayload = timestamp + '.' + rawBody;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  return signatures.some(sig => {
    try { return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex')); }
    catch(e) { return false; }
  });
}

// Auth Firebase
async function getFirebaseToken() {
  const res = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + process.env.FIREBASE_API_KEY,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.FIREBASE_API_EMAIL, password: process.env.FIREBASE_API_PASSWORD, returnSecureToken: true }),
    }
  );
  const data = await res.json();
  if (!data.idToken) throw new Error('Auth Firebase échouée: ' + JSON.stringify(data));
  return data.idToken;
}

async function firestoreGet(token, path) {
  const projectId = process.env.FIREBASE_PROJECT_ID || 'altiora-70599';
  const res = await fetch(
    'https://firestore.googleapis.com/v1/projects/' + projectId + '/databases/(default)/documents/' + path,
    { headers: { Authorization: 'Bearer ' + token } }
  );
  return res.json();
}

async function firestorePatch(token, path, fields) {
  const projectId = process.env.FIREBASE_PROJECT_ID || 'altiora-70599';
  const firestoreFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'number') firestoreFields[key] = { integerValue: value.toString() };
    else firestoreFields[key] = { stringValue: String(value) };
  }
  const fieldPaths = Object.keys(fields).map(k => 'updateMask.fieldPaths=' + k).join('&');
  const res = await fetch(
    'https://firestore.googleapis.com/v1/projects/' + projectId + '/databases/(default)/documents/' + path + '?' + fieldPaths,
    {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: firestoreFields }),
    }
  );
  return res.json();
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // Reconstituer le raw body correctement
  let rawBody;
  if (typeof req.body === 'string') {
    rawBody = req.body;
  } else if (Buffer.isBuffer(req.body)) {
    rawBody = req.body.toString('utf8');
  } else {
    rawBody = JSON.stringify(req.body);
  }

  console.log('Webhook reçu — sig:', sig ? sig.slice(0, 30) + '...' : 'ABSENT');
  console.log('Raw body type:', typeof req.body, '| length:', rawBody.length);

  if (!verifyStripeSignature(rawBody, sig, webhookSecret)) {
    console.error('Signature invalide');
    // En mode test, on accepte quand même si la signature est absente (tests manuels)
    if (!sig) {
      console.log('Pas de signature — refus');
      return res.status(400).json({ error: 'Signature manquante' });
    }
    return res.status(400).json({ error: 'Signature Stripe invalide' });
  }

  let event;
  try {
    event = typeof rawBody === 'string' ? JSON.parse(rawBody) : req.body;
  } catch(e) {
    return res.status(400).json({ error: 'JSON invalide' });
  }

  console.log('Event type:', event.type);

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true });
  }

  const session = event.data.object;
  const { uid, packId, smsCount } = session.metadata || {};
  console.log('Metadata:', { uid, packId, smsCount });

  if (!uid || !smsCount) {
    console.error('Metadata manquante');
    return res.status(400).json({ error: 'Metadata manquante' });
  }

  const smsToAdd = parseInt(smsCount);

  try {
    const token = await getFirebaseToken();
    console.log('Firebase auth OK');

    const existing = await firestoreGet(token, 'sms_credits/' + uid);
    const currentSms = parseInt(existing?.fields?.credits?.integerValue || '0');
    const newSms = currentSms + smsToAdd;
    console.log('Solde actuel:', currentSms, '→ nouveau:', newSms);

    await firestorePatch(token, 'sms_credits/' + uid, {
      credits: newSms,
      lastPack: packId,
      lastPurchase: new Date().toISOString().slice(0, 10),
    });

    const txId = Date.now().toString();
    await firestorePatch(token, 'sms_credits/' + uid + '/history/' + txId, {
      packId: packId,
      smsAdded: smsToAdd,
      date: new Date().toISOString().slice(0, 10),
      stripeSessionId: session.id,
      amount: session.amount_total || 0,
    });

    console.log('✅ SMS crédités:', smsToAdd, '| nouveau solde:', newSms);
    return res.status(200).json({ success: true, newBalance: newSms });

  } catch (err) {
    console.error('Erreur Firebase:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
