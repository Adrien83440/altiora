// api/send-debug-email.js
// Notifie l'admin par email Resend quand un nouveau rapport de diagnostic
// est disponible. Le rapport lui-même est stocké dans Firestore (debug_reports/).

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { reportId, uid, email, name, summary, errorCount, warningCount } = req.body || {};
    if (!reportId || !uid) {
      return res.status(400).json({ error: 'reportId et uid requis' });
    }

    if (!process.env.RESEND_API_KEY) {
      console.warn('[send-debug-email] RESEND_API_KEY manquant');
      return res.status(500).json({ error: 'RESEND_API_KEY manquant' });
    }

    const appUrl = process.env.APP_URL || 'https://alteore.com';
    const adminEmail = 'contact@adrienemily.com';
    const fromAddr   = process.env.RESEND_FROM || 'ALTEORE <noreply@alteore.com>';

    const safeName    = String(name || 'Sans nom').substring(0, 80).replace(/[<>&"']/g, '');
    const safeEmail   = String(email || 'inconnu').substring(0, 120).replace(/[<>&"']/g, '');
    const safeSummary = String(summary || '').substring(0, 500).replace(/[<>&"']/g, function(c){
      return { '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&#39;' }[c];
    });

    const errBadge = errorCount > 0
      ? '<span style="background:#fee2e2;color:#b91c1c;padding:3px 9px;border-radius:20px;font-size:12px;font-weight:700">' + errorCount + ' erreur(s)</span>'
      : '<span style="background:#d1fae5;color:#065f46;padding:3px 9px;border-radius:20px;font-size:12px;font-weight:700">0 erreur</span>';
    const warnBadge = warningCount > 0
      ? '<span style="background:#fef3c7;color:#92400e;padding:3px 9px;border-radius:20px;font-size:12px;font-weight:700;margin-left:6px">' + warningCount + ' avert.</span>'
      : '';

    const viewUrl = appUrl + '/admin-debug-view.html?id=' + encodeURIComponent(reportId);

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/></head>
<body style="font-family:-apple-system,'Plus Jakarta Sans',sans-serif;background:#f9fafb;padding:24px">
  <div style="max-width:560px;margin:auto;background:white;border-radius:14px;border:1px solid #e5e7eb;overflow:hidden">
    <div style="background:linear-gradient(135deg,#0f1f5c,#2563eb);padding:22px 28px;color:white">
      <div style="font-size:11px;font-weight:700;letter-spacing:1px;opacity:.7;text-transform:uppercase">ALTEORE — Diagnostic</div>
      <div style="font-size:20px;font-weight:800;margin-top:4px">🩺 Nouveau rapport de diagnostic</div>
    </div>
    <div style="padding:24px 28px">
      <div style="margin-bottom:14px">${errBadge}${warnBadge}</div>
      <table style="width:100%;font-size:13px;color:#374151;border-collapse:collapse">
        <tr><td style="padding:6px 0;color:#6b7280;width:90px">Cliente</td><td style="padding:6px 0;font-weight:600;color:#0f172a">${safeName}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Email</td><td style="padding:6px 0;font-weight:600;color:#0f172a">${safeEmail}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">UID</td><td style="padding:6px 0;font-family:monospace;font-size:11px;color:#475569">${uid}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Rapport</td><td style="padding:6px 0;font-family:monospace;font-size:11px;color:#475569">${reportId}</td></tr>
      </table>
      ${safeSummary ? '<div style="margin-top:16px;padding:12px 14px;background:#f1f5f9;border-radius:8px;font-size:12px;color:#475569;line-height:1.6">' + safeSummary + '</div>' : ''}
      <div style="margin-top:22px;text-align:center">
        <a href="${viewUrl}" style="display:inline-block;background:linear-gradient(135deg,#2563eb,#60a5fa);color:white;font-weight:700;font-size:14px;padding:12px 28px;border-radius:10px;text-decoration:none">🔍 Consulter le rapport</a>
      </div>
      <div style="margin-top:18px;font-size:11px;color:#9ca3af;text-align:center">Envoyé automatiquement par Alteore — diagnostic v1</div>
    </div>
  </div>
</body></html>`;

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromAddr,
        to: [adminEmail],
        subject: '🩺 Diagnostic Alteore — ' + safeName + (errorCount > 0 ? ' (' + errorCount + ' erreur)' : ''),
        html: html
      })
    });

    if (!r.ok) {
      const txt = await r.text();
      console.error('[send-debug-email] Resend error:', r.status, txt);
      return res.status(500).json({ error: 'Resend error: ' + r.status });
    }

    console.log('[send-debug-email] OK pour', uid, '→', adminEmail);
    return res.status(200).json({ success: true });

  } catch(e) {
    console.error('send-debug-email error:', e);
    return res.status(500).json({ error: e.message || 'Erreur interne' });
  }
}
