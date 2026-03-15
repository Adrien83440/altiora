// api/server-timestamp.js — Horodatage serveur fiable pour émargements
// Retourne un timestamp serveur (pas manipulable côté client)

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const now = new Date();

  res.status(200).json({
    timestamp: now.getTime(),
    iso: now.toISOString(),
    ip: req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || '—'
  });
};
