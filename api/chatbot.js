// ╔══════════════════════════════════════════════════════════╗
// ║  ALTEORE — Chatbot API (Vercel Serverless)             ║
// ║  Proxy vers Claude Haiku pour réponses IA               ║
// ║  SÉCURISÉ : CORS + vérification token Firebase          ║
// ╚══════════════════════════════════════════════════════════╝

// ── Vérification du token Firebase côté serveur ──
async function verifyFirebaseToken(idToken) {
  const fbKey = process.env.FIREBASE_API_KEY;
  if (!fbKey) throw new Error('FIREBASE_API_KEY non configurée');
  const res = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + fbKey,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    }
  );
  if (!res.ok) throw new Error('Token invalide');
  const data = await res.json();
  const uid = data.users?.[0]?.localId;
  if (!uid) throw new Error('Utilisateur introuvable');
  return uid;
}

module.exports = async (req, res) => {
  // ── CORS ──
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // ── AUTH : vérifier le token Firebase ──
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    return res.status(401).json({ error: "Token d'authentification manquant.", response: null });
  }

  try {
    await verifyFirebaseToken(token);
  } catch (e) {
    return res.status(401).json({ error: 'Token invalide.', response: null });
  }

  const { messages, system } = req.body || {};
  if (!messages || !messages.length) return res.status(400).json({ error: 'No messages' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[Chatbot] ANTHROPIC_API_KEY manquante');
    return res.status(500).json({ error: 'API key missing', response: null });
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
        max_tokens: 1024,
        system: system || 'Tu es un assistant pour le logiciel ALTEORE. Réponds en français, de façon concise.',
        messages: messages.slice(-10)
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[Chatbot] Claude API error:', response.status, err);
      return res.status(200).json({ response: null, error: 'API error ' + response.status });
    }

    const data = await response.json();
    const text = (data.content || []).map(c => c.text || '').join('\n').trim();

    return res.status(200).json({ response: text || null });
  } catch (e) {
    console.error('[Chatbot] Exception:', e.message);
    return res.status(200).json({ response: null, error: e.message });
  }
};
