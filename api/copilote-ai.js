/**
 * api/copilote-ai.js
 * Proxy Vercel — Copilote IA business quotidien
 * Analyse croisée de toutes les données métier
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
    const { metrics, prenom } = req.body;
    if (!metrics) return res.status(400).json({ error: 'Metrics manquantes' });

    const now = new Date();
    const mois = now.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    const jour = now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

    const prompt = `Tu es le copilote IA d'un chef d'entreprise TPE/PME français. Tu analyses ses données et tu lui donnes un briefing quotidien concis, actionnable et personnalisé. Tutoie-le.

Date : ${jour}
${prenom ? 'Prénom : ' + prenom : ''}

DONNÉES DE L'ENTREPRISE :
${JSON.stringify(metrics, null, 2)}

CONSIGNES :
- Réponds UNIQUEMENT en JSON valide (pas de markdown, pas de backticks)
- Structure exacte requise :
{
  "score": <nombre 0-100 score santé global>,
  "scoreLabel": "<Excellent|Bon|Correct|Attention|Critique>",
  "greeting": "<salutation personnalisée courte avec le prénom si dispo, ex: Bonjour Adrien ! ou Bonne journée !>",
  "headline": "<phrase principale du briefing, 1 ligne max, percutante>",
  "insights": [
    {"icon": "<emoji>", "type": "<success|warning|danger|info|tip>", "text": "<insight concis et actionnable, max 2 phrases>"}
  ],
  "actions": [
    {"icon": "<emoji>", "priority": "<high|medium|low>", "text": "<action concrète recommandée>", "link": "<page.html ou null>"}
  ],
  "kpiComment": "<commentaire sur l'évolution des KPIs, 1-2 phrases>"
}

RÈGLES :
- 3 à 5 insights maximum, triés par importance
- 2 à 3 actions concrètes maximum
- Sois direct, pas de blabla. Donne des chiffres précis.
- Si le CA baisse, dis pourquoi (si tu peux le déduire) et quoi faire
- Si stock en rupture, quantifie l'impact potentiel
- Si charges augmentent vs CA, alerte
- Si un employé dépasse les heures légales, alerte urgente
- Si la trésorerie est tendue, propose des actions
- Adapte le ton : encourageant si tout va bien, direct et sérieux si problème
- Le score doit refléter la santé réelle : rentabilité, trésorerie, stock, conformité`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
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
      const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      result = JSON.parse(cleaned);
    } catch (e) {
      result = { score: 50, scoreLabel: 'Indisponible', greeting: 'Bonjour !', headline: 'Briefing temporairement indisponible', insights: [], actions: [], kpiComment: '', raw: text };
    }

    return res.status(200).json(result);

  } catch (err) {
    console.error('copilote-ai error:', err);
    return res.status(500).json({ error: err.message });
  }
}
