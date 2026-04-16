/**
 * /api/delete-blog-draft
 *
 * POST body: { slug }
 * Supprime le brouillon blog_drafts/{slug} dans Firestore.
 * N'affecte pas les articles publiés.
 *
 * Auth : admin humain uniquement.
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

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const auth = await requireHumanAdminAuth(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const { slug } = req.body || {};
    if (!slug || typeof slug !== 'string' || !/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({ error: 'Missing or invalid slug' });
    }

    const idToken = await getAdminToken();
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/blog_drafts/${encodeURIComponent(slug)}`;
    const r = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${idToken}` } });
    if (!r.ok && r.status !== 404) {
      return res.status(500).json({ error: `Firestore DELETE ${r.status}: ${await r.text()}` });
    }

    return res.status(200).json({ ok: true, slug, deleted: r.status !== 404 });
  } catch (err) {
    console.error('[delete-blog-draft]', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};
