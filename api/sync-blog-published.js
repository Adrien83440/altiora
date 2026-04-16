/**
 * /api/sync-blog-published
 *
 * POST (ou GET) : synchronise Firestore blog_published/ avec l'état réel du
 * repo GitHub.
 *
 * Pour chaque doc Firestore blog_published/{slug} :
 *   - Si blog/{slug}.html n'existe PAS sur GitHub → supprime le doc Firestore
 *     ET nettoie aussi blog.html + sitemap-blog.xml si le slug y apparaît
 *     encore.
 *
 * Ce endpoint réconcilie l'état après une édition manuelle du repo
 * (ex: tu as supprimé un fichier depuis GitHub.com mais Firestore
 * référence toujours l'article comme "publié").
 *
 * Retourne la liste des slugs réconciliés + commit Git s'il y a eu des
 * changements dans blog.html ou sitemap-blog.xml.
 *
 * Auth : admin humain (Bearer idToken) uniquement.
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
  const out = { _id: doc.name ? doc.name.split('/').pop() : null };
  for (const k of Object.keys(doc.fields || {})) out[k] = fromFirestoreValue(doc.fields[k]);
  return out;
}

async function listPublished(idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/blog_published?pageSize=300`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`Firestore list ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return (data.documents || []).map(firestoreDocToObject);
}

async function firestoreDelete(path, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const r = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${idToken}` } });
  if (!r.ok && r.status !== 404) throw new Error(`Firestore DELETE ${path} ${r.status}: ${await r.text()}`);
}

// ─────────────────────────────────────────────────────────
// GitHub helpers
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

async function ghListBlogDir(owner, repo, branch) {
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/contents/blog?ref=${branch}`, { headers: ghHeaders() });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`GitHub list blog/ ${r.status}: ${await r.text()}`);
  const data = await r.json();
  if (!Array.isArray(data)) return [];
  return data.filter((e) => e.type === 'file' && e.name.endsWith('.html')).map((e) => e.name.replace(/\.html$/, ''));
}

async function ghGetRefSha(owner, repo, branch) {
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`, { headers: ghHeaders() });
  if (!r.ok) throw new Error(`GitHub getRef ${r.status}`);
  return (await r.json()).object.sha;
}

async function ghGetCommit(owner, repo, sha) {
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/git/commits/${sha}`, { headers: ghHeaders() });
  if (!r.ok) throw new Error(`GitHub getCommit ${r.status}`);
  return r.json();
}

async function ghGetFile(owner, repo, branch, path) {
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}`, { headers: ghHeaders() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub getFile ${path} ${r.status}`);
  const data = await r.json();
  return { content: Buffer.from(data.content, 'base64').toString('utf-8'), sha: data.sha };
}

async function ghCreateBlob(owner, repo, contentUtf8) {
  const base64 = Buffer.from(contentUtf8, 'utf-8').toString('base64');
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/git/blobs`, {
    method: 'POST', headers: ghHeaders(),
    body: JSON.stringify({ content: base64, encoding: 'base64' }),
  });
  if (!r.ok) throw new Error(`GitHub createBlob ${r.status}`);
  return (await r.json()).sha;
}

async function ghCreateTree(owner, repo, baseTreeSha, changes) {
  const tree = changes.map((c) => ({ path: c.path, mode: '100644', type: 'blob', sha: c.sha }));
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/git/trees`, {
    method: 'POST', headers: ghHeaders(),
    body: JSON.stringify({ base_tree: baseTreeSha, tree }),
  });
  if (!r.ok) throw new Error(`GitHub createTree ${r.status}`);
  return (await r.json()).sha;
}

async function ghCreateCommit(owner, repo, message, treeSha, parentSha) {
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/git/commits`, {
    method: 'POST', headers: ghHeaders(),
    body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] }),
  });
  if (!r.ok) throw new Error(`GitHub createCommit ${r.status}`);
  return (await r.json()).sha;
}

async function ghUpdateRef(owner, repo, branch, commitSha) {
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    method: 'PATCH', headers: ghHeaders(),
    body: JSON.stringify({ sha: commitSha, force: false }),
  });
  if (!r.ok) throw new Error(`GitHub updateRef ${r.status}`);
}

// ─────────────────────────────────────────────────────────
// Mutateurs (identiques à github-unpublish)
// ─────────────────────────────────────────────────────────

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeFromSitemap(currentXml, slug) {
  const url = `https://alteore.com/blog/${slug}`;
  const re = new RegExp('\\s*<url>[\\s\\S]*?<loc>' + escapeRegex(url) + '</loc>[\\s\\S]*?</url>', 'g');
  return currentXml.replace(re, '');
}

function removeFromBlogIndex(currentHtml, slug) {
  const href = `/blog/${slug}`;
  const re = new RegExp('\\s*<a\\s+class="art-card"\\s+href="' + escapeRegex(href) + '"[^>]*>[\\s\\S]*?</a>\\s*', 'g');
  return currentHtml.replace(re, '\n    ');
}

// ─────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const auth = await requireHumanAdminAuth(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const repoEnv = process.env.GITHUB_REPO || '';
    const [owner, repo] = repoEnv.split('/');
    const branch = process.env.GITHUB_BRANCH || 'main';
    if (!owner || !repo) return res.status(500).json({ error: 'GITHUB_REPO env var invalid' });

    const idToken = await getAdminToken();

    // 1. Lister Firestore blog_published + Lister blog/ dans le repo
    const [firestoreSlugs, repoSlugs] = await Promise.all([
      listPublished(idToken),
      ghListBlogDir(owner, repo, branch),
    ]);
    const repoSlugSet = new Set(repoSlugs);
    const orphans = firestoreSlugs.filter((p) => !repoSlugSet.has(p.slug || p._id));

    if (orphans.length === 0) {
      return res.status(200).json({
        ok: true,
        firestore_count: firestoreSlugs.length,
        repo_count: repoSlugs.length,
        orphans: 0,
        message: 'Tout est synchronisé, rien à faire.',
      });
    }

    // 2. Pour chaque orphan, nettoyer blog.html + sitemap si le slug y apparait encore
    const headSha = await ghGetRefSha(owner, repo, branch);
    const headCommit = await ghGetCommit(owner, repo, headSha);
    const baseTreeSha = headCommit.tree.sha;

    const [blogHtml, sitemapBlogXml] = await Promise.all([
      ghGetFile(owner, repo, branch, 'blog.html'),
      ghGetFile(owner, repo, branch, 'sitemap-blog.xml'),
    ]);

    let newBlogHtml = blogHtml ? blogHtml.content : '';
    let newSitemapXml = sitemapBlogXml ? sitemapBlogXml.content : '';

    for (const orphan of orphans) {
      const slug = orphan.slug || orphan._id;
      if (newBlogHtml) newBlogHtml = removeFromBlogIndex(newBlogHtml, slug);
      if (newSitemapXml) newSitemapXml = removeFromSitemap(newSitemapXml, slug);
    }

    const changes = [];
    if (blogHtml && newBlogHtml !== blogHtml.content) {
      changes.push({ path: 'blog.html', sha: await ghCreateBlob(owner, repo, newBlogHtml) });
    }
    if (sitemapBlogXml && newSitemapXml !== sitemapBlogXml.content) {
      changes.push({ path: 'sitemap-blog.xml', sha: await ghCreateBlob(owner, repo, newSitemapXml) });
    }

    let commitSha = null;
    if (changes.length > 0) {
      const treeSha = await ghCreateTree(owner, repo, baseTreeSha, changes);
      const msg = `chore(blog): sync — remove ${orphans.length} orphan${orphans.length > 1 ? 's' : ''} from index & sitemap`;
      commitSha = await ghCreateCommit(owner, repo, msg, treeSha, headSha);
      await ghUpdateRef(owner, repo, branch, commitSha);
    }

    // 3. Supprimer les docs Firestore orphelins
    await Promise.all(orphans.map((o) => firestoreDelete(`blog_published/${o.slug || o._id}`, idToken)));

    return res.status(200).json({
      ok: true,
      firestore_count: firestoreSlugs.length,
      repo_count: repoSlugs.length,
      orphans_cleaned: orphans.length,
      orphans_slugs: orphans.map((o) => o.slug || o._id),
      commitSha,
      commitUrl: commitSha ? `https://github.com/${owner}/${repo}/commit/${commitSha}` : null,
      changes: changes.map((c) => c.path),
    });
  } catch (err) {
    console.error('[sync-blog-published]', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};
