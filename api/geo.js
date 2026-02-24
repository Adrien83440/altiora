// api/geo.js — Géolocalisation par IP via ip-api.com
// Appel côté serveur Vercel → pas de restriction HTTPS/CORS
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300'); // cache 5 min

  // Récupérer l'IP réelle du client
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    '';

  try {
    const url = `http://ip-api.com/json/${ip}?lang=fr&fields=status,lat,lon,city,regionName`;
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error('ip-api error ' + r.status);
    const data = await r.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ status: 'fail', message: e.message });
  }
}
