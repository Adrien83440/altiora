// api/send-briefing.js
// ══════════════════════════════════════════════════════════════════
// WAVE 4.2 — Livraison du briefing matinal par email (Resend)
//
// Lit un briefing depuis agent/{uid}/briefings/{YYYY-MM-DD}
// Envoie l'email HTML via Resend
// Met à jour le flag delivered_email dans Firestore
//
// Modes d'appel :
//   - Authentifié user : Authorization Bearer → envoie SON briefing du jour
//   - Cron/admin : x-cron-secret + body {uid, date} → envoie celui demandé
//
// Champs lus sur l'user :
//   - users/{uid}.email (requis)
//   - users/{uid}.name (pour salutation)
//   - agent/{uid}/profile/main.channels.email (true par défaut si absent)
// ══════════════════════════════════════════════════════════════════

const FIREBASE_PROJECT = 'altiora-70599';
const FB_KEY = 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

// ══════════════════════════════════════════════════════════════════
// FIREBASE HELPERS
// ══════════════════════════════════════════════════════════════════

let _adminToken = null;
let _adminTokenExp = 0;

async function getAdminToken() {
  if (_adminToken && Date.now() < _adminTokenExp - 300000) return _adminToken;
  const fbKey = process.env.FIREBASE_API_KEY || FB_KEY;
  const email = process.env.FIREBASE_API_EMAIL;
  const password = process.env.FIREBASE_API_PASSWORD;
  if (!email || !password) {
    console.error('[send-briefing] Credentials admin manquants');
    return null;
  }
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${fbKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) }
  );
  const data = await r.json();
  if (data.idToken) {
    _adminToken = data.idToken;
    _adminTokenExp = Date.now() + (parseInt(data.expiresIn || '3600') * 1000);
    return _adminToken;
  }
  console.error('[send-briefing] Admin login failed:', data.error?.message);
  return null;
}

function authHeaders(token) {
  return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
}

async function fsGet(path, token) {
  const res = await fetch(`${FS_BASE}/${path}`, { headers: authHeaders(token) });
  if (!res.ok) return null;
  return res.json();
}

async function fsPatch(path, data, token) {
  const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const fields = {};
  for (const [k, v] of Object.entries(data)) fields[k] = toFsValue(v);
  const res = await fetch(
    `${FS_BASE}/${path}?${mask}`,
    { method: 'PATCH', headers: authHeaders(token), body: JSON.stringify({ fields }) }
  );
  if (!res.ok) throw new Error('fsPatch failed: ' + (await res.text()).slice(0, 200));
  return res.json();
}

function toFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) fields[k] = toFsValue(val);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function docToObject(doc) {
  if (!doc || !doc.fields) return {};
  const obj = {};
  for (const [k, v] of Object.entries(doc.fields)) obj[k] = fromFsValue(v);
  return obj;
}

function fromFsValue(v) {
  if (!v) return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ('mapValue' in v) {
    const obj = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) obj[k] = fromFsValue(val);
    return obj;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════
// TEMPLATE EMAIL HTML
// ══════════════════════════════════════════════════════════════════

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function scoreColor(score) {
  if (score >= 75) return '#10b981'; // vert
  if (score >= 50) return '#f59e0b'; // orange
  if (score >= 30) return '#ef4444'; // rouge
  return '#dc2626'; // rouge foncé
}

function scoreLabel(score) {
  if (score >= 85) return 'Excellente forme';
  if (score >= 70) return 'Bonne santé';
  if (score >= 50) return 'Attention';
  if (score >= 30) return 'À surveiller';
  return 'Critique';
}

function alertStyle(niveau) {
  if (niveau === 'critique') return { bg: '#fee2e2', border: '#fca5a5', color: '#991b1b', icon: '🚨' };
  if (niveau === 'alerte')   return { bg: '#fef3c7', border: '#fcd34d', color: '#92400e', icon: '⚠️' };
  return { bg: '#dbeafe', border: '#93c5fd', color: '#1e40af', icon: 'ℹ️' };
}

function formatDateFr(dateIso) {
  const d = new Date(dateIso + 'T12:00:00');
  const jours = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  const mois = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  return `${jours[d.getDay()]} ${d.getDate()} ${mois[d.getMonth()]} ${d.getFullYear()}`;
}

function renderBriefingHtml(briefingDoc, prenom) {
  const b = briefingDoc.briefing || {};
  const score = briefingDoc.score_sante || 0;
  const alerts = briefingDoc.alertes || [];
  const dateFr = formatDateFr(briefingDoc.date);

  const scoreC = scoreColor(score);
  const scoreL = scoreLabel(score);

  // Salutation (avec fallback)
  const salutation = b.salutation || `Bonjour ${prenom || ''}, voici ton briefing du jour.`;
  const resumeVeille = b.resume_veille || '';
  const pointsCles = b.points_cles || [];
  const actions = b.actions_du_jour || [];
  const conclusion = b.conclusion || '';

  // ── Alertes HTML ──
  let alertsHtml = '';
  if (alerts.length > 0) {
    alertsHtml = `
<div style="margin:24px 0;">
  <div style="font-size:13px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:10px;">Alertes</div>
  ${alerts.map(a => {
    const s = alertStyle(a.niveau);
    return `<div style="background:${s.bg};border:1px solid ${s.border};border-radius:10px;padding:12px 14px;color:${s.color};margin-bottom:8px;font-size:14px;line-height:1.5;">
      <span style="margin-right:6px;">${s.icon}</span>${esc(a.message)}
    </div>`;
  }).join('')}
</div>`;
  }

  // ── Points clés HTML ──
  let pointsHtml = '';
  if (pointsCles.length > 0) {
    pointsHtml = `
<div style="margin:24px 0;">
  <div style="font-size:13px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:10px;">Points clés</div>
  <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:6px;">
    ${pointsCles.map((p, i) => {
      if (i % 2 === 0) {
        const next = pointsCles[i + 1];
        return `<tr>
          <td style="width:50%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:14px;vertical-align:top;">
            <div style="font-size:20px;margin-bottom:4px;">${esc(p.emoji || '📊')}</div>
            <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">${esc(p.label || '')}</div>
            <div style="font-size:18px;font-weight:800;color:#111827;margin-top:3px;">${esc(p.valeur || '')}</div>
            ${p.tendance ? `<div style="font-size:12px;color:#6b7280;margin-top:4px;">${esc(p.tendance)}</div>` : ''}
          </td>
          ${next ? `<td style="width:50%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:14px;vertical-align:top;">
            <div style="font-size:20px;margin-bottom:4px;">${esc(next.emoji || '📊')}</div>
            <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">${esc(next.label || '')}</div>
            <div style="font-size:18px;font-weight:800;color:#111827;margin-top:3px;">${esc(next.valeur || '')}</div>
            ${next.tendance ? `<div style="font-size:12px;color:#6b7280;margin-top:4px;">${esc(next.tendance)}</div>` : ''}
          </td>` : '<td style="width:50%;"></td>'}
        </tr>`;
      }
      return '';
    }).join('')}
  </table>
</div>`;
  }

  // ── Actions HTML ──
  let actionsHtml = '';
  if (actions.length > 0) {
    actionsHtml = `
<div style="margin:24px 0;">
  <div style="font-size:13px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:10px;">Actions du jour</div>
  ${actions.map(a => `
    <div style="display:flex;gap:12px;background:#f3f4f6;border-radius:10px;padding:14px;margin-bottom:8px;">
      <div style="font-size:22px;line-height:1;">${esc(a.emoji || '✅')}</div>
      <div style="flex:1;">
        <div style="font-size:15px;font-weight:700;color:#111827;">${esc(a.titre || '')}</div>
        ${a.detail ? `<div style="font-size:13px;color:#6b7280;margin-top:3px;line-height:1.5;">${esc(a.detail)}</div>` : ''}
      </div>
    </div>
  `).join('')}
</div>`;
  }

  // ── HTML complet ──
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Briefing Léa — ${esc(dateFr)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">

<table cellpadding="0" cellspacing="0" style="width:100%;background:#f3f4f6;padding:24px 0;">
  <tr>
    <td align="center">
      <table cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">

        <!-- Header avec score -->
        <tr>
          <td style="background:linear-gradient(135deg,#7c3aed 0%,#5b21b6 100%);padding:28px 28px 22px;color:#fff;">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
              <span style="font-size:22px;">👩‍💼</span>
              <span style="font-size:14px;font-weight:700;letter-spacing:0.3px;opacity:0.9;">BRIEFING LÉA</span>
            </div>
            <div style="font-size:15px;opacity:0.85;margin-bottom:18px;">${esc(dateFr)}</div>
            <div style="display:flex;align-items:center;gap:16px;">
              <div style="background:${scoreC};color:#fff;width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;flex-shrink:0;">${score}</div>
              <div>
                <div style="font-size:13px;opacity:0.75;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Score santé</div>
                <div style="font-size:18px;font-weight:700;margin-top:2px;">${scoreL}</div>
              </div>
            </div>
          </td>
        </tr>

        <!-- Corps -->
        <tr>
          <td style="padding:24px 28px;">

            <!-- Salutation -->
            <div style="font-size:16px;color:#111827;line-height:1.6;margin-bottom:14px;">
              ${esc(salutation)}
            </div>

            ${resumeVeille ? `<div style="font-size:14px;color:#4b5563;line-height:1.6;">${esc(resumeVeille)}</div>` : ''}

            ${alertsHtml}
            ${pointsHtml}
            ${actionsHtml}

            ${conclusion ? `<div style="margin-top:24px;padding:14px 16px;background:#ede9fe;border-left:3px solid #7c3aed;border-radius:6px;font-size:14px;color:#4c1d95;line-height:1.6;font-style:italic;">${esc(conclusion)}</div>` : ''}

            <!-- CTA -->
            <div style="margin-top:28px;text-align:center;">
              <a href="https://alteore.com/lea" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;padding:14px 32px;border-radius:99px;font-weight:700;font-size:14px;">💬 Ouvrir Léa</a>
            </div>

          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:16px 28px 24px;border-top:1px solid #f3f4f6;">
            <div style="font-size:11px;color:#9ca3af;line-height:1.6;text-align:center;">
              Tu reçois ce briefing parce que ton addon Léa est actif.<br>
              Pour arrêter les briefings matinaux, va dans <a href="https://alteore.com/lea" style="color:#7c3aed;text-decoration:none;">les réglages Léa</a>.
            </div>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>

</body>
</html>`;
}

// ══════════════════════════════════════════════════════════════════
// ENVOI EMAIL via RESEND
// ══════════════════════════════════════════════════════════════════

async function sendEmailViaResend(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY manquante');
  const from = process.env.RESEND_FROM || 'ALTEORE <noreply@alteore.com>';

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html,
      // Reply-to optionnel pour que les users puissent répondre à Léa
      reply_to: 'lea@alteore.com',
    }),
  });

  const data = await r.json();
  if (r.ok) {
    console.log(`[send-briefing] ✅ Email envoyé à ${to}, id=${data.id}`);
    return { ok: true, id: data.id };
  } else {
    console.error('[send-briefing] Resend error:', data);
    throw new Error('Resend: ' + (data.message || JSON.stringify(data).slice(0, 200)));
  }
}

// ══════════════════════════════════════════════════════════════════
// ORCHESTRATION
// ══════════════════════════════════════════════════════════════════

async function sendForUser(uid, dateKey, adminToken, opts) {
  // 1. Récupérer le user
  const userDoc = await fsGet(`users/${uid}`, adminToken);
  if (!userDoc) throw new Error('User introuvable');
  const user = docToObject(userDoc);
  if (!user.email) throw new Error('Pas d\'email sur ce user');

  const prenom = (user.name || user.firstName || '').split(' ')[0] || '';

  // 2. Récupérer les préférences channels (email par défaut ON)
  let emailEnabled = true;
  try {
    const profileDoc = await fsGet(`agent/${uid}/profile/main`, adminToken);
    if (profileDoc) {
      const p = docToObject(profileDoc);
      if (p.channels && p.channels.email === false) emailEnabled = false;
    }
  } catch (e) { /* fallback défaut ON */ }

  if (!emailEnabled && !opts?.force) {
    return { skipped: true, reason: 'email_disabled', email: user.email };
  }

  // 3. Récupérer le briefing du jour
  const briefingDoc = await fsGet(`agent/${uid}/briefings/${dateKey}`, adminToken);
  if (!briefingDoc) throw new Error(`Briefing introuvable pour ${dateKey}`);
  const briefing = docToObject(briefingDoc);

  // 4. Ne pas renvoyer si déjà envoyé (sauf force)
  if (briefing.delivered_email && !opts?.force) {
    return { skipped: true, reason: 'already_sent', email: user.email };
  }

  // 5. Construire et envoyer
  const html = renderBriefingHtml(briefing, prenom);
  const dateFr = formatDateFr(briefing.date);
  const score = briefing.score_sante || 0;
  const subject = `🌅 Briefing du ${dateFr} — Score ${score}/100`;

  const result = await sendEmailViaResend(user.email, subject, html);

  // 6. Marquer comme envoyé dans Firestore
  await fsPatch(`agent/${uid}/briefings/${dateKey}`, {
    delivered_email: true,
    delivered_email_at: new Date().toISOString(),
    delivered_email_id: result.id || null,
  }, adminToken);

  return { ok: true, email: user.email, resend_id: result.id };
}

// ══════════════════════════════════════════════════════════════════
// HANDLER HTTP
// ══════════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  if (['https://alteore.com', 'https://www.alteore.com', 'http://localhost:3000'].includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-cron-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const cronSecret = req.headers['x-cron-secret'];
    const isCron = cronSecret && cronSecret === process.env.CRON_SECRET;
    const body = req.body || {};

    let uid = null;
    let dateKey = body.date || null;
    const force = body.force === true;

    if (isCron) {
      uid = body.uid;
      if (!uid) return res.status(400).json({ error: 'uid requis' });
    } else {
      // Auth user standard
      const authHeader = req.headers.authorization || '';
      const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (!idToken) return res.status(401).json({ error: 'Non authentifié' });

      const fbKey = process.env.FIREBASE_API_KEY || FB_KEY;
      const verifyRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${fbKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
      );
      if (!verifyRes.ok) return res.status(401).json({ error: 'Token invalide' });
      const verifyData = await verifyRes.json();
      const u = verifyData.users?.[0];
      if (!u?.localId) return res.status(401).json({ error: 'Utilisateur introuvable' });
      uid = u.localId;
    }

    // Défaut = date du jour
    if (!dateKey) {
      const now = new Date();
      dateKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    }

    const adminToken = await getAdminToken();
    if (!adminToken) return res.status(500).json({ error: 'Admin token indisponible' });

    const result = await sendForUser(uid, dateKey, adminToken, { force });

    if (result.skipped) {
      return res.status(200).json({ ok: true, skipped: true, reason: result.reason, email: result.email });
    }
    return res.status(200).json({ ok: true, email: result.email, resend_id: result.resend_id });
  } catch (e) {
    console.error('[send-briefing] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
