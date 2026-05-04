// api/conseil-send-message.js
// ════════════════════════════════════════════════════════════════════
// ALTEORE CONSEIL — Envoi d'un message du conseiller au client
// POST { clientUid, subject, body }
//
// Appelé depuis le bouton "Message" du banner (conseil-bootstrap.js).
// Envoie un email via Resend, avec reply-to = email du conseiller pour
// que le client puisse répondre directement à son comptable/coach hors
// d'Alteore.
//
// Sécurité :
//  - Vérifier le Firebase ID token du conseiller
//  - Vérifier qu'il a un grant actif sur ce client
//  - Aucune donnée stockée (pas de messagerie persistée en V1)
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

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

    const { clientUid, subject, body } = req.body || {};
    if (!clientUid) return res.status(400).json({ error: 'clientUid manquant' });
    if (!subject || typeof subject !== 'string' || !subject.trim()) {
      return res.status(400).json({ error: 'Sujet manquant' });
    }
    if (!body || typeof body !== 'string' || body.trim().length < 5) {
      return res.status(400).json({ error: 'Message trop court' });
    }
    if (subject.length > 200 || body.length > 5000) {
      return res.status(400).json({ error: 'Contenu trop long' });
    }

    const adminToken = await getAdminToken();
    if (!adminToken) return res.status(500).json({ error: 'Config serveur manquante' });

    // Vérifier le grant
    const grantDoc = await fsGet(`client_access/${clientUid}/grants/${auth.uid}`, adminToken);
    if (!grantDoc) return res.status(403).json({ error: 'Aucun accès à ce client' });
    const status = fv(grantDoc, 'status');
    if (status !== 'active') return res.status(403).json({ error: 'Accès non actif' });

    // Vérifier expiration
    const expIso = fv(grantDoc, 'expiresAt');
    if (expIso) {
      const expDate = new Date(expIso);
      if (!isNaN(expDate.getTime()) && expDate < new Date()) {
        return res.status(403).json({ error: 'Accès expiré' });
      }
    }

    // Récupérer email client + nom conseiller
    const userDoc = await fsGet(`users/${clientUid}`, adminToken);
    if (!userDoc) return res.status(404).json({ error: 'Client introuvable' });
    const clientEmail = fv(userDoc, 'email');
    const clientName  = fv(userDoc, 'name') || fv(userDoc, 'prenom') || '';
    if (!clientEmail) return res.status(400).json({ error: 'Email client introuvable' });

    const conseillerName = fv(grantDoc, 'conseillerName') || (auth.email || 'Votre conseiller').split('@')[0];

    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const RESEND_FROM    = process.env.RESEND_FROM || 'ALTEORE <noreply@alteore.com>';
    if (!RESEND_API_KEY) {
      return res.status(500).json({ error: 'Service email indisponible' });
    }

    const safeBody = escapeHtml(body).replace(/\n/g, '<br>');
    const html = `
      <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111827;">
        <div style="background:#1f2937;color:#fff;padding:24px;border-radius:12px 12px 0 0;">
          <h1 style="margin:0;font-size:20px;font-weight:600;">Message d'un conseiller</h1>
          <p style="margin:8px 0 0;color:#d1d5db;font-size:14px;">${escapeHtml(conseillerName)} (${escapeHtml(auth.email || '')})</p>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 12px 12px;">
          <p style="margin-top:0;">Bonjour ${escapeHtml(clientName)},</p>
          <div style="background:#f9fafb;padding:18px;border-radius:8px;border-left:3px solid #fb923c;margin:16px 0;">
            ${safeBody}
          </div>
          <p style="color:#6b7280;font-size:13px;border-top:1px solid #e5e7eb;padding-top:16px;margin-top:24px;">
            Ce message vous a été envoyé via <strong>Alteore Conseil</strong>. Vous pouvez répondre directement à cet email pour communiquer avec ${escapeHtml(conseillerName)}.
          </p>
        </div>
      </div>
    `;

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + RESEND_API_KEY
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: clientEmail,
        reply_to: auth.email,
        subject: `[Alteore Conseil] ${subject.trim().slice(0, 180)}`,
        html: html
      })
    });

    if (!resp.ok) {
      const t = await resp.text().catch(function() { return ''; });
      console.error('[conseil-send-message] Resend error:', t);
      return res.status(500).json({ error: 'Échec de l\'envoi de l\'email' });
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[conseil-send-message]', err);
    return res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
};
