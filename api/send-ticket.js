// api/send-ticket.js — Envoi de ticket support ALTEORE
// Sauvegarde le ticket dans Firestore + envoie un email à support@alteore.com
// + envoie un email de confirmation au client

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { ticketId, nom, prenom, telephone, email, sujet, description, page, uid, plan } = req.body;
    if (!nom || !prenom || !email || !sujet || !description) {
      return res.status(400).json({ error: 'Champs obligatoires manquants' });
    }

    const id = ticketId || ('TK-' + Date.now());
    const date = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
    const userPlan = plan || 'unknown';

    // ── Plan badge et priorité ──
    const PLAN_LABELS = {
      master: { label: '👑 Master', color: '#7c3aed', bg: '#f5f3ff', priority: '🔴 PRIORITAIRE' },
      max:    { label: '🚀 Max', color: '#1a3dce', bg: '#eff6ff', priority: '' },
      pro:    { label: '📊 Pro', color: '#10b981', bg: '#f0fdf4', priority: '' },
      trial:  { label: '⏳ Essai', color: '#f59e0b', bg: '#fffbeb', priority: '' },
    };
    const planInfo = PLAN_LABELS[userPlan] || { label: userPlan, color: '#6b7280', bg: '#f9fafb', priority: '' };
    const isMaster = userPlan === 'master';

    // 1. Sauvegarder dans Firestore
    try {
      const projectId = process.env.FIREBASE_PROJECT_ID || 'altiora-70599';
      const authRes = await fetch(
        'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + process.env.FIREBASE_API_KEY,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: process.env.FIREBASE_API_EMAIL, password: process.env.FIREBASE_API_PASSWORD, returnSecureToken: true }) }
      );
      const authData = await authRes.json();
      if (authData.idToken) {
        await fetch(
          `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/tickets/${id}`,
          { method: 'PATCH', headers: { Authorization: 'Bearer ' + authData.idToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: {
              ticketId: { stringValue: id }, nom: { stringValue: nom }, prenom: { stringValue: prenom },
              telephone: { stringValue: telephone || '' }, email: { stringValue: email }, sujet: { stringValue: sujet },
              description: { stringValue: description }, page: { stringValue: page || '' }, uid: { stringValue: uid || '' },
              plan: { stringValue: userPlan },
              status: { stringValue: 'open' }, createdAt: { stringValue: new Date().toISOString() }
            } }) }
        );
      }
    } catch (e) { console.warn('Firestore save failed:', e.message); }

    // 2. Envoyer emails via Resend
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    let emailSent = false;
    let confirmSent = false;
    let emailError = null;

    if (!RESEND_API_KEY) {
      console.error('[send-ticket] ❌ RESEND_API_KEY non configurée');
      emailError = 'RESEND_API_KEY missing';
    } else {

      // ── 2a. Email ADMIN (à l'équipe support) ──
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
          body: JSON.stringify({
            from: 'ALTEORE Support <noreply@alteore.com>',
            to: ['support@alteore.com'],
            subject: `${isMaster ? '🔴 PRIORITAIRE — ' : ''}Ticket ${id} — ${sujet}`,
            html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8faff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
              ${isMaster ? '<div style="background:#7c3aed;padding:10px 28px;text-align:center;color:white;font-size:13px;font-weight:700;letter-spacing:0.5px">🔴 CLIENT MASTER — SUPPORT PRIORITAIRE</div>' : ''}
              <div style="background:linear-gradient(135deg,#0f1f5c,#1a3dce);padding:24px 28px;color:white">
                <h1 style="margin:0;font-size:20px">Nouveau Ticket Support</h1>
                <p style="margin:6px 0 0;opacity:0.7;font-size:13px">ID: ${id} — ${date}</p>
              </div>
              <div style="padding:24px 28px">
                <table style="width:100%;border-collapse:collapse;font-size:14px">
                  <tr><td style="padding:8px 0;color:#6b7280;width:120px"><strong>Nom</strong></td><td>${prenom} ${nom}</td></tr>
                  <tr><td style="padding:8px 0;color:#6b7280"><strong>Email</strong></td><td><a href="mailto:${email}">${email}</a></td></tr>
                  <tr><td style="padding:8px 0;color:#6b7280"><strong>Téléphone</strong></td><td>${telephone || 'Non renseigné'}</td></tr>
                  <tr><td style="padding:8px 0;color:#6b7280"><strong>Sujet</strong></td><td><strong>${sujet}</strong></td></tr>
                  <tr><td style="padding:8px 0;color:#6b7280"><strong>Page</strong></td><td>${page || 'Non spécifiée'}</td></tr>
                  <tr><td style="padding:8px 0;color:#6b7280"><strong>Plan</strong></td><td><span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;background:${planInfo.bg};color:${planInfo.color}">${planInfo.label}</span>${planInfo.priority ? ' <span style="color:#ef4444;font-weight:700;font-size:12px">' + planInfo.priority + '</span>' : ''}</td></tr>
                </table>
                <div style="margin-top:16px;padding:16px;background:white;border:1px solid #e2e8f0;border-radius:8px;white-space:pre-wrap;font-size:14px;line-height:1.6">${description}</div>
                <div style="margin-top:20px;text-align:center">
                  <a href="mailto:${email}?subject=Re: Votre ticket ${id} — ALTEORE Support" style="display:inline-block;padding:10px 24px;background:#1a3dce;color:white;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Répondre au client</a>
                </div>
              </div>
              <div style="padding:12px 28px;background:#f1f5f9;text-align:center;font-size:11px;color:#94a3b8">ALTEORE — Système de tickets support</div>
            </div>`
          })
        });
        const resendData = await r.json();
        emailSent = r.ok;
        if (!r.ok) {
          emailError = resendData.message || resendData.error || JSON.stringify(resendData);
          console.error('[send-ticket] ❌ Resend admin error:', r.status, emailError);
        } else {
          console.log('[send-ticket] ✅ Email admin envoyé:', resendData.id);
        }
      } catch (e) {
        emailError = e.message;
        console.error('[send-ticket] ❌ Email admin exception:', e.message);
      }

      // ── 2b. Email CONFIRMATION (au client) ──
      try {
        const delaiMsg = isMaster
          ? 'Votre plan <strong>Master</strong> vous donne accès au <strong>support prioritaire</strong>. Nous reviendrons vers vous dans les plus brefs délais.'
          : 'Nous traitons les demandes dans l\'ordre de réception et reviendrons vers vous sous <strong>24 à 48 heures ouvrées</strong>.';

        const rc = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
          body: JSON.stringify({
            from: 'ALTEORE Support <noreply@alteore.com>',
            to: [email],
            subject: `Votre demande a bien été reçue — Ticket ${id}`,
            html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f5f7ff;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:20px">
  <div style="text-align:center;padding:24px 0">
    <span style="font-size:22px;font-weight:800;color:#0f1f5c;letter-spacing:1px">ALTEORE</span>
  </div>
  <div style="background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(15,31,92,0.08)">
    <div style="background:linear-gradient(135deg,#10b981,#059669);padding:28px 32px;color:white">
      <div style="font-size:28px;margin-bottom:8px">✅</div>
      <h1 style="margin:0;font-size:20px;font-weight:800">Demande bien reçue !</h1>
      <p style="margin:8px 0 0;font-size:14px;opacity:0.85">Ticket ${id}</p>
    </div>
    <div style="padding:28px 32px">
      <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">
        Bonjour ${prenom},
      </p>
      <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">
        Nous avons bien reçu votre demande concernant <strong>${sujet}</strong>. Notre équipe va l'examiner rapidement.
      </p>
      <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 20px">
        ${delaiMsg}
      </p>
      <div style="background:#f8faff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin:0 0 20px">
        <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">Récapitulatif</div>
        <table style="width:100%;font-size:13px;color:#374151">
          <tr><td style="padding:4px 0;color:#6b7280;width:100px">Ticket</td><td style="font-weight:600">${id}</td></tr>
          <tr><td style="padding:4px 0;color:#6b7280">Sujet</td><td style="font-weight:600">${sujet}</td></tr>
          <tr><td style="padding:4px 0;color:#6b7280">Date</td><td>${date}</td></tr>
        </table>
      </div>
      <p style="font-size:13px;color:#6b7280;line-height:1.6;margin:0">
        Si vous avez des informations supplémentaires, répondez directement à cet email ou contactez-nous à <a href="mailto:support@alteore.com" style="color:#1a3dce">support@alteore.com</a>.
      </p>
    </div>
    <div style="padding:16px 32px;background:#f8faff;border-top:1px solid #e2e8f0;text-align:center">
      <a href="https://alteore.com/aide.html" style="display:inline-block;padding:10px 24px;background:linear-gradient(135deg,#1a3dce,#4f7ef8);color:white;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px">Consulter le centre d'aide</a>
    </div>
  </div>
  <div style="text-align:center;padding:20px 0;font-size:11px;color:#94a3b8;line-height:1.5">
    ALTEORE — Logiciel de gestion pour commerçants<br/>
    <a href="https://alteore.com" style="color:#94a3b8">alteore.com</a>
  </div>
</div></body></html>`
          })
        });
        const confirmData = await rc.json();
        confirmSent = rc.ok;
        if (!rc.ok) {
          console.error('[send-ticket] ❌ Resend confirm error:', rc.status, confirmData);
        } else {
          console.log('[send-ticket] ✅ Email confirmation client envoyé:', confirmData.id);
        }
      } catch (e) {
        console.error('[send-ticket] ❌ Email confirm exception:', e.message);
      }
    }

    return res.status(200).json({ success: true, ticketId: id, emailSent, confirmSent, emailError });
  } catch (error) {
    console.error('send-ticket error:', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
