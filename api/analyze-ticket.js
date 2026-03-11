// api/analyze-ticket.js
// Proxy Vercel pour l'analyse de tickets de caisse via Claude Vision
// Appelé depuis client-fidelite.html quand l'API key n'est pas dispo côté client

export default async function handler(req, res) {
  // CORS — la page client est sur le même domaine Vercel
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, imageType } = req.body || {};

  if (!imageBase64) {
    return res.status(400).json({ error: 'imageBase64 requis' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Clé API non configurée' });
  }

  try {
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
        system: 'Tu analyses des tickets de caisse. Réponds UNIQUEMENT en JSON valide, sans markdown, sans explication. Format exact : {"montant": <nombre décimal ou null>, "date": "<JJ/MM/AAAA ou null>", "numero": "<numéro ticket ou null>", "enseigne": "<nom boutique ou null>", "erreur": "<message si illisible ou null>"}',
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: imageType || 'image/jpeg',
                data: imageBase64
              }
            },
            {
              type: 'text',
              text: 'Extrais du ticket : montant total TTC, date, numéro de ticket (ou de transaction), nom de l\'enseigne. Si le document n\'est pas un ticket de caisse valide, mets erreur = "Ce document ne semble pas être un ticket de caisse". Si tu ne peux pas lire le montant total, mets erreur = "Montant illisible, veuillez réessayer avec une meilleure photo".'
            }
          ]
        }]
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error('Anthropic API error:', errData);
      return res.status(502).json({ error: 'Erreur API Anthropic', detail: errData.error?.message });
    }

    const data = await response.json();
    let text = '';
    if (data.content && data.content[0] && data.content[0].text) {
      text = data.content[0].text.trim().replace(/```json|```/g, '').trim();
    }

    const parsed = JSON.parse(text);
    return res.status(200).json(parsed);

  } catch (e) {
    console.error('analyze-ticket error:', e.message);
    return res.status(500).json({ error: 'Erreur analyse : ' + e.message });
  }
}
