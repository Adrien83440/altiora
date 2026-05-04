// api/conseil-invite.js
// ════════════════════════════════════════════════════════════════════
// ALTEORE CONSEIL — Invitation d'un nouveau conseiller
// POST { conseillerEmail, conseillerName, duration }
//
// Appelé par profil.html (Vague 2) ou directement via curl pour test.
// L'auth est celle du client (Firebase ID token dans Authorization).
//
// Le serveur :
//  - Vérifie que le client est bien sur un plan payant
//  - Génère un token de 32 caractères
//  - Crée conseil_invitations/{token} (status=pending)
//  - Envoie un email d'invitation au conseiller
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

async function fsCreate(path, data, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify({ fields: toFsFields(data) })
  });
  if (!res.ok) throw new Error('Firestore create failed: ' + await res.text());
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

function generateToken() {
  // 32 chars hex (= 128 bits d'entropie)
  const arr = [];
  for (let i = 0; i < 32; i++) {
    arr.push(Math.floor(Math.random() * 16).toString(16));
  }
  return arr.join('');
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

    const body = req.body || {};
    const conseillerEmail = (body.conseillerEmail || '').trim().toLowerCase();
    const conseillerName  = (body.conseillerName  || '').trim();
    const duration        = body.duration || '30d';

    if (!conseillerEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(conseillerEmail)) {
      return res.status(400).json({ error: 'Email invalide' });
    }
    if (!conseillerName) {
      return res.status(400).json({ error: 'Nom du conseiller requis' });
    }
    if (['7d', '30d', '90d', 'permanent'].indexOf(duration) === -1) {
      return res.status(400).json({ error: 'Durée invalide' });
    }

    const adminToken = await getAdminToken();
    if (!adminToken) return res.status(500).json({ error: 'Config serveur manquante' });

    // Vérifier que le client a un plan payant
    const userDoc = await fsGet(`users/${auth.uid}`, adminToken);
    if (!userDoc) return res.status(404).json({ error: 'Compte introuvable' });
    const plan = fv(userDoc, 'plan') || 'free';
    if (['pro', 'max', 'master', 'trial', 'dev'].indexOf(plan) === -1) {
      return res.status(403).json({ error: 'Cette fonctionnalité nécessite un plan payant' });
    }

    const clientName  = fv(userDoc, 'name') || fv(userDoc, 'prenom') || (auth.email || '').split('@')[0];
    const clientEmail = fv(userDoc, 'email') || auth.email || '';

    // Empêcher l'auto-invitation
    if (conseillerEmail === (clientEmail || '').toLowerCase()) {
      return res.status(400).json({ error: 'Vous ne pouvez pas vous inviter vous-même' });
    }

    // Générer le token
    const token = generateToken();
    const nowIso = new Date().toISOString();
    const inviteExpiresAt = new Date(Date.now() + 7 * 86400000); // 7 jours pour accepter

    await fsCreate(`conseil_invitations/${token}`, {
      token: token,
      clientUid: auth.uid,
      clientName: clientName,
      clientEmail: clientEmail,
      conseillerEmail: conseillerEmail,
      conseillerName: conseillerName,
      duration: duration,
      createdAt: nowIso,
      inviteExpiresAt: inviteExpiresAt,
      status: 'pending'
    }, adminToken);

    // Envoyer l'email d'invitation
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const RESEND_FROM    = process.env.RESEND_FROM || 'ALTEORE <noreply@alteore.com>';
    if (RESEND_API_KEY) {
      const inviteUrl = `https://conseil.alteore.com/accept-invite.html?token=${token}`;
      const durationLabel = duration === 'permanent' ? 'Accès permanent'
        : duration === '7d'  ? '7 jours'
        : duration === '30d' ? '30 jours'
        : '90 jours';

      const html = `
        <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111827;">
          <div style="background:#1f2937;color:#fff;padding:28px;border-radius:12px 12px 0 0;text-align:center;">
            <h1 style="margin:0;font-size:24px;font-weight:600;">Alteore Conseil</h1>
            <p style="margin:10px 0 0;color:#fdba74;font-size:14px;">Espace dédié aux comptables et coachs</p>
          </div>
          <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;padding:28px;border-radius:0 0 12px 12px;">
            <p style="font-size:15px;">Bonjour,</p>
            <p style="font-size:15px;"><strong>${escapeHtml(clientName)}</strong> vous invite à accéder à la partie financière de son compte Alteore en lecture seule.</p>
            <div style="background:#f9fafb;padding:16px 18px;border-radius:8px;border-left:3px solid #fb923c;margin:18px 0;">
              <p style="margin:0;"><strong>Périmètre :</strong> Pilotage, marges, dashboard, cashflow, dettes, bilans</p>
              <p style="margin:8px 0 0;"><strong>Durée :</strong> ${durationLabel}</p>
              <p style="margin:8px 0 0;"><strong>Mode :</strong> Lecture seule (aucune modification possible)</p>
            </div>
            <p style="text-align:center;margin:28px 0;">
              <a href="${inviteUrl}" style="background:#1f2937;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:500;display:inline-block;">Accepter l'invitation</a>
            </p>
            <p style="color:#6b7280;font-size:13px;text-align:center;">Ce lien est valable 7 jours.</p>
            <p style="color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb;padding-top:16px;margin-top:24px;">
              Si le bouton ne fonctionne pas, copiez-collez cette URL dans votre navigateur :<br>
              <span style="word-break:break-all;color:#6b7280;">${inviteUrl}</span>
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
            to: conseillerEmail,
            subject: `${clientName} vous invite sur Alteore Conseil`,
            html: html
          })
        });
      } catch (e) {
        console.warn('[conseil-invite] email warn:', e.message);
      }
    }

    return res.status(200).json({
      ok: true,
      token: token,
      conseillerEmail: conseillerEmail,
      duration: duration,
      inviteExpiresAt: inviteExpiresAt.toISOString()
    });

  } catch (err) {
    console.error('[conseil-invite]', err);
    return res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
};
