/**
 * api/generate-rh-doc.js
 * Proxy Vercel pour l'API Anthropic — Module Documents RH
 * Evite les erreurs CORS lors des appels depuis le navigateur
 */

export default async function handler(req, res) {
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configuree dans les variables Vercel' });
  }

  try {
    const { prompt, docName } = req.body;

    if (!prompt || !docName) {
      return res.status(400).json({ error: 'Parametre prompt ou docName manquant' });
    }

    // Limite de taille pour eviter les abus
    if (prompt.length > 8000) {
      return res.status(400).json({ error: 'Prompt trop long' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2500,
        system: 'Tu es un expert juridique RH specialise dans le droit du travail francais. Tu generes des documents RH professionnels, conformes et adaptes a la situation specifique. Tu rediges uniquement le document demande, sans commentaire ni introduction.',
        messages: [
          { role: 'user', content: prompt }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(response.status).json({
        error: 'Erreur API Anthropic',
        details: errText
      });
    }

    const data = await response.json();
    const content = data.content?.[0]?.text || '';

    return res.status(200).json({ content });

  } catch (err) {
    console.error('generate-rh-doc error:', err);
    return res.status(500).json({ error: 'Erreur serveur', details: err.message });
  }
}
