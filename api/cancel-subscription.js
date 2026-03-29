// api/cancel-subscription.js
// Résilie l'abonnement Stripe d'un utilisateur et met à jour Firestore
// POST { uid, reason?, detail? }

const FIREBASE_PROJECT = 'altiora-70599';

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
  const res = await fetch(url + (token ? '' : '?key=' + (process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4')), { headers });
  if (!res.ok) return null;
  return res.json();
}

async function fsSet(path, fields, token) {
  const ff = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string')      ff[k] = { stringValue: v };
    else if (typeof v === 'number') ff[k] = { integerValue: String(v) };
    else if (typeof v === 'boolean') ff[k] = { booleanValue: v };
    else if (v === null)            ff[k] = { nullValue: null };
    else                            ff[k] = { stringValue: String(v) };
  }
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?${mask}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ fields: ff }) });
  if (!res.ok) throw new Error('Firestore PATCH failed: ' + await res.text());
  return res.json();
}

function fv(doc, field) {
  const f = doc?.fields?.[field];
  return f?.stringValue ?? f?.integerValue ?? f?.booleanValue ?? null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: 'Config serveur manquante' });

  // ── AUTH : vérifier le token Firebase ──
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  let uid = null;
  if (idToken) {
    // Vérifier le token et récupérer l'uid
    const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
    try {
      const verifyRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${fbKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
      );
      const verifyData = await verifyRes.json();
      uid = verifyData.users?.[0]?.localId || null;
    } catch(e) {}
  }

  // Fallback : uid du body (rétrocompatibilité)
  if (!uid) uid = (req.body || {}).uid;
  if (!uid) return res.status(401).json({ error: 'Authentification requise' });

  const { reason, detail } = req.body || {};

  try {
    const adminToken = await getAdminToken();

    // 1. Lire les infos utilisateur
    const userDoc = await fsGet(`users/${uid}`, adminToken);
    if (!userDoc) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const subscriptionId = fv(userDoc, 'stripeSubscriptionId');
    const customerId = fv(userDoc, 'stripeCustomerId');
    const currentPlan = fv(userDoc, 'plan');

    // 2. Annuler l'abonnement Stripe si présent
    if (subscriptionId) {
      const cancelRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + stripeKey }
      });
      const cancelled = await cancelRes.json();
      if (cancelled.error) {
        console.error('[cancel-subscription] Stripe error:', cancelled.error);
        // Ne pas bloquer si l'abonnement est déjà annulé
        if (cancelled.error.code !== 'resource_missing') {
          return res.status(500).json({ error: 'Erreur Stripe: ' + cancelled.error.message });
        }
      }
      console.log(`[cancel-subscription] Abonnement ${subscriptionId} annulé`);
    }

    // 3. Mettre à jour Firestore
    const now = new Date().toISOString();
    const deleteDate = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];
    const deleteDateFR = new Date(Date.now() + 14 * 86400000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

    await fsSet(`users/${uid}`, {
      plan: 'free',
      subscriptionStatus: 'cancelled',
      cancelledAt: now,
      cancelReason: reason || '',
      cancelDetail: detail || '',
      scheduledDeleteAt: deleteDate,
      previousPlan: currentPlan || '',
    }, adminToken);

    // 4. Logger dans retention_logs
    try {
      const logId = uid + '_' + Date.now();
      await fsSet(`retention_logs/${logId}`, {
        uid,
        action: 'cancelled',
        previousPlan: currentPlan || '',
        reason: reason || '',
        detail: detail || '',
        cancelledAt: now,
        scheduledDeleteAt: deleteDate,
      }, adminToken);
    } catch(logErr) {
      console.warn('[cancel-subscription] Log failed:', logErr.message);
    }

    // 5. Envoyer l'email de confirmation de résiliation
    const userEmail = fv(userDoc, 'email');
    const userName = fv(userDoc, 'name') || '';
    const firstName = userName ? userName.split(' ')[0] : '';
    if (userEmail) {
      try {
        const resendKey = process.env.RESEND_API_KEY;
        if (resendKey) {
          // Email au client
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + resendKey },
            body: JSON.stringify({
              from: process.env.RESEND_FROM || 'ALTEORE <noreply@alteore.com>',
              to: [userEmail],
              subject: 'Confirmation de résiliation — Alteore',
              html: emailCancellation(firstName, deleteDateFR, currentPlan)
            })
          });

          // Notification à l'équipe
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + resendKey },
            body: JSON.stringify({
              from: process.env.RESEND_FROM || 'ALTEORE <noreply@alteore.com>',
              to: ['support@alteore.com'],
              subject: '⚠️ Résiliation — ' + (userName || userEmail) + ' (' + (currentPlan || '?') + ')',
              html: '<p><strong>' + (userName || userEmail) + '</strong> a résilié son abonnement <strong>' + (currentPlan || '?') + '</strong>.</p>' +
                '<p>Raison : ' + (reason || 'non précisée') + '</p>' +
                '<p>Détail : ' + (detail || '-') + '</p>' +
                '<p>Suppression prévue : ' + deleteDateFR + '</p>'
            })
          });

          console.log('[cancel-subscription] Emails envoyés à ' + userEmail + ' + support');
        }
      } catch(emailErr) {
        console.warn('[cancel-subscription] Email failed:', emailErr.message);
      }
    }

    console.log(`[cancel-subscription] ✅ uid=${uid} plan=${currentPlan}→free reason=${reason}`);
    return res.status(200).json({ ok: true, deleteDate });

  } catch (e) {
    console.error('[cancel-subscription] ❌', e.message);
    return res.status(500).json({ error: e.message });
  }
};

function emailCancellation(name, deleteDate, plan) {
  var g = name ? 'Bonjour ' + name + ',' : 'Bonjour,';
  var pn = { pro: 'Pro', max: 'Max', master: 'Master' }[plan] || plan || '';
  return '<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f5f7ff;font-family:Arial,Helvetica,sans-serif">' +
'<div style="max-width:560px;margin:0 auto;padding:20px">' +
'  <div style="text-align:center;padding:24px 0"><span style="font-size:22px;font-weight:800;color:#0f1f5c;letter-spacing:1px">ALTEORE</span></div>' +
'  <div style="background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(15,31,92,0.08)">' +
'    <div style="background:linear-gradient(135deg,#6b7280,#9ca3af);padding:32px;color:white;text-align:center">' +
'      <div style="font-size:36px;margin-bottom:12px">👋</div>' +
'      <h1 style="margin:0;font-size:22px;font-weight:800">Résiliation confirmée</h1>' +
'      <p style="margin:10px 0 0;font-size:14px;opacity:0.9">Votre abonnement' + (pn ? ' ' + pn : '') + ' a bien été résilié.</p>' +
'    </div>' +
'    <div style="padding:28px 32px">' +
'      <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">' + g + '</p>' +
'      <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 20px">Nous confirmons la résiliation de votre abonnement Alteore. Nous sommes désolés de vous voir partir.</p>' +
'      <div style="background:#fef3c7;border:1.5px solid #fbbf24;border-radius:12px;padding:20px;margin-bottom:24px">' +
'        <p style="font-size:13px;font-weight:700;color:#92400e;margin:0 0 8px">📅 Ce qui va se passer :</p>' +
'        <p style="font-size:13px;color:#92400e;line-height:1.7;margin:0">Vos données seront conservées jusqu\'au <strong>' + deleteDate + '</strong>. Pendant cette période, vous pouvez réactiver votre compte à tout moment en vous reconnectant et en choisissant un plan.</p>' +
'      </div>' +
'      <div style="background:#f0f4ff;border-radius:12px;padding:20px;margin-bottom:24px">' +
'        <p style="font-size:13px;font-weight:700;color:#0f1f5c;margin:0 0 8px">💡 Vous changez d\'avis ?</p>' +
'        <p style="font-size:13px;color:#374151;line-height:1.7;margin:0">Reconnectez-vous simplement sur <a href="https://alteore.com/login.html" style="color:#1a3dce;font-weight:700">alteore.com</a> et choisissez un plan. Toutes vos données seront restaurées instantanément.</p>' +
'      </div>' +
'      <div style="border-top:1px solid #e5e7eb;padding-top:20px">' +
'        <p style="font-size:13px;color:#6b7280;line-height:1.7;margin:0">Merci d\'avoir utilisé Alteore. Si vous avez des retours à nous faire, n\'hésitez pas à nous écrire à <a href="mailto:support@alteore.com" style="color:#1a3dce">support@alteore.com</a></p>' +
'      </div>' +
'    </div>' +
'  </div>' +
'  <div style="text-align:center;padding:20px 0;font-size:11px;color:#94a3b8;line-height:1.5">ALTEORE — Logiciel de gestion pour TPE & PME<br/><a href="https://alteore.com" style="color:#94a3b8">alteore.com</a></div>' +
'</div></body></html>';
}
