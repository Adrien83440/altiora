// api/salarie-reset-approve.js
// Appele par le manager pour generer un nouveau PIN.
//
// Input:  { publicId, idToken (manager) }
// Output: { success: true, newPin, emailSent } ou { success: false, error }
//
// SECURITE :
// - idToken verifie via accounts:lookup (REST)
// - Ownership check (manager uid == owner uid du salarie)
// - newPin genere avec crypto.randomInt (uniform)
// - PIN renvoye UNE FOIS, non stocke en clair, email au manager en redondance

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
  if (!email || !password) { console.error('[reset-approve] FIREBASE_API_EMAIL/PASSWORD manquants'); return null; }
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
  console.error('[reset-approve] Admin login failed:', data.error && data.error.message);
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

function hashPin(publicId, pin) {
  const secret = process.env.PIN_SERVER_SECRET || '';
  if (secret.length < 16) throw new Error('PIN_SERVER_SECRET manquant ou trop court');
  return crypto.createHash('sha256').update(secret + ':' + publicId + ':' + pin).digest('hex');
}

function genRandomPin() {
  const n = crypto.randomInt(0, 10000);
  return String(n).padStart(4, '0');
}

async function sendEmailToManager(managerEmail, salarieName, newPin) {
  const resendKey = process.env.RESEND_API_KEY;
  const resendFrom = process.env.RESEND_FROM || 'ALTEORE <noreply@alteore.com>';
  if (!resendKey || !managerEmail) return false;

  const subject = 'Nouveau code d\'acces pour ' + (salarieName || 'votre salarie');
  const html = ''
    + '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f9fafb">'
    + '<div style="background:white;border-radius:12px;padding:24px;border:1px solid #e5e7eb">'
    +   '<h2 style="margin:0 0 16px;color:#059669;font-size:20px">🔑 Nouveau code d\'acces genere</h2>'
    +   '<p style="margin:0 0 12px;color:#374151;font-size:14px">Un nouveau code a ete genere pour '
    +     '<b>' + (salarieName || 'votre salarie') + '</b> suite a une demande de reinitialisation.</p>'
    +   '<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:20px;margin:16px 0;text-align:center">'
    +     '<div style="font-size:11px;color:#065f46;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Code PIN temporaire</div>'
    +     '<div style="font-size:36px;font-weight:800;color:#047857;letter-spacing:8px;font-family:monospace">' + newPin + '</div>'
    +   '</div>'
    +   '<p style="margin:16px 0 0;color:#6b7280;font-size:12px;line-height:1.5">'
    +     '<b>A faire :</b> transmettez ce code au salarie (oral, papier, SMS, ...). '
    +     'Il pourra le modifier lui-meme apres sa premiere connexion.'
    +   '</p>'
    +   '<p style="margin:12px 0 0;color:#9ca3af;font-size:11px">'
    +     '⚠️ Ne transferez pas cet email. Pour des raisons de securite, ce code ne sera plus visible apres fermeture.'
    +   '</p>'
    + '</div>'
    + '<div style="text-align:center;color:#9ca3af;font-size:11px;margin-top:16px">ALTEORE &middot; Espace salarie</div>'
    + '</div>';

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: resendFrom, to: managerEmail, subject, html }),
    });
    if (!r.ok) { console.warn('[reset-approve] Resend KO:', r.status, await r.text()); return false; }
    return true;
  } catch (e) {
    console.warn('[reset-approve] Resend error:', e.message);
    return false;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { publicId, idToken } = req.body || {};
    if (!publicId || typeof publicId !== 'string' || publicId.length < 6) {
      return res.status(400).json({ success: false, error: 'invalid_input' });
    }
    if (!idToken || typeof idToken !== 'string') {
      return res.status(401).json({ success: false, error: 'auth_required' });
    }
    if (!process.env.PIN_SERVER_SECRET || process.env.PIN_SERVER_SECRET.length < 16) {
      console.error('[reset-approve] PIN_SERVER_SECRET manquant');
      return res.status(500).json({ success: false, error: 'server_config' });
    }

    const verified = await verifyClientIdToken(idToken);
    if (!verified || !verified.uid) {
      return res.status(401).json({ success: false, error: 'invalid_token' });
    }

    const adminToken = await getAdminToken();
    if (!adminToken) return res.status(500).json({ success: false, error: 'admin_auth_failed' });

    const pub = await fsGet(`rh_employes_public/${publicId}`, adminToken);
    if (!pub.exists) {
      return res.status(404).json({ success: false, error: 'salarie_not_found' });
    }
    const pubData = pub.data || {};
    if (pubData.uid !== verified.uid) {
      return res.status(403).json({ success: false, error: 'not_owner' });
    }

    // Generer nouveau PIN + hash
    const newPin = genRandomPin();
    const hash = hashPin(publicId, newPin);
    const nowIso = new Date().toISOString();

    await fsSet(`rh_auth_salaries/${publicId}`, {
      pinHash: hash,
      pinLastReset: nowIso,
      pinAttempts: 0,
      pinLockedUntil: null,
      pinLength: 4,
      grandfathered: false,
      tempResetCode: null,
      tempResetExpiresAt: null,
      tempResetRequestedAt: null,
      setBy: 'manager_reset',
      setByUid: verified.uid,
    }, adminToken);

    // Email au manager
    const salarieName = [pubData.prenom, pubData.nom].filter(Boolean).join(' ').trim() || null;
    const emailSent = await sendEmailToManager(verified.email, salarieName, newPin);

    return res.status(200).json({
      success: true,
      newPin,
      emailSent,
    });

  } catch (e) {
    console.error('[salarie-reset-approve]', e);
    return res.status(500).json({ success: false, error: 'server_error', detail: String(e.message || e) });
  }
};
