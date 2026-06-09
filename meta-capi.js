// api/meta-capi.js — Conversions API Meta (côté serveur Vercel)
// Reçoit l'event du navigateur (même event_id que le pixel → dédup) et le relaie à Meta.
// Le token n'est JAMAIS dans le code client : il vit dans la variable d'env META_CAPI_TOKEN.

const DATASET_ID = '2069940677253298';   // = ton ID pixel / jeu de données
const GRAPH_VERSION = 'v21.0';
const ALLOWED_ORIGINS = ['https://alteore.com', 'https://www.alteore.com'];

export default async function handler(req, res) {
  // CORS (au cas où www et apex ne soient pas le même origin)
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.META_CAPI_TOKEN;
  if (!token) return res.status(500).json({ error: 'META_CAPI_TOKEN manquant' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const {
      event_name = 'PageView',
      event_id,
      event_source_url,
      fbp,
      fbc
    } = body;

    // IP + User-Agent réels du visiteur (Vercel ajoute x-forwarded-for)
    const fwd = req.headers['x-forwarded-for'];
    const ip = fwd ? fwd.split(',')[0].trim() : (req.headers['x-real-ip'] || '');
    const ua = req.headers['user-agent'] || '';

    const user_data = {
      client_ip_address: ip,
      client_user_agent: ua
    };
    if (fbp) user_data.fbp = fbp;
    if (fbc) user_data.fbc = fbc;

    const payload = {
      data: [
        {
          event_name,
          event_time: Math.floor(Date.now() / 1000),
          event_id,                       // ⚠️ identique à l'eventID du pixel → dédup
          event_source_url,
          action_source: 'website',
          user_data
        }
      ]
      // test_event_code: 'TESTxxxxx'     // à décommenter pour tester dans Events Manager
    };

    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${DATASET_ID}/events?access_token=${token}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await r.json();

    if (!r.ok) return res.status(502).json({ error: 'Meta API', detail: data });
    return res.status(200).json({ ok: true, events_received: data.events_received ?? null });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
