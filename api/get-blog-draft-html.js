/**
 * /api/get-blog-draft-html
 *
 * GET ?slug=xxx
 * Retourne { html } d'un brouillon Firestore (pour la preview depuis admin-blog).
 * Le HTML est nettoyé (pas d'injection préalable ici : l'admin-blog s'en
 * occupe côté client avant d'ouvrir le Blob URL).
 *
 * Auth : admin humain (Bearer idToken) uniquement.
 */

const FIREBASE_PROJECT_ID = 'altiora-70599';
const ADMIN_EMAIL = (process.env.BLOG_ADMIN_EMAIL || 'contact@adrienemily.com').toLowerCase();

async function requireHumanAdminAuth(req) {
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!idToken) return { ok: false, status: 401, error: 'Missing Bearer idToken' };
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${process.env.FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  if (!r.ok) return { ok: false, status: 401, error: 'Invalid idToken' };
  const data = await r.json();
  const email = ((data.users || [])[0]?.email || '').toLowerCase();
  if (email !== ADMIN_EMAIL) return { ok: false, status: 403, error: 'Forbidden' };
  return { ok: true, email };
}

async function getAdminToken() {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${process.env.FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.FIREBASE_API_EMAIL, password: process.env.FIREBASE_API_PASSWORD, returnSecureToken: true }),
  });
  if (!r.ok) throw new Error(`Firebase auth failed: ${r.status}`);
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

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const auth = await requireHumanAdminAuth(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const slug = req.query?.slug;
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({ error: 'Missing or invalid slug' });
    }

    const idToken = await getAdminToken();
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/blog_drafts/${encodeURIComponent(slug)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
    if (r.status === 404) return res.status(404).json({ error: 'Draft not found' });
    if (!r.ok) return res.status(500).json({ error: `Firestore GET ${r.status}` });

    const data = await r.json();
    const fields = data.fields || {};
    const html = fromFirestoreValue(fields.html);
    const title = fromFirestoreValue(fields.title);
    if (!html) return res.status(500).json({ error: 'Draft has no html field' });

    return res.status(200).json({ ok: true, slug, title, html });
  } catch (err) {
    console.error('[get-blog-draft-html]', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};
