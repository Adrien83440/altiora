// api/analyze-ticket.js
// Proxy Vercel pour l'analyse de tickets de caisse via Claude Vision
// SÉCURISÉ : rate limiting par IP + limite taille image

// ── Rate limiting en mémoire (par IP) ──
const _rlMap = new Map();
function _checkRateLimit(ip, res, maxPerMin = 5) {
  const now = Date.now();
  let bucket = _rlMap.get(ip);
  if (!bucket || now > bucket.reset) {
    bucket = { count: 0, reset: now + 60000 };
    _rlMap.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > maxPerMin) {
    res.status(429).json({ error: 'Trop de requêtes. Réessayez dans 1 minute.' });
    return true;
  }
  // Nettoyage périodique (évite fuite mémoire)
  if (_rlMap.size > 5000) {
    for (const [key, val] of _rlMap) {
      if (now > val.reset) _rlMap.delete(key);
    }
  }
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Rate limiting par IP ──
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (_checkRateLimit(ip, res, 15)) return;

  const { imageBase64, imageType } = req.body || {};

  if (!imageBase64) {
    return res.status(400).json({ error: 'imageBase64 requis' });
  }

  // ── Limite de taille (max ~4MB base64 = ~3MB image) ──
  if (imageBase64.length > 4 * 1024 * 1024) {
    return res.status(413).json({ error: 'Image trop volumineuse (max 3 Mo)' });
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
            { type: 'text', text: 'Analyse ce ticket de caisse. Extrais le montant total, la date, le numéro de ticket et le nom de l\'enseigne.' }
          ]
        }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Claude API error:', data);
      return res.status(500).json({ error: 'Erreur API IA', details: data.error?.message });
    }

    const text = data.content?.[0]?.text || '{}';
    try {
      const parsed = JSON.parse(text);
      return res.status(200).json(parsed);
    } catch {
      return res.status(200).json({ raw: text, erreur: 'Réponse non-JSON' });
    }

  } catch (e) {
    console.error('analyze-ticket error:', e);
    return res.status(500).json({ error: e.message });
  }
}
