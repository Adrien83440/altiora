// api/send-ticket-reply.js — Envoi de réponse admin au client + update Firestore
// L'admin répond à un ticket depuis admin-tickets.html.
// Cette API :
//   1. Envoie l'email de réponse au client via Resend (thread = "Re: Ticket TK-...")
//   2. Append la réponse dans tickets/{ticketId}.replies[] via token admin
//   3. Passe le ticket à status='in_progress' s'il était 'open'
//
// Sécurité : l'admin doit être authentifié et son email doit être contact@adrienemily.com.
// On vérifie le idToken Firebase côté serveur avant d'accepter la requête.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ── 1. Vérifier que l'appelant est bien l'admin ──
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) {
      return res.status(401).json({ error: 'Non authentifié' });
    }

    // Vérifier le token via Firebase Identity Toolkit
    const verifyRes = await fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + process.env.FIREBASE_API_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      }
    );
    const verifyData = await verifyRes.json();
    const callerEmail = (verifyData.users && verifyData.users[0] && verifyData.users[0].email || '').toLowerCase();

    const ADMIN_EMAILS = ['contact@adrienemily.com', 'api@altiora.app'];
    if (!ADMIN_EMAILS.includes(callerEmail)) {
      console.warn('[send-ticket-reply] ❌ Non-admin tried:', callerEmail);
      return res.status(403).json({ error: 'Accès réservé à l\'admin' });
    }

    // ── 2. Validation payload ──
    const { ticketId, to, clientName, subject, replyText } = req.body || {};
    if (!ticketId || !to || !replyText) {
      return res.status(400).json({ error: 'Champs obligatoires manquants (ticketId, to, replyText)' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return res.status(400).json({ error: 'Adresse email invalide' });
    }
    if (replyText.length > 10000) {
      return res.status(400).json({ error: 'Réponse trop longue (max 10 000 caractères)' });
    }

    const date = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
    const safeName = (clientName || 'Bonjour').replace(/[<>]/g, '');
    const safeSubject = (subject || 'Votre demande').replace(/[<>]/g, '');
    const emailSubject = 'Re: [Ticket ' + ticketId + '] ' + safeSubject;

    // ── 3. Envoi email via Resend ──
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_API_KEY) {
      return res.status(500).json({ error: 'RESEND_API_KEY non configurée' });
    }

    // Convertir les retours à la ligne en <br> pour le HTML (safe)
    const replyHtml = replyText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br/>');

    const resendPayload = {
      from: 'ALTEORE Support <support@alteore.com>',
      to: [to],
      reply_to: 'support@alteore.com',
      subject: emailSubject,
      html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f5f7ff;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:20px">
  <div style="text-align:center;padding:24px 0">
    <span style="font-size:22px;font-weight:800;color:#0f1f5c;letter-spacing:1px">ALTEORE</span>
  </div>
  <div style="background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(15,31,92,0.08)">
    <div style="background:linear-gradient(135deg,#1a3dce,#4f7ef8);padding:24px 32px;color:white">
      <h1 style="margin:0;font-size:18px;font-weight:700">Réponse de l'équipe support</h1>
      <p style="margin:6px 0 0;font-size:13px;opacity:0.85">Ticket ${ticketId} — ${date}</p>
    </div>
    <div style="padding:28px 32px">
      <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">Bonjour ${safeName.replace(/[&<>"]/g, '')},</p>
      <div style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 20px;white-space:pre-wrap">${replyHtml}</div>
      <div style="margin-top:24px;padding-top:18px;border-top:1px solid #e5e7eb;font-size:13px;color:#6b7280;line-height:1.6">
        Pour toute question supplémentaire, répondez simplement à cet email — le fil reste associé à votre ticket.
      </div>
    </div>
    <div style="padding:16px 32px;background:#f8faff;border-top:1px solid #e2e8f0;text-align:center">
      <a href="https://alteore.com/aide.html" style="display:inline-block;padding:10px 24px;background:linear-gradient(135deg,#1a3dce,#4f7ef8);color:white;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px">Centre d'aide ALTEORE</a>
    </div>
  </div>
  <div style="text-align:center;padding:20px 0;font-size:11px;color:#94a3b8;line-height:1.5">
    ALTEORE — Logiciel de gestion pour commerçants<br/>
    <a href="https://alteore.com" style="color:#94a3b8">alteore.com</a>
  </div>
</div></body></html>`
    };

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify(resendPayload)
    });
    const resendData = await r.json();
    if (!r.ok) {
      const errMsg = resendData.message || resendData.error || JSON.stringify(resendData);
      console.error('[send-ticket-reply] ❌ Resend error:', r.status, errMsg);
      return res.status(502).json({ error: 'Email non envoyé', detail: errMsg });
    }
    const emailId = resendData.id || null;
    console.log('[send-ticket-reply] ✅ Email envoyé:', emailId);

    // ── 4. Update Firestore (append reply + status) ──
    try {
      const projectId = process.env.FIREBASE_PROJECT_ID || 'altiora-70599';

      // Login admin serveur
      const authRes = await fetch(
        'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + process.env.FIREBASE_API_KEY,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: process.env.FIREBASE_API_EMAIL,
            password: process.env.FIREBASE_API_PASSWORD,
            returnSecureToken: true
          })
        }
      );
      const authData = await authRes.json();
      if (!authData.idToken) {
        console.error('[send-ticket-reply] ❌ Firebase admin login failed');
        return res.status(200).json({ success: true, emailId, firestoreUpdated: false, warn: 'Email envoyé mais Firestore non mis à jour' });
      }
      const adminToken = authData.idToken;

      // 4a. GET ticket actuel pour récupérer replies[] existant et status
      const getUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/tickets/${ticketId}`;
      const getRes = await fetch(getUrl, {
        headers: { Authorization: 'Bearer ' + adminToken }
      });
      const ticketData = await getRes.json();

      // Récupérer replies[] existant au format Firestore REST
      let existingReplies = [];
      if (ticketData.fields && ticketData.fields.replies && ticketData.fields.replies.arrayValue && ticketData.fields.replies.arrayValue.values) {
        existingReplies = ticketData.fields.replies.arrayValue.values;
      }
      const currentStatus = ticketData.fields && ticketData.fields.status && ticketData.fields.status.stringValue || 'open';

      // 4b. Nouvelle réponse (format Firestore REST = mapValue)
      const newReplyValue = {
        mapValue: {
          fields: {
            text: { stringValue: replyText },
            sentAt: { stringValue: new Date().toISOString() },
            from: { stringValue: callerEmail },
            emailId: { stringValue: emailId || '' }
          }
        }
      };
      const updatedReplies = existingReplies.concat([newReplyValue]);

      // Nouveau status : si 'open' → 'in_progress', sinon conserver
      const newStatus = currentStatus === 'open' ? 'in_progress' : currentStatus;

      // 4c. PATCH avec updateMask pour ne modifier que les champs concernés
      const patchUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/tickets/${ticketId}?updateMask.fieldPaths=replies&updateMask.fieldPaths=status&updateMask.fieldPaths=updatedAt&updateMask.fieldPaths=isRead`;
      const patchBody = {
        fields: {
          replies: { arrayValue: { values: updatedReplies } },
          status: { stringValue: newStatus },
          updatedAt: { stringValue: new Date().toISOString() },
          isRead: { booleanValue: true }
        }
      };
      const patchRes = await fetch(patchUrl, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + adminToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(patchBody)
      });
      if (!patchRes.ok) {
        const errTxt = await patchRes.text();
        console.error('[send-ticket-reply] ❌ Firestore patch failed:', patchRes.status, errTxt);
        return res.status(200).json({ success: true, emailId, firestoreUpdated: false, warn: 'Email envoyé mais Firestore update a échoué' });
      }
      console.log('[send-ticket-reply] ✅ Firestore mis à jour (reply appended, status=' + newStatus + ')');
    } catch (e) {
      console.error('[send-ticket-reply] ❌ Firestore exception:', e.message);
      return res.status(200).json({ success: true, emailId, firestoreUpdated: false, warn: 'Email envoyé mais Firestore exception' });
    }

    return res.status(200).json({ success: true, emailId, firestoreUpdated: true });
  } catch (error) {
    console.error('[send-ticket-reply] fatal:', error);
    return res.status(500).json({ error: 'Erreur serveur', detail: error.message });
  }
}
