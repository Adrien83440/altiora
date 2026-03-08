// api/geocode-cp.js
// Géocode un code postal français via Nominatim (OpenStreetMap)
// Appelé depuis le dashboard pour éviter les restrictions CORS du navigateur

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { cp } = req.query;

  if (!cp || !/^\d{4,5}$/.test(cp.trim())) {
    return res.status(400).json({ error: 'Code postal invalide' });
  }

  try {
    const url = `https://nominatim.openstreetmap.org/search?postalcode=${cp.trim()}&country=fr&format=json&limit=1&accept-language=fr`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Alteore/1.0 (contact@alteore.com)' },
      signal: AbortSignal.timeout(5000)
    });
    const data = await r.json();

    if (!data || !data[0]) {
      return res.status(404).json({ error: 'Code postal introuvable' });
    }

    const city = data[0].display_name.split(',')[0].trim();

    return res.status(200).json({
      lat: parseFloat(data[0].lat).toFixed(4),
      lon: parseFloat(data[0].lon).toFixed(4),
      city
    });

  } catch (e) {
    console.error('[geocode-cp] Error:', e);
    return res.status(500).json({ error: 'Erreur géocodage' });
  }
}
