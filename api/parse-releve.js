const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

// ── Auth verification ──
async function verifyToken(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  try {
    const apiKey = process.env.FIREBASE_API_KEY;
    if (apiKey) {
      const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key='+apiKey, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken:token})});
      if (!r.ok) return null;
      const d = await r.json();
      return d.users?.[0]?.localId || null;
    }
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (payload.exp && payload.exp < Date.now()/1000) return null;
    return payload.user_id || payload.sub || null;
  } catch(e) { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const uid = await verifyToken(req);
  if (!uid) return res.status(401).json({ error: 'Non authentifié.' });

  // Rate limit: 10 req/min per user
  if (!global._releveBuckets) global._releveBuckets = new Map();
  const now = Date.now();
  let bkt = global._releveBuckets.get(uid);
  if (!bkt || now > bkt.r) { bkt = {c:0, r:now+60000}; global._releveBuckets.set(uid, bkt); }
  bkt.c++;
  if (bkt.c > 10) return res.status(429).json({ error: 'Trop de requêtes. Attendez 1 minute.' });

  try {
    const { pdfText, pages, fileName } = req.body;

    const hasText = pdfText && pdfText.trim().length > 100;
    const hasImages = pages && Array.isArray(pages) && pages.length > 0;

    if (!hasText && !hasImages) {
      return res.status(400).json({ error: 'Aucune donnée PDF reçue.' });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    async function callWithRetry(params, maxRetries) {
      maxRetries = maxRetries || 3;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          return await client.messages.create(params);
        } catch (err) {
          if ((err.status === 429 || err.name === 'RateLimitError') && attempt < maxRetries - 1) {
            var retryAfter = parseInt(err.headers && err.headers['retry-after']) || 0;
            var delay = retryAfter > 0 ? (retryAfter * 1000 + 2000) : Math.pow(2, attempt) * 5000;
            console.log('[parse-releve] Rate limit, retry in ' + delay + 'ms');
            await new Promise(function(r) { setTimeout(r, delay); });
            continue;
          }
          throw err;
        }
      }
    }

    const content = [];

    if (hasText) {
      // Text mode — more efficient, works for most bank PDFs
      var truncated = pdfText.length > 60000 ? pdfText.slice(0, 60000) + '\n[tronqué]' : pdfText;
      content.push({ type: 'text', text: 'Relevé bancaire (texte extrait du PDF, fichier: ' + (fileName || 'inconnu') + ') :\n\n' + truncated });
    } else {
      // Image mode — fallback for scanned PDFs
      var pagesToSend = pages.slice(0, 20);
      for (var i = 0; i < pagesToSend.length; i++) {
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: pagesToSend[i] } });
      }
    }

    content.push({
      type: 'text',
      text: `Tu es un parser expert de relevés bancaires français. Extrais TOUTES les transactions de ce relevé de compte courant.

RÈGLES D'EXTRACTION :
1. Chaque ligne avec un montant en DEBIT ou CREDIT est une transaction
2. Les montants sont au format français : espace = séparateur milliers, virgule = décimale. Convertis en nombre décimal (point comme séparateur).
3. DATE = la colonne DATE (format JJ.MM ou JJ/MM)
4. VALEUR = date de valeur (JJ.MM.AA) — utilise-la pour déterminer l'année complète
5. Si un montant a un point "." dans la colonne (sans chiffre), il fait partie de la même ligne que le montant réel
6. Combine les lignes de LIBELLE continues (PRLV SEPA + LIBELLE: + REF.CLIENT: etc.) en un seul label propre
7. Pour le tiers, extrais le nom du fournisseur/payeur principal (ex: "PRLV SEPA SAS DUCREUX" → tiers: "SAS DUCREUX")
8. "REMISE CB" = encaissement carte bancaire → type: "credit"
9. "COMMISSIONS SUR REMISE CB" = frais bancaire → type: "debit"
10. "PRLV SEPA" = prélèvement → type: "debit"
11. "VIR SEPA" ou "VIR INST" sortants (colonne DEBIT) = type: "debit"
12. "VIR SEPA" ou "VIR INST" entrants (colonne CREDIT) = type: "credit"
13. "PRET" + "ECHEANCE" = échéance de prêt → type: "debit"
14. "CHQ." = chèque émis → type: "debit"
15. "REM CHQ" = remise de chèque → type: "credit"
16. "CB" suivi d'un nom = paiement par carte → type: "debit"
17. Ignore les lignes "ANCIEN SOLDE", "SOLDE", "TOTAUX", "NOUVEAU SOLDE"
18. L'année complète vient de la colonne VALEUR (ex: 06.02.26 → 2026)

Pour chaque transaction, détermine :
- date: format "JJ/MM/AAAA" (avec année complète)
- label: libellé bancaire nettoyé (sans REF.CLIENT, ID.CREANCIER, REF.MANDAT)
- tiers: nom court du tiers (fournisseur, client, organisme)
- montant: valeur absolue en nombre décimal
- type: "debit" ou "credit"
- monthKey: format "AAAA-MM" basé sur la date

IMPORTANT : ne saute AUCUNE transaction. Chaque ligne avec un montant doit être extraite.

Réponds UNIQUEMENT en JSON brut (sans markdown, sans backticks) :
{"transactions":[{"date":"06/02/2026","label":"COMMISSIONS SUR REMISE CB NO 563964","tiers":"LCL Commissions","montant":0.13,"type":"debit","monthKey":"2026-02"}],"bankName":"NOM_BANQUE","accountHolder":"NOM_TITULAIRE","periodStart":"JJ/MM/AAAA","periodEnd":"JJ/MM/AAAA","totalDebit":0,"totalCredit":0}`
    });

    var model = hasText ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-20250514';
    console.log('[parse-releve] Using model: ' + model + ', mode: ' + (hasText ? 'text' : 'vision') + ', file: ' + (fileName || '?'));

    var response = await callWithRetry({
      model: model,
      max_tokens: 16000,
      messages: [{ role: 'user', content: content }]
    });

    var raw = '';
    for (var j = 0; j < response.content.length; j++) {
      if (response.content[j].type === 'text') raw += response.content[j].text;
    }

    // Clean potential markdown fences
    raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      console.error('[parse-releve] JSON parse error:', parseErr.message, 'Raw (first 500):', raw.slice(0, 500));
      return res.status(500).json({ error: 'Erreur de parsing IA. Réessayez.', raw: raw.slice(0, 200) });
    }

    // Validate
    if (!parsed.transactions || !Array.isArray(parsed.transactions)) {
      return res.status(500).json({ error: 'Format de réponse IA invalide.' });
    }

    // Clean up and validate each transaction
    var clean = [];
    for (var k = 0; k < parsed.transactions.length; k++) {
      var tx = parsed.transactions[k];
      var montant = parseFloat(tx.montant);
      if (isNaN(montant) || montant <= 0) continue;
      clean.push({
        date: tx.date || '',
        label: (tx.label || '').trim(),
        tiers: (tx.tiers || '').trim(),
        montant: Math.round(montant * 100) / 100,
        type: tx.type === 'credit' ? 'credit' : 'debit',
        monthKey: tx.monthKey || ''
      });
    }

    console.log('[parse-releve] Extracted ' + clean.length + ' transactions from ' + (fileName || '?'));

    return res.status(200).json({
      transactions: clean,
      bankName: parsed.bankName || '',
      accountHolder: parsed.accountHolder || '',
      periodStart: parsed.periodStart || '',
      periodEnd: parsed.periodEnd || '',
      totalDebit: parsed.totalDebit || 0,
      totalCredit: parsed.totalCredit || 0
    });

  } catch (err) {
    console.error('[parse-releve] Error:', err);
    return res.status(500).json({ error: 'Erreur serveur: ' + (err.message || 'inconnue') });
  }
};
