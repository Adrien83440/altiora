const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

// ── Auth verification (same pattern as parse-releve.js) ──
async function verifyToken(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  try {
    const apiKey = process.env.FIREBASE_API_KEY;
    if (apiKey) {
      const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + apiKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token })
      });
      if (!r.ok) return null;
      const d = await r.json();
      return d.users?.[0]?.localId || null;
    }
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (payload.exp && payload.exp < Date.now() / 1000) return null;
    return payload.user_id || payload.sub || null;
  } catch (e) { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const uid = await verifyToken(req);
  if (!uid) return res.status(401).json({ error: 'Non authentifié.' });

  // Rate limit: 20 req/min per user
  if (!global._invoiceBuckets) global._invoiceBuckets = new Map();
  const now = Date.now();
  let bkt = global._invoiceBuckets.get(uid);
  if (!bkt || now > bkt.r) { bkt = { c: 0, r: now + 60000 }; global._invoiceBuckets.set(uid, bkt); }
  bkt.c++;
  if (bkt.c > 20) return res.status(429).json({ error: 'Trop de requêtes. Attendez 1 minute.' });

  try {
    const { pages, pdfText, fileName } = req.body;

    const hasText = pdfText && pdfText.trim().length > 50;
    const hasImages = pages && Array.isArray(pages) && pages.length > 0;

    if (!hasText && !hasImages) {
      return res.status(400).json({ error: 'Aucune donnée reçue.' });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    async function callWithRetry(params, maxRetries) {
      maxRetries = maxRetries || 3;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          return await client.messages.create(params);
        } catch (err) {
          if ((err.status === 429 || err.name === 'RateLimitError') && attempt < maxRetries - 1) {
            const retryAfter = parseInt(err.headers && err.headers['retry-after']) || 0;
            const delay = retryAfter > 0 ? (retryAfter * 1000 + 2000) : Math.pow(2, attempt) * 5000;
            console.log('[parse-invoice] Rate limit, retry in ' + delay + 'ms');
            await new Promise(function (r) { setTimeout(r, delay); });
            continue;
          }
          throw err;
        }
      }
    }

    const content = [];

    if (hasText) {
      // Text mode — PDF with extractable text
      const truncated = pdfText.length > 60000 ? pdfText.slice(0, 60000) + '\n[tronqué]' : pdfText;
      content.push({ type: 'text', text: 'Facture fournisseur (texte extrait du PDF, fichier: ' + (fileName || 'inconnu') + ') :\n\n' + truncated });
    } else {
      // Vision mode — scanned PDF or image
      const pagesToSend = pages.slice(0, 8); // max 8 pages for an invoice
      for (let i = 0; i < pagesToSend.length; i++) {
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: pagesToSend[i] } });
      }
    }

    const PROMPT = `Tu es un expert en analyse de factures fournisseurs françaises (alimentaire, CHR, épicerie, matières premières).

Analyse cette facture fournisseur et extrais :
1. Le nom du fournisseur (en-tête de la facture — ex : METRO, TRANSGOURMET, POMONA, PROMOCASH...)
2. La date de la facture
3. Le numéro de facture
4. Toutes les lignes de produits avec leur prix unitaire HT

RÈGLES D'EXTRACTION IMPORTANTES :
- Extrais le PRIX UNITAIRE HT de chaque article (pas le total ligne, pas le prix TTC)
- Si seul le prix TTC est visible : HT = TTC / 1.055 (TVA 5,5% aliments), 1.10 (TVA 10% restauration), ou 1.20 (TVA 20% autres)
- Ignore les lignes de totaux généraux, remises globales et lignes de TVA
- Les frais de port peuvent être inclus si c'est une ligne récurrente nommée
- Pour chaque ligne, garde le nom COMPLET du produit tel qu'il apparaît (avec conditionnement si mentionné)
- Référence fournisseur = code article/SKU si présent sur la facture
- Quantité = quantité commandée sur la facture
- Unité = unité du prix unitaire (kg, L, pièce, carton, sac, bidon...)

DÉTECTION DU FOURNISSEUR :
- "supplierConfidence" = "high" si le nom est clairement lisible dans l'en-tête de la page
- "supplierConfidence" = "low" si tu n'es pas certain ou si la facture est illisible

Réponds UNIQUEMENT en JSON brut sans markdown ni backticks :
{
  "supplier": "NOM_FOURNISSEUR",
  "supplierConfidence": "high",
  "invoiceDate": "JJ/MM/AAAA",
  "invoiceNumber": "NUM123",
  "lines": [
    {
      "name": "Farine T55 sac 25kg",
      "reference": "REF123",
      "qty": 2,
      "unit": "sac",
      "unitPriceHT": 18.50,
      "totalHT": 37.00,
      "tvaRate": 5.5
    }
  ]
}

Si aucune ligne n'est trouvée ou si le document n'est pas une facture fournisseur, renvoie lines: [].`;

    content.push({ type: 'text', text: PROMPT });

    // Use Haiku for text (cheaper), Sonnet for vision (better accuracy on images)
    const model = hasText ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-20250514';
    console.log('[parse-invoice] model=' + model + ' mode=' + (hasText ? 'text' : 'vision') + ' file=' + (fileName || '?'));

    const response = await callWithRetry({
      model: model,
      max_tokens: 8000,
      messages: [{ role: 'user', content: content }]
    });

    let raw = '';
    for (let j = 0; j < response.content.length; j++) {
      if (response.content[j].type === 'text') raw += response.content[j].text;
    }

    // Strip potential markdown fences
    raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      console.error('[parse-invoice] JSON parse error:', parseErr.message, 'Raw (first 300):', raw.slice(0, 300));
      return res.status(200).json({ lines: [], supplier: '', supplierConfidence: 'low', parseError: true });
    }

    if (!parsed.lines || !Array.isArray(parsed.lines)) {
      return res.status(200).json({ lines: [], supplier: parsed.supplier || '', supplierConfidence: 'low' });
    }

    // Clean and validate each line
    const clean = [];
    for (let k = 0; k < parsed.lines.length; k++) {
      const l = parsed.lines[k];
      const up = parseFloat(l.unitPriceHT);
      if (isNaN(up) || up <= 0) continue;
      clean.push({
        name: (l.name || '').trim(),
        reference: (l.reference || '').trim(),
        qty: parseFloat(l.qty) || 1,
        unit: (l.unit || '').trim(),
        unitPriceHT: Math.round(up * 10000) / 10000,
        totalHT: Math.round((parseFloat(l.totalHT) || 0) * 100) / 100,
        tvaRate: parseFloat(l.tvaRate) || 20
      });
    }

    console.log('[parse-invoice] Extracted ' + clean.length + ' lines from ' + (fileName || '?'));

    return res.status(200).json({
      supplier: (parsed.supplier || '').trim(),
      supplierConfidence: parsed.supplierConfidence === 'high' ? 'high' : 'low',
      invoiceDate: (parsed.invoiceDate || '').trim(),
      invoiceNumber: (parsed.invoiceNumber || '').trim(),
      lines: clean
    });

  } catch (err) {
    console.error('[parse-invoice] Error:', err);
    return res.status(500).json({ error: 'Erreur serveur: ' + (err.message || 'inconnue') });
  }
};
