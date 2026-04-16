/**
 * /api/github-unpublish
 *
 * POST body: { slug }
 *
 * Dépublie un article précédemment publié :
 *   1. Lit blog_published/{slug} dans Firestore (pour récupérer les infos)
 *   2. Via l'API GitHub (Git Trees, commit atomique) :
 *      - Supprime /blog/{slug}.html
 *      - Met à jour /blog.html (retire la carte de l'article)
 *      - Met à jour /sitemap-blog.xml (retire l'URL)
 *   3. Supprime le doc Firestore blog_published/{slug}
 *   4. Retourne { ok, commitSha, commitUrl }
 *
 * Auth : admin humain (Bearer idToken) uniquement.
 *
 * Required env vars:
 *   - GITHUB_TOKEN, GITHUB_REPO (ex: "Adrien83440/altiora"), GITHUB_BRANCH
 *   - FIREBASE_API_KEY, FIREBASE_API_EMAIL, FIREBASE_API_PASSWORD
 */

const FIREBASE_PROJECT_ID = 'altiora-70599';
const ADMIN_EMAIL = (process.env.BLOG_ADMIN_EMAIL || 'contact@adrienemily.com').toLowerCase();

// ─────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────
// Firebase helpers
// ─────────────────────────────────────────────────────────

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

function firestoreDocToObject(doc) {
  const out = {};
  for (const k of Object.keys(doc.fields || {})) out[k] = fromFirestoreValue(doc.fields[k]);
  return out;
}

async function firestoreGet(path, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Firestore GET ${path} ${r.status}: ${await r.text()}`);
  return firestoreDocToObject(await r.json());
}

async function firestoreDelete(path, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const r = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${idToken}` } });
  if (!r.ok && r.status !== 404) throw new Error(`Firestore DELETE ${path} ${r.status}: ${await r.text()}`);
}

// ─────────────────────────────────────────────────────────
// GitHub API helpers
// ─────────────────────────────────────────────────────────

const GH_API = 'https://api.github.com';

function ghHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'alteore-blog-publisher',
    'Content-Type': 'application/json',
  };
}

async function ghGetRefSha(owner, repo, branch) {
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`, { headers: ghHeaders() });
  if (!r.ok) throw new Error(`GitHub getRef ${r.status}: ${await r.text()}`);
  return (await r.json()).object.sha;
}

async function ghGetCommit(owner, repo, sha) {
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/git/commits/${sha}`, { headers: ghHeaders() });
  if (!r.ok) throw new Error(`GitHub getCommit ${r.status}: ${await r.text()}`);
  return r.json();
}

async function ghGetFile(owner, repo, branch, path) {
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}`, { headers: ghHeaders() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub getFile ${path} ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const buf = Buffer.from(data.content, 'base64');
  return { content: buf.toString('utf-8'), sha: data.sha };
}

async function ghCreateBlob(owner, repo, contentUtf8) {
  const base64 = Buffer.from(contentUtf8, 'utf-8').toString('base64');
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/git/blobs`, {
    method: 'POST',
    headers: ghHeaders(),
    body: JSON.stringify({ content: base64, encoding: 'base64' }),
  });
  if (!r.ok) throw new Error(`GitHub createBlob ${r.status}: ${await r.text()}`);
  return (await r.json()).sha;
}

async function ghCreateTree(owner, repo, baseTreeSha, changes) {
  // changes: [{ path, sha (blob) | null pour delete }]
  const tree = changes.map((c) => {
    if (c.sha === null) {
      // null sha = suppression
      return { path: c.path, mode: '100644', type: 'blob', sha: null };
    }
    return { path: c.path, mode: '100644', type: 'blob', sha: c.sha };
  });
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    headers: ghHeaders(),
    body: JSON.stringify({ base_tree: baseTreeSha, tree }),
  });
  if (!r.ok) throw new Error(`GitHub createTree ${r.status}: ${await r.text()}`);
  return (await r.json()).sha;
}

async function ghCreateCommit(owner, repo, message, treeSha, parentSha) {
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    headers: ghHeaders(),
    body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] }),
  });
  if (!r.ok) throw new Error(`GitHub createCommit ${r.status}: ${await r.text()}`);
  return (await r.json()).sha;
}

async function ghUpdateRef(owner, repo, branch, commitSha) {
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    headers: ghHeaders(),
    body: JSON.stringify({ sha: commitSha, force: false }),
  });
  if (!r.ok) throw new Error(`GitHub updateRef ${r.status}: ${await r.text()}`);
}

// ─────────────────────────────────────────────────────────
// Mutateurs
// ─────────────────────────────────────────────────────────

function removeFromSitemap(currentXml, slug) {
  const url = `https://alteore.com/blog/${slug}`;
  // Supprime le bloc <url>...<loc>url</loc>...</url>
  const re = new RegExp(
    '\\s*<url>[\\s\\S]*?<loc>' + url.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + '</loc>[\\s\\S]*?</url>',
    'g'
  );
  return currentXml.replace(re, '');
}

function removeFromBlogIndex(currentHtml, slug) {
  const href = `/blog/${slug}`;
  // Supprime le bloc <a class="art-card" href="/blog/<slug>" data-cats="...">...</a>
  // jusqu'à la balise fermante </a> correspondante
  const re = new RegExp(
    '\\s*<a\\s+class="art-card"\\s+href="' + href.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + '"[^>]*>[\\s\\S]*?</a>\\s*',
    'g'
  );
  return currentHtml.replace(re, '\n    ');
}

// ─────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────

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

    const repoEnv = process.env.GITHUB_REPO || '';
    const [owner, repo] = repoEnv.split('/');
    const branch = process.env.GITHUB_BRANCH || 'main';
    if (!owner || !repo) return res.status(500).json({ error: 'GITHUB_REPO env var invalid' });
    if (!process.env.GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN env var missing' });

    const idToken = await getAdminToken();

    // Vérifier que l'article est bien référencé dans Firestore (tolère absence si on fait du ménage)
    const published = await firestoreGet(`blog_published/${slug}`, idToken);

    // 1. Récup HEAD
    const headSha = await ghGetRefSha(owner, repo, branch);
    const headCommit = await ghGetCommit(owner, repo, headSha);
    const baseTreeSha = headCommit.tree.sha;

    // 2. Récup fichiers actuels
    const [articleFile, blogHtml, sitemapBlogXml] = await Promise.all([
      ghGetFile(owner, repo, branch, `blog/${slug}.html`),
      ghGetFile(owner, repo, branch, 'blog.html'),
      ghGetFile(owner, repo, branch, 'sitemap-blog.xml'),
    ]);

    if (!blogHtml) return res.status(500).json({ error: 'blog.html not found in repo' });
    if (!sitemapBlogXml) return res.status(500).json({ error: 'sitemap-blog.xml not found in repo' });

    // 3. Préparer les modifs
    const changes = [];

    // 3a. Supprimer blog/{slug}.html si existe
    if (articleFile) {
      changes.push({ path: `blog/${slug}.html`, sha: null });
    }

    // 3b. Maj blog.html (retirer la carte si présente)
    const newBlogHtml = removeFromBlogIndex(blogHtml.content, slug);
    if (newBlogHtml !== blogHtml.content) {
      const blob = await ghCreateBlob(owner, repo, newBlogHtml);
      changes.push({ path: 'blog.html', sha: blob });
    }

    // 3c. Maj sitemap-blog.xml (retirer l'URL si présente)
    const newSitemapXml = removeFromSitemap(sitemapBlogXml.content, slug);
    if (newSitemapXml !== sitemapBlogXml.content) {
      const blob = await ghCreateBlob(owner, repo, newSitemapXml);
      changes.push({ path: 'sitemap-blog.xml', sha: blob });
    }

    if (changes.length === 0) {
      // Rien à supprimer côté Git. On nettoie quand même Firestore si besoin.
      if (published) await firestoreDelete(`blog_published/${slug}`, idToken);
      return res.status(200).json({
        ok: true,
        slug,
        message: 'Nothing to remove in Git (files already clean). Firestore cleaned if needed.',
        commitSha: null,
      });
    }

    // 4. Tree + commit atomique + push
    const treeSha = await ghCreateTree(owner, repo, baseTreeSha, changes);
    const commitMessage = `revert(blog): unpublish ${slug}\n\n${published?.title || slug}`;
    const newCommitSha = await ghCreateCommit(owner, repo, commitMessage, treeSha, headSha);
    await ghUpdateRef(owner, repo, branch, newCommitSha);

    // 5. Nettoyer Firestore
    if (published) await firestoreDelete(`blog_published/${slug}`, idToken);

    return res.status(200).json({
      ok: true,
      slug,
      commitSha: newCommitSha,
      commitUrl: `https://github.com/${owner}/${repo}/commit/${newCommitSha}`,
      changes: changes.map((c) => ({ path: c.path, action: c.sha === null ? 'delete' : 'update' })),
    });
  } catch (err) {
    console.error('[github-unpublish]', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};
