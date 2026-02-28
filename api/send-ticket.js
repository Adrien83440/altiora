// api/send-ticket.js — Envoi de ticket support ALTEORE
// Sauvegarde le ticket dans Firestore + envoie un email à contact@adrienemily.com

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { ticketId, nom, prenom, telephone, email, sujet, description, page, uid } = req.body;
    if (!nom || !prenom || !email || !sujet || !description) {
      return res.status(400).json({ error: 'Champs obligatoires manquants' });
    }

    const id = ticketId || ('TK-' + Date.now());
    const date = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

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
              status: { stringValue: 'open' }, createdAt: { stringValue: new Date().toISOString() }
            } }) }
        );
      }
    } catch (e) { console.warn('Firestore save failed:', e.message); }

    // 2. Envoyer email via Resend
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    let emailSent = false;
    if (RESEND_API_KEY) {
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
          body: JSON.stringify({
            from: 'ALTEORE Support <tickets@alteore.com>',
            to: ['contact@adrienemily.com'],
            subject: `Ticket ALTEORE - ${id}`,
            html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8faff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
              <div style="background:linear-gradient(135deg,#0f1f5c,#1a3dce);padding:24px 28px;color:white"><h1 style="margin:0;font-size:20px">Nouveau Ticket Support</h1><p style="margin:6px 0 0;opacity:0.7;font-size:13px">ID: ${id} - ${date}</p></div>
              <div style="padding:24px 28px"><table style="width:100%;border-collapse:collapse;font-size:14px">
                <tr><td style="padding:8px 0;color:#6b7280;width:120px"><strong>Nom</strong></td><td>${prenom} ${nom}</td></tr>
                <tr><td style="padding:8px 0;color:#6b7280"><strong>Email</strong></td><td><a href="mailto:${email}">${email}</a></td></tr>
                <tr><td style="padding:8px 0;color:#6b7280"><strong>Telephone</strong></td><td>${telephone || 'Non renseigne'}</td></tr>
                <tr><td style="padding:8px 0;color:#6b7280"><strong>Sujet</strong></td><td><strong>${sujet}</strong></td></tr>
                <tr><td style="padding:8px 0;color:#6b7280"><strong>Page</strong></td><td>${page || 'Non specifiee'}</td></tr>
              </table><div style="margin-top:16px;padding:16px;background:white;border:1px solid #e2e8f0;border-radius:8px;white-space:pre-wrap;font-size:14px;line-height:1.6">${description}</div>
              <div style="margin-top:20px;text-align:center"><a href="mailto:${email}?subject=Re: Ticket ALTEORE ${id}" style="display:inline-block;padding:10px 24px;background:#1a3dce;color:white;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Repondre au client</a></div></div>
              <div style="padding:12px 28px;background:#f1f5f9;text-align:center;font-size:11px;color:#94a3b8">ALTEORE - Systeme de tickets support</div></div>`
          })
        });
        emailSent = r.ok;
      } catch (e) { console.error('Email error:', e.message); }
    }

    return res.status(200).json({ success: true, ticketId: id, emailSent });
  } catch (error) {
    console.error('send-ticket error:', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
