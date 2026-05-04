// api/conseil-revoke.js
// ════════════════════════════════════════════════════════════════════
// ALTEORE CONSEIL — Révocation d'un accès conseiller par le client
// POST { conseillerUid }
//
// Appelé depuis profil.html (Vague 2) — section "Accès tiers".
// L'auth est celle du client (Firebase ID token).
//
// Le serveur :
//  - Vérifie le grant existe et appartient bien au client
//  - Marque le grant comme status='revoked'
//  - Supprime l'index inverse (le client disparaît du dashboard conseiller)
//  - Envoie un email de notification au conseiller
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

async function fsDelete(path, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + token }
  });
  // 200 OK ou 404 (déjà supprimé) → OK
  return res.ok || res.status === 404;
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

async function notifyRevocation(conseillerEmail, clientName) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM    = process.env.RESEND_FROM || 'ALTEORE <noreply@alteore.com>';
  if (!RESEND_API_KEY || !conseillerEmail) return;

  const html = `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111827;">
      <div style="background:#1f2937;color:#fff;padding:24px;border-radius:12px 12px 0 0;">
        <h1 style="margin:0;font-size:20px;font-weight:600;">Accès révoqué</h1>
        <p style="margin:8px 0 0;color:#d1d5db;font-size:14px;">Alteore Conseil</p>
      </div>
      <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 12px 12px;">
        <p>Bonjour,</p>
        <p>L'accès à <strong>${clientName || 'un compte client'}</strong> vous a été révoqué.</p>
        <p>Ce client n'apparaîtra plus dans votre dashboard. Si vous pensez qu'il s'agit d'une erreur, contactez directement le client.</p>
      </div>
    </div>
  `;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + RESEND_API_KEY
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: conseillerEmail,
        subject: `Accès révoqué — ${clientName || 'compte client'}`,
        html: html
      })
    });
  } catch (e) {
    console.warn('[conseil-revoke] email warn:', e.message);
  }
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

    const { conseillerUid } = req.body || {};
    if (!conseillerUid) return res.status(400).json({ error: 'conseillerUid manquant' });

    const adminToken = await getAdminToken();
    if (!adminToken) return res.status(500).json({ error: 'Config serveur manquante' });

    // Vérifier que le grant existe (et appartient bien au client)
    const grantDoc = await fsGet(`client_access/${auth.uid}/grants/${conseillerUid}`, adminToken);
    if (!grantDoc) return res.status(404).json({ error: 'Aucun accès trouvé' });

    const conseillerEmail = fv(grantDoc, 'conseillerEmail') || '';

    // Récupérer le nom du client pour l'email
    const userDoc = await fsGet(`users/${auth.uid}`, adminToken);
    const clientName = userDoc ? (fv(userDoc, 'name') || fv(userDoc, 'prenom') || 'le compte') : 'le compte';

    // 1. Marquer le grant comme révoqué (les rules Firestore vont rejeter
    //    immédiatement les futurs accès car status !== 'active')
    await fsPatch(`client_access/${auth.uid}/grants/${conseillerUid}`, {
      status: 'revoked',
      revokedAt: new Date().toISOString()
    }, adminToken);

    // 2. Supprimer l'index inverse (le client disparaît du dashboard conseiller)
    await fsDelete(`conseillers/${conseillerUid}/clients/${auth.uid}`, adminToken);

    // 3. Email au conseiller (best-effort, non bloquant)
    notifyRevocation(conseillerEmail, clientName).catch(function(e) {
      console.warn('[conseil-revoke] email warn:', e.message);
    });

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[conseil-revoke]', err);
    return res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
};
