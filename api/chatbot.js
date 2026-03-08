// api/chatbot.js — Proxy ALTEORE Chatbot → Claude API (Haiku)
// ⚠️ CE FICHIER DOIT S'APPELER chatbot.js DANS LE DOSSIER /api/
// Le widget appelle fetch('/api/chatbot') → Vercel route vers /api/chatbot.js

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { messages, system, uid } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages required' });
    }

    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY not configured');
      return res.status(500).json({ error: 'API key not configured' });
    }

    const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: system || '',
        messages: messages.map(m => ({ role: m.role, content: m.content }))
      })
    });

    if (!apiResponse.ok) {
      const errText = await apiResponse.text();
      console.error('Claude API error:', apiResponse.status, errText);
      return res.status(502).json({ error: 'AI service error', details: apiResponse.status });
    }

    const data = await apiResponse.json();
    const responseText = data.content
      ?.filter(block => block.type === 'text')
      ?.map(block => block.text)
      ?.join('\n') || '';

    return res.status(200).json({ response: responseText, usage: data.usage || null });

  } catch (error) {
    console.error('Chatbot API error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
