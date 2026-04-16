/**
 * /api/cron-generate-blog
 *
 * Cron Vercel hebdomadaire (vendredi 9h UTC). Sécurisé par le header
 * `x-cron-secret` injecté par Vercel (env var CRON_SECRET).
 *
 * Workflow :
 *   1. Pioche les 2 sujets prioritaires dans blog_topics avec status='pending'
 *   2. Pour chaque sujet : appelle /api/generate-blog-post (HTTP interne,
 *      avec le même cron secret) → génère le brouillon en Firestore
 *   3. Marque le sujet comme status='processed'
 *   4. Envoie un email récap à l'admin humain via Resend
 *
 * Required env vars:
 *   - CRON_SECRET
 *   - FIREBASE_API_KEY, FIREBASE_API_EMAIL, FIREBASE_API_PASSWORD
 *   - APP_URL (ex: https://alteore.com)
 *   - RESEND_API_KEY, RESEND_FROM
 *   - BLOG_ADMIN_EMAIL (optionnel, défaut contact@adrienemily.com)
 */

const FIREBASE_PROJECT_ID = 'altiora-70599';
const APP_URL = process.env.APP_URL || 'https://alteore.com';
const ADMIN_EMAIL = (process.env.BLOG_ADMIN_EMAIL || 'contact@adrienemily.com').toLowerCase();
const RESEND_FROM = process.env.RESEND_FROM || 'ALTEORE <noreply@alteore.com>';

// Nombre d'articles à générer par exécution cron
const ARTICLES_PER_RUN = 2;

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

async function listPendingTopics(idToken, limit) {
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
      orderBy: [{ field: { fieldPath: 'priority' }, direction: 'ASCENDING' }],
      limit,
    },
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Firestore query failed ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return (data || [])
    .filter((x) => x.document)
    .map((x) => firestoreDocToObject(x.document));
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
// Call to /api/generate-blog-post
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

// ─────────────────────────────────────────────────────────
// Email (Resend)
// ─────────────────────────────────────────────────────────

async function sendRecapEmail(results) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[cron-generate-blog] RESEND_API_KEY absent, email skipped');
    return;
  }

  const ok = results.filter((r) => !r.error);
  const ko = results.filter((r) => r.error);

  const rows = results.map((r) => {
    if (r.error) {
      return `<tr><td style="padding:10px;border-bottom:1px solid #e5e5ea;color:#b33;">❌ ${r.topic}</td><td style="padding:10px;border-bottom:1px solid #e5e5ea;color:#b33;font-size:12px;">${r.error}</td></tr>`;
    }
    return `<tr><td style="padding:10px;border-bottom:1px solid #e5e5ea;"><strong>✓ ${r.title}</strong><br/><span style="color:#6e6e73;font-size:13px;">${r.topic}</span></td><td style="padding:10px;border-bottom:1px solid #e5e5ea;font-size:12px;color:#6e6e73;"><a href="${APP_URL}/admin-blog" style="color:#0071e3;">Voir dans l'admin →</a></td></tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f7;margin:0;padding:40px 20px;">
<div style="max-width:560px;margin:0 auto;background:white;border-radius:14px;padding:36px 32px;box-shadow:0 4px 16px rgba(0,0,0,.06);">
  <h1 style="font-size:22px;margin:0 0 8px;color:#1d1d1f;">📝 ${ok.length} nouveau${ok.length > 1 ? 'x' : ''} brouillon${ok.length > 1 ? 's' : ''} prêt${ok.length > 1 ? 's' : ''}</h1>
  <p style="font-size:14px;color:#6e6e73;margin:0 0 24px;">Cron hebdomadaire Alteore — ${new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <tbody>${rows}</tbody>
  </table>
  <div style="margin-top:28px;text-align:center;">
    <a href="${APP_URL}/admin-blog" style="display:inline-block;background:#0071e3;color:white;text-decoration:none;font-weight:600;padding:12px 28px;border-radius:22px;font-size:14px;">Ouvrir l'admin blog →</a>
  </div>
  ${ko.length ? `<p style="font-size:12px;color:#b33;margin-top:24px;text-align:center;">⚠️ ${ko.length} échec${ko.length > 1 ? 's' : ''} — check blog_topics/ pour voir les erreurs.</p>` : ''}
  <p style="font-size:11px;color:#a1a1a6;margin-top:32px;text-align:center;border-top:1px solid #e5e5ea;padding-top:20px;">Cet email est envoyé automatiquement par le cron /api/cron-generate-blog.</p>
</div>
</body></html>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: ADMIN_EMAIL,
      subject: `📝 ${ok.length} brouillon${ok.length > 1 ? 's' : ''} blog prêt${ok.length > 1 ? 's' : ''} — Alteore`,
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

  // Protection cron secret (header injecté par Vercel automatiquement quand
  // l'env var CRON_SECRET est configurée — également acceptée en body pour
  // tests manuels)
  const providedSecret = req.headers['x-cron-secret']
    || (req.headers.authorization || '').replace('Bearer ', '');
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized (CRON_SECRET mismatch)' });
  }

  try {
    const idToken = await getAdminToken();

    // 1. Pioche les sujets
    const topics = await listPendingTopics(idToken, ARTICLES_PER_RUN);
    if (topics.length === 0) {
      return res.status(200).json({
        ok: true,
        generated: 0,
        message: 'Aucun sujet pending dans blog_topics. Ajoute des sujets ou ré-importe le seed.',
      });
    }

    // 2. Génère en série (pas en parallèle pour éviter pic de rate-limit Claude)
    const results = [];
    for (const t of topics) {
      try {
        const gen = await callGenerate(t.topic, t.metier || 'all', t.category || 'guides', t.length || 'medium');
        await markTopicProcessed(t._id, { slug: gen.slug }, idToken);
        results.push({ topic: t.topic, title: gen.title, slug: gen.slug, tokens: gen.tokens_used });
      } catch (err) {
        await markTopicProcessed(t._id, { error: String(err.message || err).slice(0, 300) }, idToken);
        results.push({ topic: t.topic, error: String(err.message || err).slice(0, 300) });
      }
    }

    // 3. Email récap
    await sendRecapEmail(results).catch((e) => console.warn('[cron-generate-blog] email err:', e.message));

    return res.status(200).json({
      ok: true,
      generated: results.filter((r) => !r.error).length,
      failed: results.filter((r) => r.error).length,
      results,
    });
  } catch (err) {
    console.error('[cron-generate-blog]', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};
