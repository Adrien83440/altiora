// api/stripe-webhook.js
// Webhook Stripe SMS — avec vérification de signature HMAC-SHA256

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

  // ── Lire le body brut (bodyParser désactivé) ──
  let rawBody = '';
  try {
    rawBody = await new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  } catch (e) {
    return res.status(400).json({ error: 'Cannot read body' });
  }

  // ── Vérification signature Stripe ──
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (webhookSecret) {
    const sigHeader = req.headers['stripe-signature'];
    if (!sigHeader) return res.status(400).json({ error: 'Signature manquante' });

    try {
      const crypto = require('crypto');
      const parts = sigHeader.split(',').reduce((acc, part) => {
        const [k, v] = part.split('=');
        acc[k] = v;
        return acc;
      }, {});

      const timestamp = parts.t;
      const signature = parts.v1;
      const payload   = timestamp + '.' + rawBody;
      const expected  = crypto.createHmac('sha256', webhookSecret).update(payload).digest('hex');

      if (expected !== signature) {
        return res.status(400).json({ error: 'Signature invalide' });
      }

      // Rejeter les événements trop vieux (> 5 min)
      if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) {
        return res.status(400).json({ error: 'Événement trop ancien' });
      }
    } catch (e) {
      return res.status(400).json({ error: 'Erreur vérification signature: ' + e.message });
    }
  }

  // ── Parser l'événement ──
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).json({ error: 'JSON invalide' });
  }

  console.log('Webhook reçu — type:', event && event.type);

  if (!event || !event.type) {
    return res.status(400).json({ error: 'Body invalide' });
  }

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true });
  }

  const session = event.data && event.data.object;
  const metadata = session && session.metadata;
  const uid = metadata && metadata.uid;
  const packId = metadata && metadata.packId;
  const smsCount = metadata && metadata.smsCount;

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
    const currentSms = parseInt((existing.fields && existing.fields.credits && existing.fields.credits.integerValue) || '0');
    const newSms = currentSms + smsToAdd;
    console.log('Solde:', currentSms, '→', newSms);

    await firestorePatch(token, 'sms_credits/' + uid, {
      credits: newSms,
      lastPack: packId || '',
      lastPurchase: new Date().toISOString().slice(0, 10),
    });

    const txId = Date.now().toString();
    await firestorePatch(token, 'sms_credits/' + uid + '/history/' + txId, {
      packId: packId || '',
      smsAdded: smsToAdd,
      date: new Date().toISOString().slice(0, 10),
      stripeSessionId: session.id || '',
      amount: session.amount_total || 0,
    });

    console.log('✅ Crédités:', smsToAdd, '| Solde:', newSms);
    return res.status(200).json({ success: true, newBalance: newSms });

  } catch (err) {
    console.error('Erreur Firebase:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Vercel : désactiver le bodyParser pour lire le rawBody (signature Stripe) ──
module.exports.config = {
  api: { bodyParser: false }
};
