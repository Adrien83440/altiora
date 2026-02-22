// api/stripe-webhook.js
// Reçoit la confirmation de paiement Stripe et crédite les SMS dans Firebase

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Authentification Firebase via REST (pas besoin de service account)
async function getFirebaseToken() {
  const apiKey = process.env.FIREBASE_API_KEY;
  const email = process.env.FIREBASE_API_EMAIL;
  const password = process.env.FIREBASE_API_PASSWORD;

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  const data = await res.json();
  if (!data.idToken) throw new Error('Auth Firebase échouée: ' + JSON.stringify(data));
  return data.idToken;
}

// Lire un document Firestore via REST
async function firestoreGet(token, projectId, path) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}

// Écrire/mettre à jour un document Firestore via REST (merge)
async function firestorePatch(token, projectId, path, fields) {
  // Convertir les champs en format Firestore
  const firestoreFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'number') {
      firestoreFields[key] = { integerValue: value.toString() };
    } else if (typeof value === 'string') {
      firestoreFields[key] = { stringValue: value };
    } else if (typeof value === 'boolean') {
      firestoreFields[key] = { booleanValue: value };
    }
  }

  // Construire le masque de mise à jour (updateMask)
  const fieldMask = Object.keys(fields).join(',');
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}?updateMask.fieldPaths=${Object.keys(fields).join('&updateMask.fieldPaths=')}`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: firestoreFields }),
  });
  return res.json();
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    // Vérifier la signature Stripe (sécurité critique)
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Signature webhook invalide:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // On ne traite que les paiements réussis
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true });
  }

  const session = event.data.object;
  const { uid, packId, smsCount } = session.metadata;

  if (!uid || !smsCount) {
    console.error('Metadata manquante:', session.metadata);
    return res.status(400).json({ error: 'Metadata manquante' });
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || 'altiora-70599';
  const smsToAdd = parseInt(smsCount);

  try {
    const token = await getFirebaseToken();

    // Lire le solde SMS actuel
    const docPath = `sms_credits/${uid}`;
    const existing = await firestoreGet(token, projectId, docPath);

    let currentSms = 0;
    if (existing.fields && existing.fields.credits) {
      currentSms = parseInt(existing.fields.credits.integerValue || 0);
    }

    const newSms = currentSms + smsToAdd;

    // Mettre à jour le solde
    await firestorePatch(token, projectId, docPath, {
      credits: newSms,
      lastPack: packId,
      lastPurchase: new Date().toISOString().slice(0, 10),
    });

    // Enregistrer la transaction dans l'historique
    const txId = Date.now().toString();
    await firestorePatch(token, projectId, `sms_credits/${uid}/history/${txId}`, {
      packId,
      smsAdded: smsToAdd,
      date: new Date().toISOString().slice(0, 10),
      stripeSessionId: session.id,
      amount: session.amount_total,
    });

    console.log(`✅ SMS crédités: ${smsToAdd} → uid ${uid} (nouveau solde: ${newSms})`);
    return res.status(200).json({ success: true, newBalance: newSms });

  } catch (err) {
    console.error('Erreur Firebase:', err);
    return res.status(500).json({ error: err.message });
  }
};
