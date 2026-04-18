// api/salarie-verify-pin.js
// Verifie le PIN saisi par un salarie et retourne un token de session.
//
// Input:  { publicId: string, pin: string (4 chiffres) }
// Output OK: { success: true, token: string, expiresAt: ISO }
// Output KO: { success: false, error, attemptsRemaining, lockedUntil }
//
// Pattern : REST API + compte admin api@altiora.app

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
  if (!email || !password) { console.error('[verify-pin] FIREBASE_API_EMAIL/PASSWORD manquants'); return null; }
  const r = await fetch(`${IDT_BASE}/accounts:signInWithPassword?key=${FB_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const data = await r.json();
  if (data.idToken) {
    _adminToken = data.idToken;
    _adminTokenExp = Date.now() + (parseInt(data.expiresIn || '3600') * 1000);
    return _adminToken;
  }
  console.error('[verify-pin] Admin login failed:', data.error && data.error.message);
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

// ── Crypto helpers ──
function hashPin(publicId, pin) {
  const secret = process.env.PIN_SERVER_SECRET || '';
  if (secret.length < 16) throw new Error('PIN_SERVER_SECRET manquant ou trop court');
  return crypto.createHash('sha256').update(secret + ':' + publicId + ':' + pin).digest('hex');
}

function makeSessionToken(publicId, ttlHours) {
  const secret = process.env.PIN_SERVER_SECRET;
  const expiresAt = Date.now() + (ttlHours * 3600 * 1000);
  const payload = publicId + ':' + expiresAt;
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return payloadB64 + '.' + sig;
}

function computeLockUntil(newAttempts) {
  const now = Date.now();
  if (newAttempts === 5)  return new Date(now +  5 * 60 * 1000).toISOString();
  if (newAttempts === 10) return new Date(now + 60 * 60 * 1000).toISOString();
  if (newAttempts >= 15)  return new Date(now + 24 * 60 * 60 * 1000).toISOString();
  return null;
}

function getAttemptsRemaining(pinAttempts) {
  const n = parseInt(pinAttempts) || 0;
  if (n < 5)  return 5  - n;
  if (n < 10) return 10 - n;
  if (n < 15) return 15 - n;
  return 0;
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { publicId, pin } = req.body || {};

    if (!publicId || typeof publicId !== 'string' || publicId.length < 6) {
      return res.status(400).json({ success: false, error: 'invalid_input' });
    }
    if (!pin || typeof pin !== 'string' || !/^[0-9]{4}$/.test(pin)) {
      return res.status(400).json({ success: false, error: 'invalid_pin_format' });
    }
    if (!process.env.PIN_SERVER_SECRET || process.env.PIN_SERVER_SECRET.length < 16) {
      console.error('[verify-pin] PIN_SERVER_SECRET manquant ou trop court');
      return res.status(500).json({ success: false, error: 'server_config' });
    }

    const token = await getAdminToken();
    if (!token) return res.status(500).json({ success: false, error: 'admin_auth_failed' });

    // 1. Salarie existe ?
    const pub = await fsGet(`rh_employes_public/${publicId}`, token);
    if (!pub.exists) {
      return res.status(200).json({
        success: false, error: 'invalid_credentials',
        attemptsRemaining: 5, lockedUntil: null,
      });
    }

    // 2. Doc auth
    const auth = await fsGet(`rh_auth_salaries/${publicId}`, token);
    if (!auth.exists) {
      return res.status(200).json({
        success: false, error: 'no_pin_set',
        attemptsRemaining: 5, lockedUntil: null,
      });
    }

    const authData = auth.data || {};
    const hasPin = !!(authData.pinHash && String(authData.pinHash).length > 0);
    if (!hasPin) {
      return res.status(200).json({
        success: false, error: 'no_pin_set',
        attemptsRemaining: 5, lockedUntil: null,
      });
    }

    // 3. Check lock actif
    const now = Date.now();
    if (authData.pinLockedUntil) {
      const lockTs = new Date(authData.pinLockedUntil).getTime();
      if (!isNaN(lockTs) && lockTs > now) {
        return res.status(200).json({
          success: false, error: 'locked',
          attemptsRemaining: 0, lockedUntil: authData.pinLockedUntil,
        });
      }
    }

    // 4. Hash + compare timing-safe
    const candidateHash = hashPin(publicId, pin);
    const match = timingSafeEqualStr(candidateHash, authData.pinHash);

    if (match) {
      // Success : reset compteur + token
      const sessToken = makeSessionToken(publicId, 8);
      const expiresAt = new Date(now + 8 * 3600 * 1000).toISOString();
      await fsSet(`rh_auth_salaries/${publicId}`, {
        pinAttempts: 0,
        pinLockedUntil: null,
        lastLoginAt: new Date(now).toISOString(),
      }, token);
      return res.status(200).json({ success: true, token: sessToken, expiresAt });
    }

    // 5. Mismatch : incrementer + potentiellement lock
    const currentAttempts = parseInt(authData.pinAttempts) || 0;
    const newAttempts = currentAttempts + 1;
    const newLockUntil = computeLockUntil(newAttempts);

    const update = { pinAttempts: newAttempts };
    if (newLockUntil) update.pinLockedUntil = newLockUntil;
    await fsSet(`rh_auth_salaries/${publicId}`, update, token);

    return res.status(200).json({
      success: false,
      error: newLockUntil ? 'locked' : 'wrong_pin',
      attemptsRemaining: newLockUntil ? 0 : getAttemptsRemaining(newAttempts),
      lockedUntil: newLockUntil,
    });

  } catch (e) {
    console.error('[salarie-verify-pin]', e);
    return res.status(500).json({ success: false, error: 'server_error', detail: String(e.message || e) });
  }
};
