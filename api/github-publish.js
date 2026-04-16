/**
 * /api/github-publish
 *
 * POST body: { slug }
 *
 * Steps:
 *   1. Lit le draft depuis Firestore: blog_drafts/{slug}
 *   2. Récupère le HEAD de la branche main sur GitHub
 *   3. Lit les fichiers actuels /blog.html et /sitemap-blog.xml via l'API GitHub
 *   4. Construit les 3 nouveaux fichiers :
 *      - /blog/{slug}.html (nouveau)
 *      - /sitemap-blog.xml (maj : ajoute la nouvelle URL)
 *      - /blog.html (maj : injecte la carte dans le bloc ARTICLES-LIST)
 *   5. Crée les 3 blobs, un tree, un commit, push sur main (Git Trees API)
 *   6. Déplace le doc Firestore blog_drafts → blog_published
 *   7. Retourne { ok, commitSha, commitUrl, publishedUrl }
 *
 * Required env vars:
 *   - GITHUB_TOKEN (fine-grained PAT: Contents R/W on altiora repo)
 *   - GITHUB_REPO  (ex: "Adrien83440/altiora")
 *   - GITHUB_BRANCH (ex: "main")
 *   - FIREBASE_API_KEY, FIREBASE_API_EMAIL, FIREBASE_API_PASSWORD
 */

const FIREBASE_PROJECT_ID = 'altiora-70599';

// ─────────────────────────────────────────────────────────
// Firebase helpers
// ─────────────────────────────────────────────────────────

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

function firestoreDocToObject(doc) {
  const out = {};
  for (const k of Object.keys(doc.fields || {})) out[k] = fromFirestoreValue(doc.fields[k]);
  return out;
}

function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const k of Object.keys(v)) fields[k] = toFirestoreValue(v[k]);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function buildFirestoreDoc(obj) {
  const fields = {};
  for (const k of Object.keys(obj)) fields[k] = toFirestoreValue(obj[k]);
  return { fields };
}

async function firestoreGet(path, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Firestore GET ${path} ${r.status}: ${await r.text()}`);
  return firestoreDocToObject(await r.json());
}

async function firestoreWrite(collection, docId, obj, idToken) {
  const patchUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${encodeURIComponent(docId)}`;
  const r = await fetch(patchUrl, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(buildFirestoreDoc(obj)),
  });
  if (!r.ok) throw new Error(`Firestore PATCH ${collection}/${docId} ${r.status}: ${await r.text()}`);
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
  // Retourne { content (decoded utf-8), sha } ou null si le fichier n'existe pas
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
  // changes: [{ path, sha (blob) }]
  const tree = changes.map((c) => ({
    path: c.path,
    mode: '100644',
    type: 'blob',
    sha: c.sha,
  }));
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
// Sitemap & blog.html updaters
// ─────────────────────────────────────────────────────────

function updateSitemapBlog(currentXml, draft) {
  const url = `https://alteore.com/blog/${draft.slug}`;
  const todayIso = new Date().toISOString().slice(0, 10);

  // Si l'URL est déjà présente, ne rien faire
  if (currentXml.includes(`<loc>${url}</loc>`)) return currentXml;

  const newEntry = `
  <url>
    <loc>${url}</loc>
    <lastmod>${todayIso}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
`;

  // Insérer avant </urlset>
  return currentXml.replace('</urlset>', `${newEntry}</urlset>`);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function updateBlogIndex(currentHtml, draft) {
  const url = `/blog/${draft.slug}`;
  // Évite doublon
  if (currentHtml.includes(`href="${url}"`)) return currentHtml;

  const pubDateFr = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  // data-cats : catégorie + métier
  const cats = `${draft.category || 'guides'} ${draft.metier && draft.metier !== 'all' ? draft.metier : ''}`.trim();

  const card = `    <a class="art-card" href="${url}" data-cats="${escapeHtml(cats)}">
      <div class="art-card-img" aria-hidden="true">${escapeHtml(draft.hero_emoji || '📰')}</div>
      <div class="art-card-body">
        <div class="art-card-cat">${escapeHtml(draft.category_label || 'Guide')}</div>
        <div class="art-card-t">${escapeHtml(draft.title)}</div>
        <div class="art-card-d">${escapeHtml(draft.meta_description)}</div>
        <div class="art-card-meta">
          <span>${pubDateFr}</span>
          <span class="art-card-meta-sep"></span>
          <span>${draft.reading_time_min || 7} min de lecture</span>
        </div>
      </div>
    </a>
`;

  // Insérer juste après <!-- ARTICLES-LIST-START --> pour que le plus récent apparaisse en premier
  const marker = '<!-- ARTICLES-LIST-START -->';
  const idx = currentHtml.indexOf(marker);
  if (idx === -1) throw new Error('Marker ARTICLES-LIST-START introuvable dans blog.html');
  const insertPos = idx + marker.length + 1; // +1 pour le \n
  return currentHtml.slice(0, insertPos) + card + currentHtml.slice(insertPos);
}

// ─────────────────────────────────────────────────────────
// Auth: admin humain uniquement (la publication n'est pas automatisée)
// ─────────────────────────────────────────────────────────

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
  if (email !== ADMIN_EMAIL) return { ok: false, status: 403, error: 'Forbidden (email mismatch)' };
  return { ok: true, email };
}

// ─────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // 🔐 Auth check
    const auth = await requireHumanAdminAuth(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const { slug } = req.body || {};
    if (!slug || typeof slug !== 'string' || !/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({ error: 'Missing or invalid "slug" (a-z, 0-9, -)' });
    }

    const repoEnv = process.env.GITHUB_REPO || '';
    const [owner, repo] = repoEnv.split('/');
    const branch = process.env.GITHUB_BRANCH || 'main';
    if (!owner || !repo) {
      return res.status(500).json({ error: 'GITHUB_REPO env var invalid (expected "owner/repo")' });
    }
    if (!process.env.GITHUB_TOKEN) {
      return res.status(500).json({ error: 'GITHUB_TOKEN env var missing' });
    }

    // 1. Lire le draft Firestore
    const idToken = await getAdminToken();
    const draft = await firestoreGet(`blog_drafts/${slug}`, idToken);
    if (!draft) return res.status(404).json({ error: `Draft blog_drafts/${slug} not found` });
    if (!draft.html) return res.status(500).json({ error: 'Draft missing html field' });

    // 2. Récupérer HEAD de main
    const headSha = await ghGetRefSha(owner, repo, branch);
    const headCommit = await ghGetCommit(owner, repo, headSha);
    const baseTreeSha = headCommit.tree.sha;

    // 3. Lire les fichiers actuels
    const [blogHtml, sitemapBlogXml] = await Promise.all([
      ghGetFile(owner, repo, branch, 'blog.html'),
      ghGetFile(owner, repo, branch, 'sitemap-blog.xml'),
    ]);
    if (!blogHtml) return res.status(500).json({ error: 'blog.html not found in repo' });
    if (!sitemapBlogXml) return res.status(500).json({ error: 'sitemap-blog.xml not found in repo' });

    // 4. Construire les nouveaux contenus
    const newArticlePath = `blog/${slug}.html`;
    const newArticleContent = draft.html;
    const newBlogHtml = updateBlogIndex(blogHtml.content, draft);
    const newSitemapXml = updateSitemapBlog(sitemapBlogXml.content, draft);

    // 5. Créer 3 blobs en parallèle
    const [articleBlob, blogBlob, sitemapBlob] = await Promise.all([
      ghCreateBlob(owner, repo, newArticleContent),
      ghCreateBlob(owner, repo, newBlogHtml),
      ghCreateBlob(owner, repo, newSitemapXml),
    ]);

    // 6. Créer tree + commit + push
    const treeSha = await ghCreateTree(owner, repo, baseTreeSha, [
      { path: newArticlePath, sha: articleBlob },
      { path: 'blog.html', sha: blogBlob },
      { path: 'sitemap-blog.xml', sha: sitemapBlob },
    ]);
    const commitMessage = `feat(blog): publish ${slug}\n\n${draft.title}`;
    const newCommitSha = await ghCreateCommit(owner, repo, commitMessage, treeSha, headSha);
    await ghUpdateRef(owner, repo, branch, newCommitSha);

    // 7. Déplacer Firestore draft → published
    const publishedAt = new Date().toISOString();
    await firestoreWrite('blog_published', slug, {
      slug: draft.slug,
      title: draft.title,
      meta_description: draft.meta_description,
      category: draft.category || 'guides',
      category_label: draft.category_label || 'Guide',
      metier: draft.metier || 'all',
      hero_emoji: draft.hero_emoji || '📰',
      reading_time_min: draft.reading_time_min || 7,
      generated_at: draft.generated_at,
      published_at: publishedAt,
      topic_requested: draft.topic_requested || '',
      github_commit: newCommitSha,
      url: `https://alteore.com/blog/${slug}`,
      tokens_input: draft.tokens_input || 0,
      tokens_output: draft.tokens_output || 0,
    }, idToken);

    await firestoreDelete(`blog_drafts/${slug}`, idToken);

    return res.status(200).json({
      ok: true,
      slug,
      commitSha: newCommitSha,
      commitUrl: `https://github.com/${owner}/${repo}/commit/${newCommitSha}`,
      publishedUrl: `https://alteore.com/blog/${slug}`,
    });
  } catch (err) {
    console.error('[github-publish]', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};
