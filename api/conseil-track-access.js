// api/conseil-track-access.js
// ════════════════════════════════════════════════════════════════════
// ALTEORE CONSEIL — Tracking d'accès du conseiller
// POST { clientUid, page }
//
// Appelé silencieusement par conseil-bootstrap.js à chaque consultation
// d'une page financière en mode viewAs.
//
// Met à jour :
//  - lastAccessAt  → maintenant
//  - accessCount   → +1
//  - firstAccessAt → maintenant (si null) → déclenche email "1ère connexion"
//
// L'email "première connexion" n'est envoyé qu'UNE seule fois (basé sur
// firstAccessAt qui n'est setté qu'une fois).
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

async function sendFirstAccessNotif(clientEmail, clientName, conseillerName) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM    = process.env.RESEND_FROM || 'ALTEORE <noreply@alteore.com>';
  if (!RESEND_API_KEY || !clientEmail) return;

  const html = `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111827;">
      <div style="background:#1f2937;color:#fff;padding:24px;border-radius:12px 12px 0 0;">
        <h1 style="margin:0;font-size:22px;font-weight:600;">Première connexion</h1>
        <p style="margin:8px 0 0;color:#d1d5db;font-size:14px;">Alteore Conseil</p>
      </div>
      <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 12px 12px;">
        <p>Bonjour ${clientName || ''},</p>
        <p><strong>${conseillerName || 'Votre conseiller'}</strong> vient de se connecter à votre compte Alteore pour la première fois.</p>
        <p style="background:#f9fafb;padding:14px;border-radius:8px;border-left:3px solid #fb923c;">
          Cet accès est en <strong>lecture seule</strong>. Le conseiller peut consulter votre pilotage, vos marges, votre cashflow et vos bilans, mais ne peut rien modifier.
        </p>
        <p style="color:#6b7280;font-size:13px;">Cet email vous est envoyé une seule fois lors de la première connexion. Vous ne recevrez pas de notification pour les visites suivantes.</p>
        <p style="text-align:center;margin:24px 0;">
          <a href="https://alteore.com/profil.html" style="background:#1f2937;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:500;">Gérer les accès tiers</a>
        </p>
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
        to: clientEmail,
        subject: `${conseillerName || 'Votre conseiller'} a consulté votre compte pour la 1ère fois`,
        html: html
      })
    });
  } catch (e) {
    console.error('[conseil-track-access] email error:', e.message);
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

    const { clientUid } = req.body || {};
    if (!clientUid) return res.status(400).json({ error: 'clientUid manquant' });

    const adminToken = await getAdminToken();
    if (!adminToken) return res.status(500).json({ error: 'Config serveur manquante' });

    // Vérifier que le grant existe et est actif
    const grantDoc = await fsGet(`client_access/${clientUid}/grants/${auth.uid}`, adminToken);
    if (!grantDoc) return res.status(403).json({ error: 'Aucun accès à ce client' });

    const status = fv(grantDoc, 'status');
    if (status !== 'active') return res.status(403).json({ error: 'Accès non actif' });

    // Vérifier expiration
    const expIso = fv(grantDoc, 'expiresAt');
    if (expIso) {
      const expDate = new Date(expIso);
      if (!isNaN(expDate.getTime()) && expDate < new Date()) {
        // Marquer comme expiré
        try {
          await fsPatch(`client_access/${clientUid}/grants/${auth.uid}`, {
            status: 'expired'
          }, adminToken);
        } catch (e) {}
        return res.status(403).json({ error: 'Accès expiré' });
      }
    }

    const firstAccessAt = fv(grantDoc, 'firstAccessAt');
    const accessCount = parseInt(fv(grantDoc, 'accessCount') || '0') || 0;
    const isFirstAccess = !firstAccessAt;
    const nowIso = new Date().toISOString();

    const updates = {
      lastAccessAt: nowIso,
      accessCount: accessCount + 1
    };
    if (isFirstAccess) {
      updates.firstAccessAt = nowIso;
    }

    await fsPatch(`client_access/${clientUid}/grants/${auth.uid}`, updates, adminToken);

    // Mettre à jour aussi l'index inverse (lastAccessAt)
    try {
      await fsPatch(`conseillers/${auth.uid}/clients/${clientUid}`, {
        lastAccessAt: nowIso
      }, adminToken);
    } catch (e) {}

    // Si première connexion → email au client
    if (isFirstAccess) {
      try {
        const userDoc = await fsGet(`users/${clientUid}`, adminToken);
        const clientEmail = userDoc ? fv(userDoc, 'email') : null;
        const clientName = userDoc ? (fv(userDoc, 'name') || fv(userDoc, 'prenom') || '') : '';
        const conseillerName = fv(grantDoc, 'conseillerName') || 'Votre conseiller';

        // Best-effort, non bloquant
        sendFirstAccessNotif(clientEmail, clientName, conseillerName)
          .catch(function(e) { console.warn('[conseil-track-access] email warn:', e.message); });
      } catch (e) {}
    }

    return res.status(200).json({ ok: true, isFirstAccess: isFirstAccess });

  } catch (err) {
    console.error('[conseil-track-access]', err);
    return res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
};
