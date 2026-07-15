// api/send-planning-comptable.js — Vague 6b (15/07/2026, demande cliente)
// Envoie le planning de la semaine affichée au comptable par email (Resend).
// POST { idToken, to, weekLabel, tableHtml, entreprise? }
//
// Sécurité :
//  - idToken Firebase OBLIGATOIRE, vérifié via accounts:lookup (pattern existant du repo,
//    Admin SDK bloqué par policy → REST API, cf. règle projet n°11)
//  - taille du HTML plafonnée, destinataire validé par regex
//  - le contenu est encapsulé dans un gabarit email côté serveur

async function verifyIdToken(idToken) {
  const fbKey = process.env.FIREBASE_API_KEY;
  if (!fbKey) throw new Error('FIREBASE_API_KEY non configurée');
  const res = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + fbKey,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    }
  );
  if (!res.ok) throw new Error('Token invalide');
  const data = await res.json();
  const uid = data.users?.[0]?.localId;
  if (!uid) throw new Error('Utilisateur introuvable');
  return { uid, email: data.users?.[0]?.email || '' };
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  if (['https://alteore.com', 'http://localhost:3000'].includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { idToken, to, weekLabel, tableHtml, entreprise } = req.body || {};

    // ── Validations ──
    if (!idToken) return res.status(401).json({ error: 'Authentification requise' });
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(to)))
      return res.status(400).json({ error: 'Email du comptable invalide' });
    if (!tableHtml || typeof tableHtml !== 'string')
      return res.status(400).json({ error: 'Contenu du planning manquant' });
    if (tableHtml.length > 200000)
      return res.status(400).json({ error: 'Planning trop volumineux' });

    let user;
    try { user = await verifyIdToken(idToken); }
    catch (e) { return res.status(401).json({ error: 'Session expirée — reconnectez-vous' }); }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Config email manquante' });
    const from = process.env.RESEND_FROM || 'ALTEORE <noreply@alteore.com>';

    const escTxt = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const nomEntreprise = escTxt(entreprise || '').substring(0, 120);
    const semaine = escTxt(weekLabel || '').substring(0, 60);

    const subject = `📅 Planning ${nomEntreprise ? nomEntreprise + ' — ' : ''}semaine du ${semaine}`;
    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f6fb;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:720px;margin:0 auto;padding:24px 12px">
    <div style="background:#0f1f5c;border-radius:14px 14px 0 0;padding:18px 24px">
      <span style="color:#fff;font-size:18px;font-weight:800">ALTEORE</span>
      <span style="color:#9fb3ff;font-size:12px;margin-left:10px">Planning hebdomadaire</span>
    </div>
    <div style="background:#ffffff;border-radius:0 0 14px 14px;padding:22px 24px;border:1px solid #e5e9f2;border-top:none">
      <p style="font-size:14px;color:#1f2937;margin:0 0 6px"><b>${nomEntreprise || 'Planning'}</b> — semaine du <b>${semaine}</b></p>
      <p style="font-size:12px;color:#6b7280;margin:0 0 16px">Document transmis par ${escTxt(user.email)} via Alteore.</p>
      ${tableHtml}
      <p style="font-size:11px;color:#9ca3af;margin:18px 0 0">Email généré automatiquement par Alteore (alteore.com) à la demande de l'employeur.
      Les heures indiquées sont prévisionnelles ; les heures réellement effectuées peuvent différer.</p>
    </div>
  </div>
</body></html>`;

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from, to: [to], reply_to: user.email || undefined, subject, html })
    });

    if (!r.ok) {
      const errTxt = await r.text();
      console.error('[send-planning-comptable] Resend error:', r.status, errTxt.substring(0, 300));
      return res.status(502).json({ error: 'Échec de l\'envoi email' });
    }

    console.log(`[send-planning-comptable] OK uid=${user.uid} → ${to} (semaine ${semaine})`);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[send-planning-comptable] Erreur:', e.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
