// api/salarie-set-pin.js
// Definit ou change le PIN d'un salarie.
//
// DEUX MODES :
// 1. mode='manager' : le manager definit/reset le PIN d'un salarie
//    Input : { publicId, newPin, mode: 'manager', idToken }
//    - Verifie idToken via accounts:lookup (REST)
//    - Ownership : manager uid == rh_employes_public.uid
//
// 2. mode='self' : le salarie change son propre PIN
//    Input : { publicId, newPin, mode: 'self', currentPin }
//    - Anti-bruteforce sur currentPin
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
  if (!email || !password) { console.error('[set-pin] FIREBASE_API_EMAIL/PASSWORD manquants'); return null; }
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
  console.error('[set-pin] Admin login failed:', data.error && data.error.message);
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

// Verifie un idToken client Firebase (manager) via REST Identity Toolkit
async function verifyClientIdToken(idToken) {
  const r = await fetch(`${IDT_BASE}/accounts:lookup?key=${FB_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  if (!r.ok) return null;
  const data = await r.json();
  const user = data.users && data.users[0];
  if (!user) return null;
  return { uid: user.localId, email: user.email || null };
}

// ── Crypto ──
function hashPin(publicId, pin) {
  const secret = process.env.PIN_SERVER_SECRET || '';
  if (secret.length < 16) throw new Error('PIN_SERVER_SECRET manquant ou trop court');
  return crypto.createHash('sha256').update(secret + ':' + publicId + ':' + pin).digest('hex');
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { publicId, newPin, mode } = req.body || {};

    if (!publicId || typeof publicId !== 'string' || publicId.length < 6) {
      return res.status(400).json({ success: false, error: 'invalid_input' });
    }
    if (!newPin || typeof newPin !== 'string' || !/^[0-9]{4}$/.test(newPin)) {
      return res.status(400).json({ success: false, error: 'invalid_pin_format' });
    }
    if (mode !== 'manager' && mode !== 'self') {
      return res.status(400).json({ success: false, error: 'invalid_mode' });
    }
    if (!process.env.PIN_SERVER_SECRET || process.env.PIN_SERVER_SECRET.length < 16) {
      console.error('[set-pin] PIN_SERVER_SECRET manquant ou trop court');
      return res.status(500).json({ success: false, error: 'server_config' });
    }

    const adminToken = await getAdminToken();
    if (!adminToken) return res.status(500).json({ success: false, error: 'admin_auth_failed' });

    const pub = await fsGet(`rh_employes_public/${publicId}`, adminToken);
    if (!pub.exists) {
      return res.status(200).json({ success: false, error: 'invalid_credentials' });
    }
    const ownerUid = (pub.data || {}).uid;

    // ═══════════════════════════════════════
    // MODE MANAGER
    // ═══════════════════════════════════════
    if (mode === 'manager') {
      const { idToken } = req.body || {};
      if (!idToken || typeof idToken !== 'string') {
        return res.status(401).json({ success: false, error: 'auth_required' });
      }
      const verified = await verifyClientIdToken(idToken);
      if (!verified || !verified.uid) {
        return res.status(401).json({ success: false, error: 'invalid_token' });
      }
      if (verified.uid !== ownerUid) {
        return res.status(403).json({ success: false, error: 'not_owner' });
      }

      const hash = hashPin(publicId, newPin);
      const nowIso = new Date().toISOString();
      await fsSet(`rh_auth_salaries/${publicId}`, {
        pinHash: hash,
        pinCreatedAt: nowIso,
        pinLastReset: nowIso,
        pinAttempts: 0,
        pinLockedUntil: null,
        pinLength: 4,
        grandfathered: false,
        tempResetCode: null,
        tempResetExpiresAt: null,
        setBy: 'manager',
        setByUid: verified.uid,
      }, adminToken);

      return res.status(200).json({ success: true });
    }

    // ═══════════════════════════════════════
    // MODE SELF
    // ═══════════════════════════════════════
    if (mode === 'self') {
      const { currentPin } = req.body || {};
      if (!currentPin || typeof currentPin !== 'string' || !/^[0-9]{4}$/.test(currentPin)) {
        return res.status(400).json({ success: false, error: 'invalid_current_pin_format' });
      }

      const auth = await fsGet(`rh_auth_salaries/${publicId}`, adminToken);
      if (!auth.exists) {
        return res.status(200).json({ success: false, error: 'no_pin_set' });
      }
      const authData = auth.data || {};
      if (!authData.pinHash) {
        return res.status(200).json({ success: false, error: 'no_pin_set' });
      }

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

      const candidateHash = hashPin(publicId, currentPin);
      const match = timingSafeEqualStr(candidateHash, authData.pinHash);

      if (!match) {
        const newAttempts = (parseInt(authData.pinAttempts) || 0) + 1;
        const newLockUntil = computeLockUntil(newAttempts);
        const update = { pinAttempts: newAttempts };
        if (newLockUntil) update.pinLockedUntil = newLockUntil;
        await fsSet(`rh_auth_salaries/${publicId}`, update, adminToken);
        return res.status(200).json({
          success: false,
          error: newLockUntil ? 'locked' : 'wrong_current_pin',
          attemptsRemaining: newLockUntil ? 0 : getAttemptsRemaining(newAttempts),
          lockedUntil: newLockUntil,
        });
      }

      // currentPin OK -> enregistrer
      const hash = hashPin(publicId, newPin);
      await fsSet(`rh_auth_salaries/${publicId}`, {
        pinHash: hash,
        pinLastReset: new Date(now).toISOString(),
        pinAttempts: 0,
        pinLockedUntil: null,
        grandfathered: false,
        tempResetCode: null,
        tempResetExpiresAt: null,
        setBy: 'self',
      }, adminToken);

      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ success: false, error: 'invalid_mode' });

  } catch (e) {
    console.error('[salarie-set-pin]', e);
    return res.status(500).json({ success: false, error: 'server_error', detail: String(e.message || e) });
  }
};
