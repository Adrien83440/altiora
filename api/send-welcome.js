// api/send-welcome.js — Email de bienvenue J+0 après inscription
// Appelé depuis login.html après création du compte

module.exports = async (req, res) => {
  // CORS
  const origin = req.headers.origin || '';
  if (!['https://alteore.com', 'http://localhost:3000'].includes(origin)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { email, name } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email requis' });

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.warn('[send-welcome] RESEND_API_KEY manquante');
      return res.status(500).json({ error: 'Config manquante' });
    }

    const from = process.env.RESEND_FROM || 'ALTEORE <noreply@alteore.com>';
    const firstName = name ? name.split(' ')[0] : '';

    const html = emailWelcome(firstName);

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from, to: [email], subject: 'Bienvenue sur Alteore ! 🚀', html })
    });

    const data = await r.json();
    if (r.ok) {
      console.log(`[send-welcome] ✅ Email envoyé à ${email}`);
      return res.status(200).json({ ok: true });
    } else {
      console.error('[send-welcome] ❌ Resend error:', data);
      return res.status(500).json({ error: 'Erreur envoi email' });
    }
  } catch (e) {
    console.error('[send-welcome] ❌ Exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
};


/* ── Template email ── */
function emailWelcome(name) {
  const greeting = name ? `Bonjour ${name},` : 'Bonjour,';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f5f7ff;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:20px">
  <div style="text-align:center;padding:24px 0">
    <span style="font-size:22px;font-weight:800;color:#0f1f5c;letter-spacing:1px">ALTEORE</span>
  </div>
  <div style="background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(15,31,92,0.08)">
    <div style="background:linear-gradient(135deg,#0f1f5c,#1a3dce);padding:32px;color:white;text-align:center">
      <div style="font-size:36px;margin-bottom:12px">🚀</div>
      <h1 style="margin:0;font-size:22px;font-weight:800">Bienvenue sur Alteore !</h1>
      <p style="margin:10px 0 0;font-size:14px;opacity:0.8">Votre essai gratuit de 15 jours est activé</p>
    </div>
    <div style="padding:28px 32px">
      <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">
        ${greeting}
      </p>
      <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 20px">
        Merci de nous avoir rejoint. Votre compte est prêt et vous avez accès à <strong>toutes les fonctionnalités</strong> pendant 15 jours.
      </p>

      <div style="background:#f0f4ff;border-radius:12px;padding:20px;margin-bottom:24px">
        <p style="font-size:13px;font-weight:700;color:#0f1f5c;margin:0 0 12px">🎯 Pour bien démarrer :</p>
        <table style="width:100%;font-size:13px;color:#374151;line-height:1.7" cellspacing="0" cellpadding="0">
          <tr><td style="padding:4px 0"><strong>1.</strong> Renseignez votre activité dans l'onboarding</td></tr>
          <tr><td style="padding:4px 0"><strong>2.</strong> Saisissez votre CA du mois dans le <strong>Pilotage</strong></td></tr>
          <tr><td style="padding:4px 0"><strong>3.</strong> Explorez le <strong>Dashboard</strong> pour voir vos KPIs</td></tr>
          <tr><td style="padding:4px 0"><strong>4.</strong> Testez l'<strong>Analyse IA</strong> avec un bilan PDF</td></tr>
        </table>
      </div>

      <div style="text-align:center;margin-bottom:20px">
        <a href="https://alteore.com/bienvenue.html" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#1a3dce,#4f7ef8);color:white;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;box-shadow:0 4px 14px rgba(26,61,206,0.3)">Accéder à mon espace →</a>
      </div>

      <div style="border-top:1px solid #e5e7eb;padding-top:20px;margin-top:8px">
        <p style="font-size:13px;color:#6b7280;line-height:1.7;margin:0 0 8px">
          💡 <strong>Astuce :</strong> le pilotage est le cœur d'Alteore. En saisissant votre CA et vos charges, votre dashboard se remplit automatiquement avec vos marges, votre seuil de rentabilité et votre trésorerie prévisionnelle.
        </p>
        <p style="font-size:13px;color:#6b7280;line-height:1.7;margin:0">
          Une question ? Répondez simplement à cet email ou contactez-nous à <a href="mailto:support@alteore.com" style="color:#1a3dce">support@alteore.com</a>
        </p>
      </div>
    </div>
  </div>
  <div style="text-align:center;padding:20px 0;font-size:11px;color:#94a3b8;line-height:1.5">
    ALTEORE — Logiciel de gestion pour TPE & PME<br/>
    <a href="https://alteore.com" style="color:#94a3b8">alteore.com</a>
  </div>
</div></body></html>`;
}
