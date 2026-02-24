// api/news.js — Proxy RSS Le Monde Économie
// Appel côté serveur → pas de restriction CORS
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600'); // cache 10 min

  const RSS_URL = 'https://www.lemonde.fr/economie/rss_full.xml';

  try {
    const r = await fetch(RSS_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Alteore/1.0)' },
      signal: AbortSignal.timeout(6000)
    });
    if (!r.ok) throw new Error('RSS fetch error ' + r.status);
    const xml = await r.text();

    // Parser le XML RSS manuellement (pas de dépendance externe)
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < 5) {
      const block = match[1];
      const title  = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                      block.match(/<title>(.*?)<\/title>/))?.[1] || '';
      const link   = (block.match(/<link>(.*?)<\/link>/) ||
                      block.match(/<guid>(.*?)<\/guid>/))?.[1] || '';
      const pubDate= block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
      if (title) items.push({ title: title.trim(), link: link.trim(), pubDate: pubDate.trim() });
    }

    res.status(200).json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message, items: [] });
  }
}
