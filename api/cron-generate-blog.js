/**
 * /api/cron-generate-blog
 *
 * Cron Vercel hebdomadaire (vendredi 9h UTC). Sécurisé par CRON_SECRET
 * (Vercel l'injecte en `Authorization: Bearer <secret>` ; le header
 * `x-cron-secret` est aussi accepté pour les tests manuels).
 *
 * Workflow (100% automatique) :
 *   1. Pioche les sujets `status='pending'` dans blog_topics
 *      (filtre simple, tri par priority fait côté serverless —
 *       AUCUN index composite Firestore requis)
 *   2. Pour chaque sujet : appelle /api/generate-blog-post (HTTP interne,
 *      x-cron-secret) → génère le brouillon en Firestore
 *   3. PUBLIE automatiquement via /api/github-publish (x-cron-secret)
 *      → commit GitHub → rebuild Vercel → article en ligne
 *   4. Marque le sujet status='processed' (ou 'error')
 *   5. Envoie TOUJOURS un email récap à l'admin (succès, échecs,
 *      et alerte si la file de sujets est vide)
 *
 * Required env vars:
 *   - CRON_SECRET
 *   - FIREBASE_API_KEY, FIREBASE_API_EMAIL, FIREBASE_API_PASSWORD
 *   - APP_URL (ex: https://alteore.com)
 *   - GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH (utilisés par github-publish)
 *   - RESEND_API_KEY, RESEND_FROM
 *   - BLOG_ADMIN_EMAIL (optionnel, défaut contact@adrienemily.com)
 */

const FIREBASE_PROJECT_ID = 'altiora-70599';
const APP_URL = process.env.APP_URL || 'https://alteore.com';
const ADMIN_EMAIL = (process.env.BLOG_ADMIN_EMAIL || 'contact@adrienemily.com').toLowerCase();
const RESEND_FROM = process.env.RESEND_FROM || 'ALTEORE <noreply@alteore.com>';

// Nombre d'articles à générer + publier par exécution cron
const ARTICLES_PER_RUN = 2;

// Nombre max de sujets pending récupérés (triés ensuite par priority)
const TOPICS_FETCH_LIMIT = 50;

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
  const out = { _id: doc.name ? doc.name.split('/').pop() : null };
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

/**
 * Récupère les sujets pending.
 *
 * IMPORTANT : la requête ne contient QUE le filtre d'égalité status='pending'
 * (pas de orderBy) pour ne pas exiger d'index composite Firestore —
 * c'était la cause du plantage silencieux du cron (FAILED_PRECONDITION 400).
 * Le tri par priority est fait ici, en mémoire.
 */
async function listPendingTopics(idToken, count) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'blog_topics' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'status' },
          op: 'EQUAL',
          value: { stringValue: 'pending' },
        },
      },
      limit: TOPICS_FETCH_LIMIT,
    },
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Firestore query failed ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const topics = (data || [])
    .filter((x) => x.document)
    .map((x) => firestoreDocToObject(x.document));
  // Tri par priority croissante (les sujets sans priority passent en dernier)
  topics.sort((a, b) => (a.priority ?? 9999) - (b.priority ?? 9999));
  return topics.slice(0, count);
}

async function markTopicProcessed(topicId, extra, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/blog_topics/${encodeURIComponent(topicId)}?updateMask.fieldPaths=status&updateMask.fieldPaths=processed_at&updateMask.fieldPaths=generated_slug&updateMask.fieldPaths=error`;
  const fields = {
    status: toFirestoreValue(extra.error ? 'error' : 'processed'),
    processed_at: toFirestoreValue(new Date().toISOString()),
    generated_slug: toFirestoreValue(extra.slug || ''),
    error: toFirestoreValue(extra.error || ''),
  };
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) console.warn(`[cron-generate-blog] markTopicProcessed ${topicId}: ${r.status}`);
}

// ─────────────────────────────────────────────────────────
// Appels HTTP internes (generate + publish)
// ─────────────────────────────────────────────────────────

async function callGenerate(topic, metier, category, length) {
  const r = await fetch(`${APP_URL}/api/generate-blog-post`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cron-secret': process.env.CRON_SECRET,
    },
    body: JSON.stringify({ topic, metier, category, length }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `generate-blog-post ${r.status}`);
  return data;
}

async function callPublish(slug) {
  const r = await fetch(`${APP_URL}/api/github-publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cron-secret': process.env.CRON_SECRET,
    },
    body: JSON.stringify({ slug }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `github-publish ${r.status}`);
  return data;
}

// ─────────────────────────────────────────────────────────
// Email (Resend) — envoyé à CHAQUE exécution
// ─────────────────────────────────────────────────────────

async function sendRecapEmail(results, pendingLeft) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[cron-generate-blog] RESEND_API_KEY absent, email skipped');
    return;
  }

  const published = results.filter((r) => r.publishedUrl);
  const draftOnly = results.filter((r) => !r.publishedUrl && !r.error);
  const ko = results.filter((r) => r.error);
  const emptyQueue = results.length === 0;

  let subject;
  if (emptyQueue) {
    subject = '⚠️ Blog Alteore : plus aucun sujet en file — ajoute des sujets';
  } else if (ko.length && !published.length && !draftOnly.length) {
    subject = `❌ Blog Alteore : ${ko.length} échec${ko.length > 1 ? 's' : ''} de génération`;
  } else {
    subject = `📝 ${published.length} article${published.length > 1 ? 's' : ''} publié${published.length > 1 ? 's' : ''} automatiquement — Alteore`;
  }

  const rows = results.map((r) => {
    if (r.error) {
      return `<tr><td style="padding:10px;border-bottom:1px solid #e5e5ea;color:#b33;">❌ ${r.topic}</td><td style="padding:10px;border-bottom:1px solid #e5e5ea;color:#b33;font-size:12px;">${r.error}</td></tr>`;
    }
    if (r.publishedUrl) {
      return `<tr><td style="padding:10px;border-bottom:1px solid #e5e5ea;"><strong>✅ ${r.title}</strong><br/><span style="color:#6e6e73;font-size:13px;">${r.topic}</span></td><td style="padding:10px;border-bottom:1px solid #e5e5ea;font-size:12px;"><a href="${r.publishedUrl}" style="color:#0071e3;">Voir l'article en ligne →</a></td></tr>`;
    }
    // Généré mais publication échouée → reste en brouillon
    return `<tr><td style="padding:10px;border-bottom:1px solid #e5e5ea;"><strong>⚠️ ${r.title}</strong><br/><span style="color:#6e6e73;font-size:13px;">Généré mais NON publié (${r.publishError || 'erreur publication'}) — publie-le depuis l'admin</span></td><td style="padding:10px;border-bottom:1px solid #e5e5ea;font-size:12px;"><a href="${APP_URL}/admin-blog.html" style="color:#0071e3;">Ouvrir l'admin →</a></td></tr>`;
  }).join('');

  const emptyBlock = emptyQueue
    ? `<div style="background:#fff4e5;border:1px solid #ffd9a0;border-radius:10px;padding:16px;margin-bottom:20px;font-size:14px;color:#8a5a00;">La file <strong>blog_topics</strong> ne contient plus aucun sujet <code>pending</code>. Ajoute des sujets depuis l'admin blog (ou ré-importe le seed) pour que la publication automatique reprenne vendredi prochain.</div>`
    : '';

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f7;margin:0;padding:40px 20px;">
<div style="max-width:560px;margin:0 auto;background:white;border-radius:14px;padding:36px 32px;box-shadow:0 4px 16px rgba(0,0,0,.06);">
  <h1 style="font-size:22px;margin:0 0 8px;color:#1d1d1f;">${emptyQueue ? '⚠️ File de sujets vide' : `📝 Publication automatique du blog`}</h1>
  <p style="font-size:14px;color:#6e6e73;margin:0 0 24px;">Cron hebdomadaire Alteore — ${new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
  ${emptyBlock}
  ${rows ? `<table style="width:100%;border-collapse:collapse;font-size:14px;"><tbody>${rows}</tbody></table>` : ''}
  <p style="font-size:13px;color:#6e6e73;margin-top:20px;">Sujets restants en file : <strong>${pendingLeft}</strong></p>
  <div style="margin-top:28px;text-align:center;">
    <a href="${APP_URL}/admin-blog.html" style="display:inline-block;background:#0071e3;color:white;text-decoration:none;font-weight:600;padding:12px 28px;border-radius:22px;font-size:14px;">Ouvrir l'admin blog →</a>
  </div>
  <p style="font-size:11px;color:#a1a1a6;margin-top:32px;text-align:center;border-top:1px solid #e5e5ea;padding-top:20px;">Cet email est envoyé automatiquement par le cron /api/cron-generate-blog.</p>
</div>
</body></html>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: ADMIN_EMAIL,
      subject,
      html,
    }),
  });
  if (!r.ok) console.warn(`[cron-generate-blog] Resend email failed ${r.status}: ${await r.text()}`);
}

// ─────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // Vercel cron peut appeler en GET ou POST selon les versions
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Protection cron secret (Vercel envoie `Authorization: Bearer <CRON_SECRET>`
  // automatiquement quand l'env var CRON_SECRET est configurée — le header
  // x-cron-secret est aussi accepté pour les tests manuels)
  const providedSecret = req.headers['x-cron-secret']
    || (req.headers.authorization || '').replace('Bearer ', '');
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized (CRON_SECRET mismatch)' });
  }

  try {
    const idToken = await getAdminToken();

    // 1. Pioche les sujets (tri par priority fait côté code, pas d'index requis)
    const topics = await listPendingTopics(idToken, ARTICLES_PER_RUN);

    // Estimation des sujets restants après ce run (pour l'email récap)
    let pendingLeft = 0;
    try {
      const all = await listPendingTopics(idToken, TOPICS_FETCH_LIMIT);
      pendingLeft = Math.max(0, all.length - topics.length);
    } catch (e) { /* non bloquant */ }

    if (topics.length === 0) {
      // File vide → email d'alerte pour qu'Adrien ajoute des sujets
      await sendRecapEmail([], 0).catch((e) => console.warn('[cron-generate-blog] email err:', e.message));
      return res.status(200).json({
        ok: true,
        generated: 0,
        published: 0,
        message: 'Aucun sujet pending dans blog_topics. Email d\'alerte envoyé.',
      });
    }

    // 2. Génère + publie en série (pas en parallèle : rate-limit Claude +
    //    les commits GitHub doivent être séquentiels pour ne pas se marcher dessus)
    const results = [];
    for (const t of topics) {
      const entry = { topic: t.topic };
      try {
        // 2a. Génération du brouillon
        const gen = await callGenerate(t.topic, t.metier || 'all', t.category || 'guides', t.length || 'medium');
        entry.title = gen.title;
        entry.slug = gen.slug;
        entry.tokens = gen.tokens_used;

        // 2b. Publication automatique (GitHub commit → rebuild Vercel)
        try {
          const pub = await callPublish(gen.slug);
          entry.publishedUrl = pub.publishedUrl;
          entry.commitUrl = pub.commitUrl;
        } catch (pubErr) {
          // Le brouillon existe en Firestore → publiable manuellement depuis l'admin
          entry.publishError = String(pubErr.message || pubErr).slice(0, 300);
          console.warn(`[cron-generate-blog] publish failed for ${gen.slug}:`, entry.publishError);
        }

        await markTopicProcessed(t._id, { slug: gen.slug }, idToken);
      } catch (err) {
        entry.error = String(err.message || err).slice(0, 300);
        await markTopicProcessed(t._id, { error: entry.error }, idToken);
      }
      results.push(entry);
    }

    // 3. Email récap (toujours envoyé)
    await sendRecapEmail(results, pendingLeft).catch((e) => console.warn('[cron-generate-blog] email err:', e.message));

    return res.status(200).json({
      ok: true,
      generated: results.filter((r) => !r.error).length,
      published: results.filter((r) => r.publishedUrl).length,
      failed: results.filter((r) => r.error).length,
      results,
    });
  } catch (err) {
    console.error('[cron-generate-blog]', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};
