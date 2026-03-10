/**
 * api/vocal-ai.js
 * Proxy Vercel — Assistant vocal business
 * Reçoit une question + métriques, répond en texte court (pour Speech Synthesis)
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
    const { question, metrics, prenom } = req.body;
    if (!question) return res.status(400).json({ error: 'Question manquante' });

    const prompt = `Tu es un assistant vocal business pour un chef d'entreprise TPE/PME français. Il te pose une question à voix haute et tu dois répondre comme si tu parlais — phrases courtes, naturelles, directes. Tutoie-le.

${prenom ? 'Son prénom : ' + prenom : ''}

SES DONNÉES ACTUELLES :
${JSON.stringify(metrics, null, 2)}

SA QUESTION : "${question}"

CONSIGNES :
- Réponds en 2-4 phrases maximum, comme à l'oral
- Donne des chiffres précis tirés de ses données
- Sois direct et concret
- Pas de formules de politesse excessives
- Si tu ne peux pas répondre avec les données dispo, dis-le simplement
- Utilise "euros" en toutes lettres (pas €) pour la lecture vocale
- Pas de listes à puces, que du texte fluide`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: 'Erreur API', details: errText });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || 'Désolé, je n\'ai pas pu analyser ta question.';

    return res.status(200).json({ answer: text });

  } catch (err) {
    console.error('vocal-ai error:', err);
    return res.status(500).json({ error: err.message });
  }
}
