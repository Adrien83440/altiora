// ╔══════════════════════════════════════════════════════════╗
// ║  ALTEORE — Chatbot API (Vercel Serverless)             ║
// ║  Proxy vers Claude Haiku pour réponses IA               ║
// ╚══════════════════════════════════════════════════════════╝

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { messages, system, uid } = req.body || {};
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
        messages: messages.slice(-10) // Garder les 10 derniers messages max
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
