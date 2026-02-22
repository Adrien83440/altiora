// api/stripe-webhook.js — sans dépendance npm, vérification signature manuelle

const crypto = require('crypto');

// Vérification signature Stripe sans le package npm
function verifyStripeSignature(payload, sigHeader, secret) {
  const parts = sigHeader.split(',');
  let timestamp = '';
  const signatures = [];

  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 't') timestamp = value;
    if (key === 'v1') signatures.push(value);
  }

  if (!timestamp || signatures.length === 0) return false;

  // Vérifier que le timestamp est récent (5 minutes max)
  const tolerance = 300;
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > tolerance) return false;

  const signedPayload = timestamp + '.' + payload;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');

  return signatures.some(sig => crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(sig, 'hex')
  ));
}

// Auth Firebase via REST
async function getFirebaseToken() {
  const res = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + process.env.FIREBASE_API_KEY,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: process.env.FIREBASE_API_EMAIL,
        password: process.env.FIREBASE_API_PASSWORD,
        returnSecureToken: true,
      }),
    }
  );
  const data = await res.json();
  if (!data.idToken) throw new Error('Auth Firebase échouée: ' + JSON.stringify(data));
  return data.idToken;
}

// Lire un document Firestore
async function firestoreGet(token, path) {
  const projectId = process.env.FIREBASE_PROJECT_ID || 'altiora-70599';
  const res = await fetch(
    'https://firestore.googleapis.com/v1/projects/' + projectId + '/databases/(default)/documents/' + path,
    { headers: { Authorization: 'Bearer ' + token } }
  );
  return res.json();
}

// Écrire dans Firestore (merge)
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

  // Récupérer le body brut (nécessaire pour la vérification de signature)
  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

  if (!verifyStripeSignature(rawBody, sig, webhookSecret)) {
    console.error('Signature Stripe invalide');
    return res.status(400).json({ error: 'Signature invalide' });
  }

  const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true });
  }

  const session = event.data.object;
  const { uid, packId, smsCount } = session.metadata;

  if (!uid || !smsCount) {
    console.error('Metadata manquante:', session.metadata);
    return res.status(400).json({ error: 'Metadata manquante' });
  }

  const smsToAdd = parseInt(smsCount);

  try {
    const token = await getFirebaseToken();

    // Lire le solde actuel
    const existing = await firestoreGet(token, 'sms_credits/' + uid);
    const currentSms = parseInt(existing?.fields?.credits?.integerValue || '0');
    const newSms = currentSms + smsToAdd;

    // Mettre à jour le solde
    await firestorePatch(token, 'sms_credits/' + uid, {
      credits: newSms,
      lastPack: packId,
      lastPurchase: new Date().toISOString().slice(0, 10),
    });

    // Historique
    const txId = Date.now().toString();
    await firestorePatch(token, 'sms_credits/' + uid + '/history/' + txId, {
      packId,
      smsAdded: smsToAdd,
      date: new Date().toISOString().slice(0, 10),
      stripeSessionId: session.id,
      amount: session.amount_total || 0,
    });

    console.log('✅ SMS crédités:', smsToAdd, '→ uid', uid, '| nouveau solde:', newSms);
    return res.status(200).json({ success: true, newBalance: newSms });
  } catch (err) {
    console.error('Erreur Firebase:', err);
    return res.status(500).json({ error: err.message });
  }
};
