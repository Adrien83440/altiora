/**
 * /api/list-blog-posts
 *
 * GET ?status=draft|published|all (default: all)
 *
 * Retourne la liste des brouillons et/ou articles publiés depuis Firestore.
 * Utilisé par /admin-blog.html pour afficher la file de publication.
 *
 * Required env vars:
 *   - FIREBASE_API_KEY, FIREBASE_API_EMAIL, FIREBASE_API_PASSWORD
 */

const FIREBASE_PROJECT_ID = 'altiora-70599';

async function getAdminToken() {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${process.env.FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.FIREBASE_API_EMAIL,
      password: process.env.FIREBASE_API_PASSWORD,
      returnSecureToken: true,
    }),
  });
  if (!r.ok) throw new Error(`Firebase auth failed: ${r.status} ${await r.text()}`);
  return (await r.json()).idToken;
}

function fromFirestoreValue(v) {
  if (!v || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in v) {
    const out = {};
    for (const k of Object.keys(v.mapValue.fields || {})) out[k] = fromFirestoreValue(v.mapValue.fields[k]);
    return out;
  }
  return v;
}

function firestoreDocToObject(doc, documentName) {
  const out = { _id: documentName ? documentName.split('/').pop() : null };
  for (const k of Object.keys(doc.fields || {})) out[k] = fromFirestoreValue(doc.fields[k]);
  return out;
}

async function listCollection(collection, idToken) {
  // pageSize max 300 pour cette API
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}?pageSize=300`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  if (!r.ok) {
    // Collection empty → 200 with empty response normally
    if (r.status === 404) return [];
    throw new Error(`Firestore list ${collection} ${r.status}: ${await r.text()}`);
  }
  const data = await r.json();
  if (!data.documents) return [];
  return data.documents.map((d) => firestoreDocToObject(d, d.name));
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const status = (req.query?.status || 'all').toLowerCase();
    const idToken = await getAdminToken();

    const [drafts, published] = await Promise.all([
      status === 'published' ? Promise.resolve([]) : listCollection('blog_drafts', idToken),
      status === 'draft' ? Promise.resolve([]) : listCollection('blog_published', idToken),
    ]);

    // Don't return the full html blob to avoid huge payloads
    const lightDrafts = drafts.map((d) => {
      const { html, article_json, ...rest } = d;
      return { ...rest, has_html: !!html };
    }).sort((a, b) => String(b.generated_at || '').localeCompare(String(a.generated_at || '')));

    const lightPublished = published.map((p) => {
      const { html, article_json, ...rest } = p;
      return rest;
    }).sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));

    return res.status(200).json({
      ok: true,
      drafts: lightDrafts,
      published: lightPublished,
      counts: {
        drafts: lightDrafts.length,
        published: lightPublished.length,
      },
    });
  } catch (err) {
    console.error('[list-blog-posts]', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};
