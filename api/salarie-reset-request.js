// api/salarie-reset-request.js
// Appele par un salarie qui a oublie son PIN.
// Genere un code temporaire que le manager voit dans rh-employes,
// puis le manager "Approuve" pour generer un nouveau PIN (salarie-reset-approve).
//
// Input:  { publicId }
// Output: { success: true, message, alreadyPending? } ou { success: false, error }

const crypto = require('crypto');

const FIREBASE_PROJECT = 'altiora-70599';
const FB_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
const IDT_BASE = 'https://identitytoolkit.googleapis.com/v1';

let _adminToken = null;
let _adminTokenExp = 0;

async function getAdminToken() {
  if (_adminToken && Date.now() < _adminTokenExp - 300000) return _adminToken;
  const email = process.env.FIREBASE_API_EMAIL;
  const password = process.env.FIREBASE_API_PASSWORD;
  if (!email || !password) { console.error('[reset-request] FIREBASE_API_EMAIL/PASSWORD manquants'); return null; }
  const r = await fetch(`${IDT_BASE}/accounts:signInWithPassword?key=${FB_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const data = await r.json();
  if (data.idToken) {
    _adminToken = data.idToken;
    _adminTokenExp = Date.now() + (parseInt(data.expiresIn || '3600') * 1000);
    return _adminToken;
  }
  console.error('[reset-request] Admin login failed:', data.error && data.error.message);
  return null;
}

function authHeaders(token) {
  return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
}

function toFsFields(obj) {
  const ff = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined)     ff[k] = { nullValue: null };
    else if (typeof v === 'string')        ff[k] = { stringValue: v };
    else if (typeof v === 'boolean')       ff[k] = { booleanValue: v };
    else if (typeof v === 'number') {
      if (Number.isInteger(v))             ff[k] = { integerValue: String(v) };
      else                                 ff[k] = { doubleValue: v };
    }
    else                                   ff[k] = { stringValue: String(v) };
  }
  return ff;
}

function fromFsFields(fields) {
  if (!fields) return {};
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v.stringValue !== undefined)       out[k] = v.stringValue;
    else if (v.integerValue !== undefined) out[k] = parseInt(v.integerValue);
    else if (v.doubleValue !== undefined)  out[k] = v.doubleValue;
    else if (v.booleanValue !== undefined) out[k] = v.booleanValue;
    else if (v.nullValue !== undefined)    out[k] = null;
    else                                    out[k] = v;
  }
  return out;
}

async function fsGet(path, token) {
  const r = await fetch(`${FS_BASE}/${path}`, { headers: authHeaders(token) });
  if (r.status === 404) return { exists: false, data: null };
  if (!r.ok) throw new Error(`fsGet ${path} → ${r.status}: ${await r.text()}`);
  const json = await r.json();
  return { exists: true, data: fromFsFields(json.fields) };
}

async function fsSet(path, fields, token) {
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const r = await fetch(`${FS_BASE}/${path}?${mask}`, {
    method: 'PATCH', headers: authHeaders(token),
    body: JSON.stringify({ fields: toFsFields(fields) }),
  });
  if (!r.ok) throw new Error(`fsSet ${path} → ${r.status}: ${await r.text()}`);
  return true;
}

// Code 6 chars alphanumerique (sans 0/O, 1/I)
function genTempCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { publicId } = req.body || {};
    if (!publicId || typeof publicId !== 'string' || publicId.length < 6) {
      return res.status(400).json({ success: false, error: 'invalid_input' });
    }

    const token = await getAdminToken();
    if (!token) return res.status(500).json({ success: false, error: 'admin_auth_failed' });

    const pub = await fsGet(`rh_employes_public/${publicId}`, token);
    if (!pub.exists) {
      // Reponse neutre
      return res.status(200).json({ success: true, message: 'Votre demande a ete transmise.' });
    }

    const auth = await fsGet(`rh_auth_salaries/${publicId}`, token);
    const authData = auth.exists ? (auth.data || {}) : {};

    const now = Date.now();
    if (authData.tempResetCode && authData.tempResetExpiresAt) {
      const expTs = new Date(authData.tempResetExpiresAt).getTime();
      if (!isNaN(expTs) && expTs > now) {
        return res.status(200).json({
          success: true,
          message: 'Votre demande est deja en cours de traitement.',
          alreadyPending: true,
        });
      }
    }

    const code = genTempCode();
    const expiresAt = new Date(now + 24 * 3600 * 1000).toISOString();
    await fsSet(`rh_auth_salaries/${publicId}`, {
      tempResetCode: code,
      tempResetExpiresAt: expiresAt,
      tempResetRequestedAt: new Date(now).toISOString(),
    }, token);

    return res.status(200).json({
      success: true,
      message: 'Votre demande a ete transmise a votre employeur.',
    });

  } catch (e) {
    console.error('[salarie-reset-request]', e);
    return res.status(500).json({ success: false, error: 'server_error', detail: String(e.message || e) });
  }
};
