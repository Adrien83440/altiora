/**
 * api/stock-scan-ai.js
 * Proxy Vercel — Scan de bons de livraison / factures fournisseurs
 * Claude Sonnet Vision extrait les lignes produit
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY manquante' });

  try {
    const { image, mediaType, existingRefs } = req.body;
    if (!image) return res.status(400).json({ error: 'Image manquante' });

    const refsContext = existingRefs && existingRefs.length
      ? `\nRÉFÉRENCES EXISTANTES dans le stock du client (essaie de matcher) :\n${existingRefs.slice(0, 200).map(r => `${r.ref} — ${r.name}`).join('\n')}`
      : '';

    const prompt = `Tu es un assistant spécialisé dans l'extraction de données de bons de livraison, factures fournisseurs et tickets de réception.

Analyse cette image et extrais TOUTES les lignes de produits que tu vois.
${refsContext}

Réponds UNIQUEMENT en JSON valide (pas de markdown, pas de backticks) :
{
  "docType": "bon_livraison|facture|ticket|autre",
  "fournisseur": "nom du fournisseur si visible",
  "date": "YYYY-MM-DD si visible, sinon null",
  "numero": "numéro du document si visible",
  "lignes": [
    {
      "ref": "référence/code article si visible",
      "designation": "nom du produit",
      "quantite": <nombre>,
      "unite": "unité si visible (kg, pce, L, etc.)",
      "prixUnitaireHT": <prix unitaire HT si visible, sinon null>,
      "totalHT": <total ligne HT si visible, sinon null>,
      "tva": <taux TVA si visible, sinon null>,
      "matchedRef": "<référence existante la plus proche si trouvée, sinon null>"
    }
  ],
  "totalHT": <total document HT si visible>,
  "totalTTC": <total TTC si visible>,
  "confidence": <0-1 confiance globale>,
  "notes": "remarques éventuelles"
}

RÈGLES :
- Extrais TOUTES les lignes même si certaines infos manquent
- Si le document est flou ou partiellement lisible, extrais ce que tu peux
- Les prix peuvent être en format français (virgule décimale)
- Convertis les virgules en points dans les nombres
- Si tu vois un code-barres, mets-le dans ref
- matchedRef = la ref existante du stock qui correspond le mieux (même produit)`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: 'Erreur API', details: errText });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';

    let result;
    try {
      result = JSON.parse(text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
    } catch (e) {
      result = { lignes: [], confidence: 0, notes: 'Erreur parsing: ' + e.message, raw: text };
    }

    return res.status(200).json(result);

  } catch (err) {
    console.error('stock-scan-ai error:', err);
    return res.status(500).json({ error: err.message });
  }
}
