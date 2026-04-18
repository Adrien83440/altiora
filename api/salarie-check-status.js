// api/salarie-check-status.js
// Verifie le statut d'authentification PIN d'un salarie SANS reveler de donnees sensibles.
// Appele par espace-salarie.html au chargement, AVANT d'afficher la modale login.
//
// Input:  { publicId: string }
// Output: { exists, hasPin, grandfathered, locked, lockedUntil, attemptsRemaining, resetPending }
//
// SECURITE : ne renvoie JAMAIS le hash du PIN, l'email, ni les dates precises.
// Pattern : REST API avec compte admin api@altiora.app (pas firebase-admin SDK,
// bloque par IAM policy sur ce projet Google Cloud).

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
  if (!email || !password) { console.error('[check-status] FIREBASE_API_EMAIL/PASSWORD manquants'); return null; }
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
  console.error('[check-status] Admin login failed:', data.error && data.error.message);
  return null;
}

function authHeaders(token) {
  return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
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
    else if (v.timestampValue !== undefined) out[k] = v.timestampValue;
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
    const { publicId } = req.body || {};
    if (!publicId || typeof publicId !== 'string' || publicId.length < 6) {
      return res.status(400).json({ error: 'publicId manquant ou invalide' });
    }

    const token = await getAdminToken();
    if (!token) return res.status(500).json({ error: 'admin_auth_failed' });

    // 1. Salarie existe ?
    const pub = await fsGet(`rh_employes_public/${publicId}`, token);
    if (!pub.exists) {
      return res.status(200).json({
        exists: false, hasPin: false, grandfathered: false,
        locked: false, lockedUntil: null,
        attemptsRemaining: 0, resetPending: false,
      });
    }

    // 2. Etat auth
    const auth = await fsGet(`rh_auth_salaries/${publicId}`, token);

    if (!auth.exists) {
      return res.status(200).json({
        exists: true, hasPin: false, grandfathered: true,
        locked: false, lockedUntil: null,
        attemptsRemaining: 5, resetPending: false,
      });
    }

    const authData = auth.data || {};
    const hasPin = !!(authData.pinHash && String(authData.pinHash).length > 0);

    if (!hasPin) {
      return res.status(200).json({
        exists: true, hasPin: false, grandfathered: true,
        locked: false, lockedUntil: null,
        attemptsRemaining: 5, resetPending: !!authData.tempResetCode,
      });
    }

    const now = Date.now();
    let locked = false;
    let lockedUntil = null;
    if (authData.pinLockedUntil) {
      const lockTs = new Date(authData.pinLockedUntil).getTime();
      if (!isNaN(lockTs) && lockTs > now) {
        locked = true;
        lockedUntil = authData.pinLockedUntil;
      }
    }

    return res.status(200).json({
      exists: true, hasPin: true, grandfathered: false,
      locked, lockedUntil,
      attemptsRemaining: locked ? 0 : getAttemptsRemaining(authData.pinAttempts),
      resetPending: !!(authData.tempResetCode && authData.tempResetExpiresAt &&
                       new Date(authData.tempResetExpiresAt).getTime() > now),
    });

  } catch (e) {
    console.error('[salarie-check-status]', e);
    return res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
  }
};
