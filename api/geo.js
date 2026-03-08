// api/geo.js — Géolocalisation par IP via ip-api.com
// Appel côté serveur Vercel → pas de restriction HTTPS/CORS
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store'); // pas de cache : chaque IP est différente

  // Récupérer l'IP réelle du client (Vercel ajoute x-forwarded-for)
  const forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded
    ? forwarded.split(',')[0].trim()
    : req.headers['x-real-ip'] || '';

  // Ne pas passer d'IP si localhost/interne (ip-api utilise alors l'IP appelante)
  const isLocal = !ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.');
  const target = isLocal ? '' : ip;

  try {
    const url = `http://ip-api.com/json/${target}?lang=fr&fields=status,lat,lon,city,regionName,country`;
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error('ip-api error ' + r.status);
    const data = await r.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ status: 'fail', message: e.message });
  }
}
