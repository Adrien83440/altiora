// api/public-ca-setup.js — Génération / révocation de clé API Alteore
// Le client envoie son uid (déjà authentifié côté Firebase Auth frontend)

const FB_PROJECT = 'altiora-70599';
const FB_KEY     = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
const FS_BASE    = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

function generateApiKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let key = 'alte_';
  for (let i = 0; i < 35; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

async function fsGet(uid) {
  const r = await fetch(`${FS_BASE}/users/${uid}?key=${FB_KEY}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Firestore GET ${r.status}`);
  return r.json();
}

async function fsPatch(uid, fieldsObj) {
  const mask = Object.keys(fieldsObj).map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
  const url  = `${FS_BASE}/users/${uid}?${mask}&key=${FB_KEY}`;

  const fields = {};
  for (const [k, v] of Object.entries(fieldsObj)) {
    if (v === null)              fields[k] = { nullValue: null };
    else if (typeof v === 'string')  fields[k] = { stringValue: v };
    else if (typeof v === 'number')  fields[k] = { integerValue: String(Math.round(v)) };
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
  }

  const r = await fetch(url, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ fields })
  });

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Firestore PATCH ${r.status}: ${txt}`);
  }
  return r.json();
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
    const doc = await fsGet(uid);
    if (!doc) return res.status(404).json({ ok: false, error: 'Utilisateur introuvable' });

    if (action === 'generate') {
      const apiKey = generateApiKey();
      await fsPatch(uid, {
        apiKey,
        apiKeyCreatedAt: Date.now(),
        apiCallsTotal:   0
      });
      return res.status(200).json({ ok: true, apiKey });
    }

    if (action === 'revoke') {
      await fsPatch(uid, { apiKey: null });
      return res.status(200).json({ ok: true });
    }

  } catch (e) {
    console.error('[public-ca-setup]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
