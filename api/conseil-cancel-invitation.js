// api/conseil-cancel-invitation.js
// ════════════════════════════════════════════════════════════════════
// ALTEORE CONSEIL — Annulation d'une invitation pending
// POST { token }
//
// Appelé depuis profil.html quand le client clique "Annuler" sur une
// invitation envoyée mais pas encore acceptée.
//
// Le serveur :
//  - Vérifie que l'invitation existe, est pending, et appartient bien
//    au client connecté
//  - Marque l'invitation status='revoked' (le lien d'invitation devient
//    invalide à la prochaine tentative d'acceptation)
// ════════════════════════════════════════════════════════════════════

const FIREBASE_PROJECT = 'altiora-70599';

function setCors(req, res) {
  var origin = req.headers.origin || '';
  var allowed = ['https://alteore.com', 'https://www.alteore.com', 'https://conseil.alteore.com', 'http://localhost:3000'];
  res.setHeader('Access-Control-Allow-Origin', allowed.indexOf(origin) !== -1 ? origin : 'https://alteore.com');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function getAdminToken() {
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
  const email = process.env.FIREBASE_API_EMAIL;
  const password = process.env.FIREBASE_API_PASSWORD;
  if (!email || !password) return null;
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${fbKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }
  );
  const data = await r.json();
  return data.idToken || null;
}

async function fsGet(path, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`;
  const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
  if (!res.ok) return null;
  return res.json();
}

function toFsFields(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) out[k] = { nullValue: null };
    else if (typeof v === 'string') out[k] = { stringValue: v };
    else if (typeof v === 'number' && Number.isInteger(v)) out[k] = { integerValue: String(v) };
    else if (typeof v === 'number') out[k] = { doubleValue: v };
    else if (typeof v === 'boolean') out[k] = { booleanValue: v };
    else if (v instanceof Date) out[k] = { timestampValue: v.toISOString() };
    else out[k] = { stringValue: String(v) };
  }
  return out;
}

async function fsPatch(path, data, token) {
  const masks = Object.keys(data).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?${masks}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify({ fields: toFsFields(data) })
  });
  if (!res.ok) throw new Error('Firestore patch failed: ' + await res.text());
  return res.json();
}

function fv(doc, field) {
  const f = doc?.fields?.[field];
  if (!f) return null;
  return f.stringValue ?? f.integerValue ?? f.booleanValue ?? f.timestampValue ?? null;
}

async function verifyToken(idToken) {
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
  try {
    const r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${fbKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      }
    );
    const data = await r.json();
    const u = data.users && data.users[0];
    if (!u) return null;
    return { uid: u.localId, email: u.email };
  } catch (e) { return null; }
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).end();

  try {
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!idToken) return res.status(401).json({ error: 'Auth requise' });
    const auth = await verifyToken(idToken);
    if (!auth) return res.status(401).json({ error: 'Token invalide' });

    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Token manquant' });

    const adminToken = await getAdminToken();
    if (!adminToken) return res.status(500).json({ error: 'Config serveur manquante' });

    // Vérifier que l'invitation existe, est pending, et appartient à ce client
    const invDoc = await fsGet(`conseil_invitations/${token}`, adminToken);
    if (!invDoc) return res.status(404).json({ error: 'Invitation introuvable' });

    const status    = fv(invDoc, 'status');
    const clientUid = fv(invDoc, 'clientUid');

    if (clientUid !== auth.uid) {
      return res.status(403).json({ error: 'Cette invitation ne vous appartient pas' });
    }
    if (status !== 'pending') {
      return res.status(400).json({ error: 'Invitation déjà utilisée ou révoquée' });
    }

    // Marquer comme révoquée
    await fsPatch(`conseil_invitations/${token}`, {
      status: 'revoked',
      revokedAt: new Date().toISOString()
    }, adminToken);

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[conseil-cancel-invitation]', err);
    return res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
};
