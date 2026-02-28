// api/rh-planning-ai.js — Proxy ALTEORE Planning RH IA → Claude API (Sonnet)
// Appelé via fetch('/api/rh-planning-ai') depuis rh-planning.html

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { prompt, max_tokens } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt required' });
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
        model: 'claude-sonnet-4-20250514',
        max_tokens: max_tokens || 3000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!apiResponse.ok) {
      const errText = await apiResponse.text();
      console.error('Claude API error:', apiResponse.status, errText);
      return res.status(502).json({ error: 'AI service error', details: apiResponse.status });
    }

    const data = await apiResponse.json();
    const text = data.content
      ?.filter(b => b.type === 'text')
      ?.map(b => b.text)
      ?.join('\n') || '';

    return res.status(200).json({ text, usage: data.usage || null });

  } catch (error) {
    console.error('RH Planning AI error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}
