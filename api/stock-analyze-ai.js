/**
 * api/stock-analyze-ai.js
 * Analyse IA du stock — rotation, écoulement, cashflow, recommandations
 */
import { cors, verifyAuth, rateLimit } from './_auth.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await verifyAuth(req, res);
  if (!auth) return;
  if (rateLimit(auth.uid, res, 5)) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY manquante' });

  try {
    const { stockData } = req.body;
    if (!stockData) return res.status(400).json({ error: 'Données stock manquantes' });

    const prompt = `Tu es un expert en gestion de stock pour TPE/PME françaises (commerces, boutiques, restaurants). Analyse les données de stock suivantes et donne des conseils actionnables.

DONNÉES DU STOCK :
${JSON.stringify(stockData, null, 2)}

Réponds UNIQUEMENT en JSON valide (pas de markdown, pas de backticks) :
{
  "scoreStock": <0-100 score global de gestion du stock>,
  "scoreLabel": "<Excellent|Bon|Correct|À améliorer|Critique>",
  "diagnostic": "<1-2 phrases résumant la situation du stock>",
  "insights": [
    {
      "icon": "<emoji>",
      "type": "<success|warning|danger|info|tip>",
      "title": "<titre court>",
      "text": "<analyse détaillée 2-3 phrases, avec chiffres précis tirés des données>"
    }
  ],
  "actions": [
    {
      "icon": "<emoji>",
      "priority": "<high|medium|low>",
      "title": "<action concrète>",
      "detail": "<comment faire, pourquoi, impact estimé>"
    }
  ],
  "metricsCommentary": {
    "rotation": "<commentaire sur la rotation du stock, bon/mauvais et pourquoi>",
    "valorisation": "<commentaire sur la valeur immobilisée, trop/pas assez>",
    "alertes": "<commentaire sur les ruptures et seuils>",
    "abc": "<commentaire sur la répartition ABC si disponible>",
    "cashflow": "<impact du stock sur le BFR et la trésorerie>"
  },
  "topActions": [
    "<action prioritaire 1 en 1 phrase>",
    "<action prioritaire 2 en 1 phrase>",
    "<action prioritaire 3 en 1 phrase>"
  ]
}

RÈGLES :
- 4 à 7 insights, triés par importance
- 3 à 5 actions concrètes
- Utilise les VRAIS chiffres des données (valeur stock, nb ruptures, rotation, etc.)
- Si rotation faible (< 2×/an) → alerte sur immobilisation de trésorerie
- Si beaucoup de ruptures → quantifie le manque à gagner potentiel
- Si stock dormant (pas de mouvement depuis 30+ jours) → recommande déstockage
- Si marge faible sur certains produits → recommande révision prix ou fournisseurs
- Compare le stock à des ratios sectoriels courants (stock/CA idéal = 15-25% pour commerce)
- Sois direct et actionnable, pas de blabla générique`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
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
      result = { scoreStock: 50, scoreLabel: 'Indisponible', diagnostic: 'Analyse en erreur', insights: [], actions: [], raw: text };
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('stock-analyze-ai error:', err);
    return res.status(500).json({ error: err.message });
  }
}
