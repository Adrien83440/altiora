// api/public-ca-setup.js — Génération / révocation de clé API Alteore
// Utilise Firebase Admin SDK (bypass règles Firestore)

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }      = require('firebase-admin/firestore');

function getDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   'altiora-70599',
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
  return getFirestore();
}

function generateApiKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let key = 'alte_';
  for (let i = 0; i < 35; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ ok: false, error: 'POST uniquement' });

  const { uid, action } = req.body || {};

  if (!uid)    return res.status(400).json({ ok: false, error: 'uid manquant' });
  if (!action) return res.status(400).json({ ok: false, error: 'action manquante (generate|revoke)' });
  if (!['generate', 'revoke'].includes(action)) {
    return res.status(400).json({ ok: false, error: 'action invalide' });
  }

  try {
    const db      = getDb();
    const userRef = db.collection('users').doc(uid);

    if (action === 'generate') {
      const apiKey = generateApiKey();
      await userRef.update({
        apiKey,
        apiKeyCreatedAt: Date.now(),
        apiCallsTotal:   0,
      });
      return res.status(200).json({ ok: true, apiKey });
    }

    if (action === 'revoke') {
      await userRef.update({
        apiKey:          FieldValue.delete(),
        apiKeyCreatedAt: FieldValue.delete(),
      });
      return res.status(200).json({ ok: true });
    }

  } catch (e) {
    console.error('[public-ca-setup]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
