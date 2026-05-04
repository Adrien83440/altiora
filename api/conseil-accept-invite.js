// api/conseil-accept-invite.js
// ════════════════════════════════════════════════════════════════════
// ALTEORE CONSEIL — Acceptation d'une invitation conseiller
// POST { token, conseillerUid, displayName?, cabinet?, type? }
//
// Appelé depuis conseil/accept-invite.html après que le conseiller ait :
//  1. Cliqué sur le lien d'invitation (?token=...)
//  2. Créé son compte Firebase Auth (signup côté client)
//  3. Soumis le formulaire de profil
//
// Le serveur :
//  - Valide l'invitation (status=pending, pas expirée, email correspond)
//  - Crée conseillers/{uid} (profil)
//  - Crée client_access/{clientUid}/grants/{conseillerUid} (permission)
//  - Crée conseillers/{conseillerUid}/clients/{clientUid} (index inverse)
//  - Marque l'invitation comme accepted
//  - Envoie un email de notification au client
// ════════════════════════════════════════════════════════════════════

const FIREBASE_PROJECT = 'altiora-70599';

// CORS dynamique : autorise alteore.com ET conseil.alteore.com
function setCors(req, res) {
  var origin = req.headers.origin || '';
  var allowedOrigins = [
    'https://alteore.com',
    'https://www.alteore.com',
    'https://conseil.alteore.com',
    'http://localhost:3000'
  ];
  if (allowedOrigins.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  }
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
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
  const res = await fetch(url + (token ? '' : '?key=' + fbKey), { headers });
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
  } catch (e) {
    return null;
  }
}

function computeExpiresAt(duration) {
  if (duration === 'permanent') return null;
  const now = new Date();
  if (duration === '7d')  return new Date(now.getTime() + 7 * 86400000);
  if (duration === '30d') return new Date(now.getTime() + 30 * 86400000);
  if (duration === '90d') return new Date(now.getTime() + 90 * 86400000);
  // Fallback : 30 jours
  return new Date(now.getTime() + 30 * 86400000);
}

async function sendNewConseillerNotif(clientEmail, clientName, conseillerName, duration) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM    = process.env.RESEND_FROM || 'ALTEORE <noreply@alteore.com>';
  if (!RESEND_API_KEY || !clientEmail) return;

  const durationLabel = duration === 'permanent' ? 'permanent'
    : duration === '7d'  ? '7 jours'
    : duration === '30d' ? '30 jours'
    : duration === '90d' ? '90 jours'
    : duration;

  const html = `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111827;">
      <div style="background:#1f2937;color:#fff;padding:24px;border-radius:12px 12px 0 0;">
        <h1 style="margin:0;font-size:22px;font-weight:600;">Alteore Conseil</h1>
        <p style="margin:8px 0 0;color:#d1d5db;font-size:14px;">Notification de nouvel accès</p>
      </div>
      <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 12px 12px;">
        <p>Bonjour ${clientName || ''},</p>
        <p><strong>${conseillerName}</strong> a accepté votre invitation et a maintenant accès à la partie financière de votre compte Alteore en <strong>lecture seule</strong>.</p>
        <p style="background:#f9fafb;padding:14px;border-radius:8px;border-left:3px solid #fb923c;">
          <strong>Durée d'accès :</strong> ${durationLabel}<br>
          <strong>Mode :</strong> Lecture seule (aucune modification possible)
        </p>
        <p>Vous pouvez à tout moment révoquer cet accès depuis votre profil :</p>
        <p style="text-align:center;margin:24px 0;">
          <a href="https://alteore.com/profil.html" style="background:#1f2937;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:500;">Gérer les accès tiers</a>
        </p>
        <p style="color:#6b7280;font-size:13px;border-top:1px solid #e5e7eb;padding-top:16px;margin-top:24px;">
          Vous serez notifié uniquement à la première connexion de ce conseiller. Les connexions suivantes ne déclenchent aucune notification.
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
        subject: `${conseillerName} a maintenant accès à votre compte Alteore`,
        html: html
      })
    });
  } catch (e) {
    console.error('[conseil-accept-invite] Email error:', e.message);
  }
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).end();

  try {
    const { token, displayName, cabinet, type } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Token manquant' });

    // Auth : vérifier le Firebase ID token du conseiller fraîchement créé
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!idToken) return res.status(401).json({ error: 'Authentification requise' });
    const conseillerAuth = await verifyToken(idToken);
    if (!conseillerAuth) return res.status(401).json({ error: 'Token invalide' });

    const conseillerUid   = conseillerAuth.uid;
    const conseillerEmail = (conseillerAuth.email || '').toLowerCase();

    const adminToken = await getAdminToken();
    if (!adminToken) return res.status(500).json({ error: 'Config serveur manquante' });

    // 1. Lire l'invitation
    const invDoc = await fsGet(`conseil_invitations/${token}`, adminToken);
    if (!invDoc) return res.status(404).json({ error: 'Invitation introuvable' });

    const invStatus    = fv(invDoc, 'status');
    const invEmail     = (fv(invDoc, 'conseillerEmail') || '').toLowerCase();
    const clientUid    = fv(invDoc, 'clientUid');
    const clientName   = fv(invDoc, 'clientName')  || 'Client';
    const clientEmail  = fv(invDoc, 'clientEmail') || '';
    const duration     = fv(invDoc, 'duration')   || '30d';
    const inviteExp    = fv(invDoc, 'inviteExpiresAt');

    if (invStatus !== 'pending') {
      return res.status(400).json({ error: 'Invitation déjà utilisée ou révoquée' });
    }
    if (inviteExp) {
      const expDate = new Date(inviteExp);
      if (!isNaN(expDate.getTime()) && expDate < new Date()) {
        return res.status(400).json({ error: 'Invitation expirée' });
      }
    }
    if (invEmail && invEmail !== conseillerEmail) {
      return res.status(403).json({ error: 'Cette invitation est pour une autre adresse email' });
    }
    if (!clientUid) {
      return res.status(400).json({ error: 'Invitation invalide (clientUid manquant)' });
    }

    const expiresAt = computeExpiresAt(duration);
    const nowIso    = new Date().toISOString();

    // 2. Créer le profil conseiller
    await fsCreate(`conseillers/${conseillerUid}`, {
      email: conseillerEmail,
      displayName: (displayName || conseillerEmail.split('@')[0] || '').slice(0, 80),
      cabinet: (cabinet || '').slice(0, 120),
      type: ['comptable', 'coach', 'autre'].indexOf(type) !== -1 ? type : 'autre',
      role: 'conseiller',
      createdAt: nowIso,
      lastLogin: nowIso
    }, adminToken);

    // 3. Créer le grant (source de vérité pour les rules Firestore)
    const grantData = {
      conseillerEmail: conseillerEmail,
      conseillerName: (displayName || conseillerEmail.split('@')[0] || '').slice(0, 80),
      grantedAt: nowIso,
      duration: duration,
      status: 'active',
      firstAccessAt: null,
      lastAccessAt: null,
      accessCount: 0
    };
    if (expiresAt) {
      grantData.expiresAt = expiresAt;
    } else {
      grantData.expiresAt = null;
    }
    await fsCreate(`client_access/${clientUid}/grants/${conseillerUid}`, grantData, adminToken);

    // 4. Index inverse pour le dashboard conseiller
    await fsCreate(`conseillers/${conseillerUid}/clients/${clientUid}`, {
      clientName: clientName,
      clientEmail: clientEmail,
      duration: duration,
      expiresAt: expiresAt || null,
      addedAt: nowIso,
      lastAccessAt: null
    }, adminToken);

    // 5. Marquer l'invitation comme acceptée
    await fsPatch(`conseil_invitations/${token}`, {
      status: 'accepted',
      acceptedAt: nowIso,
      conseillerUid: conseillerUid
    }, adminToken);

    // 6. Email au client (best-effort, non bloquant)
    sendNewConseillerNotif(
      clientEmail,
      clientName,
      (displayName || conseillerEmail.split('@')[0] || 'Le conseiller'),
      duration
    ).catch(function(e) { console.warn('[conseil-accept-invite] email warn:', e.message); });

    return res.status(200).json({
      ok: true,
      clientUid: clientUid,
      clientName: clientName,
      duration: duration,
      expiresAt: expiresAt ? expiresAt.toISOString() : null
    });

  } catch (err) {
    console.error('[conseil-accept-invite]', err);
    return res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
};
