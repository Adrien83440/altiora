// api/public-ca-setup.js
// ─────────────────────────────────────────────────────────────────────────────
// Gestion des API keys pour l'intégration caisse
//
// POST /api/public-ca-setup   { action: "generate" | "revoke" }
// Auth : Firebase ID token dans Authorization: Bearer {idToken}
// ─────────────────────────────────────────────────────────────────────────────

const FIREBASE_PROJECT = 'altiora-70599';
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function errResp(res, status, code, message) {
  return res.status(status).json({ ok: false, error: { code, message } });
}

// Génère une clé de 40 caractères : "alte_" + 35 chars hex
function generateKey() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let key = 'alte_';
  for (let i = 0; i < 35; i++) {
    key += chars[Math.floor(Math.random() * chars.length)];
  }
  return key;
}

// Vérifie un Firebase ID token et retourne uid
async function verifyIdToken(idToken) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken })
  });
  const data = await r.json();
  if (!r.ok || !data.users?.[0]) return null;
  return data.users[0].localId; // uid
}

// Lit un doc Firestore
async function fsGet(path) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?key=${FIREBASE_API_KEY}`;
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('fsGet failed ' + r.status);
  const doc = await r.json();
  return doc.fields ? fsDocToObj(doc.fields) : null;
}

// Écrit des champs spécifiques (PATCH avec updateMask)
async function fsPatch(path, fields) {
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?${mask}&key=${FIREBASE_API_KEY}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: objToFsFields(fields) })
  });
  if (!r.ok) throw new Error('fsPatch failed ' + r.status);
  return r.json();
}

function objToFsFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null)             out[k] = { nullValue: null };
    else if (typeof v === 'boolean') out[k] = { booleanValue: v };
    else if (typeof v === 'number')  out[k] = { doubleValue: v };
    else if (typeof v === 'string')  out[k] = { stringValue: v };
  }
  return out;
}

function fsDocToObj(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if ('stringValue'  in v) out[k] = v.stringValue;
    else if ('integerValue' in v) out[k] = parseInt(v.integerValue);
    else if ('doubleValue'  in v) out[k] = parseFloat(v.doubleValue);
    else if ('booleanValue' in v) out[k] = v.booleanValue;
    else out[k] = null;
  }
  return out;
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return errResp(res, 405, 'METHOD_NOT_ALLOWED', 'POST uniquement');

  try {
    // ── Auth via Firebase ID token ──
    const auth = req.headers['authorization'] || '';
    if (!auth.startsWith('Bearer ')) {
      return errResp(res, 401, 'MISSING_TOKEN', 'ID token Firebase requis');
    }
    const idToken = auth.slice(7).trim();
    const uid = await verifyIdToken(idToken);
    if (!uid) return errResp(res, 401, 'INVALID_TOKEN', 'Token Firebase invalide ou expiré');

    const { action } = req.body || {};

    if (action === 'generate') {
      const newKey = generateKey();
      await fsPatch(`users/${uid}`, {
        apiKey:          newKey,
        apiKeyCreatedAt: new Date().toISOString(),
        apiCallsTotal:   0,
      });
      return res.status(200).json({ ok: true, apiKey: newKey });
    }

    if (action === 'revoke') {
      await fsPatch(`users/${uid}`, {
        apiKey:          '',
        apiKeyCreatedAt: '',
      });
      return res.status(200).json({ ok: true, message: 'Clé révoquée' });
    }

    return errResp(res, 400, 'BAD_ACTION', 'action doit être "generate" ou "revoke"');

  } catch (e) {
    console.error('[public-ca-setup] erreur:', e);
    return errResp(res, 500, 'INTERNAL_ERROR', e.message);
  }
};
