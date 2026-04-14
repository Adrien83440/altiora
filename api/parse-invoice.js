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
      const truncated = pdfText.length > 100000 ? pdfText.slice(0, 100000) + '\n[tronqué]' : pdfText;
      content.push({ type: 'text', text: 'Facture fournisseur (texte extrait du PDF, fichier: ' + (fileName || 'inconnu') + ') :\n\n' + truncated });
    } else {
      const pagesToSend = pages.slice(0, 10);
      for (let i = 0; i < pagesToSend.length; i++) {
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: pagesToSend[i] } });
      }
    }

    const PROMPT = `Tu es un expert en analyse de factures fournisseurs françaises pour boulangeries, pâtisseries et restauration (meuneries, grossistes alimentaires, épiceries CHR).

Tu dois extraire les lignes de produits achetés avec leur PRIX PAR COLIS (unité de commande habituelle).

═══════════════════════════════════════
ÉTAPE 1 — IDENTIFIER LE FORMAT DE LA FACTURE
═══════════════════════════════════════

FORMAT A — MEUNERIE (ex: Moulins Joseph Nicot, moulin, minoterie)
Colonnes : Code Produit | Désignation | Quantité Facturée (en QL) | Nbre Unité (nombre de sacs) | Prix HT Brut | Prix HT Net | Montant HT | TVA
• QL = quintal = 100 kg
• Prix HT Net = prix après remises (c'est le bon prix, ignorer Prix HT Brut)
• PRIX PAR SAC = Montant HT ÷ Nbre Unité
• Exemple : BANETTE T65, 16.750 QL, 67 sacs, Montant HT 1321.24 → unitPriceHT = 1321.24 ÷ 67 = 19.72 €/sac

FORMAT B — GROSSISTE/ÉPICERIE (ex: Ducreux, Metro, Transgourmet, Pomona, Promocash)
Colonnes : ARTICLE | DESIGNATION | Qté UC (nombre de colis) | QUANTITE (poids/volume total) | P.U. BRUT | Remise | P.U. NET | Montant HT | T | V
• P.U. NET = prix après remise par unité de QUANTITE (€/kg, €/L, €/pièce...)
• PRIX PAR COLIS = Montant HT ÷ Qté UC
• Exemple : BEURRE DOUX 82% MG 25KG, Qté UC=2 CRT, Montant HT=262.00 → unitPriceHT = 262.00 ÷ 2 = 131.00 €/CRT

═══════════════════════════════════════
ÉTAPE 2 — LIGNES À EXTRAIRE
═══════════════════════════════════════

Pour chaque produit acheté (prix > 0) extraire :
• reference : code article/SKU si visible (ex: "10020025", "OE6065")
• name : désignation complète (avec conditionnement : sac 25kg, bidon 5L, CRT...)
• qty : nombre de colis commandés (Nbre Unité format A, Qté UC format B)
• unit : description du colis (ex: "sac 25kg", "CRT 10kg", "bidon 5L", "CT 360")
• unitPriceHT : prix d'UN colis calculé comme indiqué ci-dessus, arrondi à 4 décimales
• totalHT : Montant HT de la ligne tel qu'indiqué
• tvaRate : 5.5 pour aliments courants, 20 pour emballages/matériel/boissons alcoolisées
• colisQte : quantité numérique dans 1 colis extraite du conditionnement ou de la désignation
  - "Sacs 25 Kgs" → 25 | "CRT 10 KG" → 10 | "bidon 5L" → 5 | "seau 12 KG" → 12
  - "CT 360" (carton de 360 œufs) → 360 | "PCK 24 PCE" → 24
  - Si non déterminable : mettre 1
• colisUnite : unité parmi kg, g, l, ml, pièce, unité — extraite du conditionnement
  - "25 KG" → "kg" | "5L" → "l" | "360 pièces" → "pièce" | "24 PCE" → "pièce"
  - Si non déterminable ou emballage (boîte, carton sans poids) : "pièce"

═══════════════════════════════════════
ÉTAPE 3 — LIGNES À IGNORER ABSOLUMENT
═══════════════════════════════════════

• Lignes GRATUIT (prix = 0 ou mention "GRATUIT")
• Lignes de remises séparées (Rem.parten, Rem.QTE, R.paiement)
• Lignes de descriptions longues sous un article (certifications bio, numéros de lot, DLC)
• Lignes "Taxe" : CVO INAPORC FR, INTERBEV BOVIN FR, INTERBEV VEAU FR, FG DUCREUX...
• Lignes de totaux : Montant net HT, Taux TVA, Montant TVA, Montant TTC, Net à payer
• Pages de CONDITIONS GÉNÉRALES DE VENTE
• Pages de RELEVÉ (tableau récapitulatif des factures précédentes)

═══════════════════════════════════════
RÉPONSE — JSON UNIQUEMENT
═══════════════════════════════════════

JSON brut sans markdown, sans backticks, sans texte avant ou après :
{
  "supplier": "MOULINS JOSEPH NICOT",
  "supplierConfidence": "high",
  "invoiceDate": "10/09/2025",
  "invoiceNumber": "2509000899",
  "lines": [
    {
      "name": "BANETTE 1900 TRAD.T65 NF V30-001 SI - Sacs 25 Kgs",
      "reference": "10020025",
      "qty": 67,
      "unit": "sac 25kg",
      "unitPriceHT": 19.7200,
      "totalHT": 1321.24,
      "tvaRate": 5.5,
      "colisQte": 25,
      "colisUnite": "kg"
    },
    {
      "name": "BEURRE DOUX 82% MG CUBE 25 KG",
      "reference": "15013",
      "qty": 2,
      "unit": "CRT 25kg",
      "unitPriceHT": 131.00,
      "totalHT": 262.00,
      "tvaRate": 5.5,
      "colisQte": 25,
      "colisUnite": "kg"
    }
  ]
}

RÈGLES FINALES :
• supplierConfidence = "high" uniquement si le nom est clairement visible en en-tête, "low" sinon
• Format A : unitPriceHT = Montant HT ÷ Nbre Unité
• Format B : unitPriceHT = Montant HT ÷ Qté UC
• Ne jamais inclure lignes GRATUIT ni Taxe dans lines[]
• Si pas une facture fournisseur : lines: []`;

    content.push({ type: 'text', text: PROMPT });

    const model = hasText ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-20250514';
    console.log('[parse-invoice] model=' + model + ' mode=' + (hasText ? 'text' : 'vision') + ' file=' + (fileName || '?'));

    const response = await callWithRetry({
      model: model,
      max_tokens: 12000,
      messages: [{ role: 'user', content: content }]
    });

    let raw = '';
    for (let j = 0; j < response.content.length; j++) {
      if (response.content[j].type === 'text') raw += response.content[j].text;
    }

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

    const clean = [];
    for (let k = 0; k < parsed.lines.length; k++) {
      const l = parsed.lines[k];
      const up = parseFloat(l.unitPriceHT);
      if (isNaN(up) || up <= 0) continue;
      // Normalize colisUnite to lowercase known values
      const rawUnit = (l.colisUnite || '').toLowerCase().trim();
      const unitMap = { 'kg': 'kg', 'g': 'g', 'l': 'l', 'ml': 'ml', 'litre': 'l', 'litres': 'l', 'kilogramme': 'kg', 'gramme': 'g', 'pièce': 'pièce', 'piece': 'pièce', 'pce': 'pièce', 'unité': 'unité', 'unite': 'unité', 'portion': 'portion' };
      const normalizedUnit = unitMap[rawUnit] || (rawUnit ? rawUnit : 'pièce');
      clean.push({
        name: (l.name || '').trim(),
        reference: (l.reference || '').trim(),
        qty: parseFloat(l.qty) || 1,
        unit: (l.unit || '').trim(),
        unitPriceHT: Math.round(up * 10000) / 10000,
        totalHT: Math.round((parseFloat(l.totalHT) || 0) * 100) / 100,
        tvaRate: parseFloat(l.tvaRate) || 20,
        colisQte: parseFloat(l.colisQte) || 1,
        colisUnite: normalizedUnit
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
