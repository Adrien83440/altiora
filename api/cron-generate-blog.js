/**
 * /api/cron-generate-blog
 *
 * Cron Vercel bi-hebdomadaire (MARDI et VENDREDI 9h UTC — cf. vercel.json
 * `0 9 * * 2,5`). Sécurisé par CRON_SECRET (Vercel l'injecte en
 * `Authorization: Bearer <secret>` ; `x-cron-secret` accepté pour tests).
 *
 * Pipeline 100% AUTONOME — aucune intervention humaine requise :
 *   0. Si la file blog_topics contient moins de TOPIC_REFILL_THRESHOLD
 *      sujets 'pending', Claude génère lui-même une fournée de
 *      TOPIC_BATCH_SIZE nouveaux sujets ciblés dirigeants TPE/PME
 *      (métiers + thèmes pilotage équilibrés, doublons exclus grâce à
 *      l'historique complet des sujets déjà traités/publiés).
 *      → La file ne se vide JAMAIS.
 *   1. Pioche le sujet 'pending' le plus prioritaire
 *   2. Génère l'article via /api/generate-blog-post (HTTP interne)
 *   3. PUBLIE automatiquement via /api/github-publish
 *      → commit GitHub → rebuild Vercel → article en ligne
 *   4. Marque le sujet status='processed' (ou 'error')
 *   5. Envoie TOUJOURS un email récap à l'admin
 *
 * Les sujets ajoutés MANUELLEMENT (Firestore ou admin) restent prioritaires :
 * il suffit de leur donner un champ `priority` plus bas que les sujets auto.
 *
 * Required env vars:
 *   - CRON_SECRET
 *   - ANTHROPIC_API_KEY
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

// 1 article par exécution — le cron tourne 2x/semaine (mardi + vendredi)
const ARTICLES_PER_RUN = 1;

// Auto-réapprovisionnement de la file de sujets
const TOPIC_REFILL_THRESHOLD = 4;   // si moins de 4 sujets pending → on regénère
const TOPIC_BATCH_SIZE = 12;        // taille d'une fournée de nouveaux sujets
const TOPICS_FETCH_LIMIT = 300;     // historique complet pour la déduplication

// Modèle utilisé pour la génération de SUJETS (léger — quelques centaines de
// tokens, ~1 fois toutes les 6 semaines). Même modèle que les articles pour
// garantir un ID valide.
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

// ─────────────────────────────────────────────────────────
// Connaissance produit Alteore injectée dans la génération de sujets.
// (Données PRODUIT uniquement — jamais de données clients.)
// ─────────────────────────────────────────────────────────
const ALTEORE_CONTEXT = `Alteore (alteore.com) est un SaaS français de gestion et de pilotage pour TPE/PME, commerçants et artisans.
Modules : pilotage financier (CA quotidien multi-TVA 5,5/10/20, charges fixes/variables, résultat net temps réel), marges et coût de revient par produit/plat/prestation, trésorerie et prévisions (plan de trésorerie, scénarios), connexion bancaire Open Banking DSP2 (300+ banques), gestion de stock, dettes et crédits, fidélisation clients (programme digital + campagnes SMS), RH complet (contrats, plannings, congés, pointages, émargements, conventions collectives CCN/IDCC), analyse IA de bilans comptables PDF, agent IA Léa.
Cibles : restaurateurs, boulangers-pâtissiers, boutiques/retail, salons de coiffure, artisans du bâtiment, agences et services.
Plans : Pro 69€/mois, Max 99€/mois, Master 169€/mois, essai gratuit 15 jours sans CB.
Concurrents fréquemment comparés : Axonaut, Pennylane, Obat, Planity, logiciels de caisse, Excel.`;

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

function buildFirestoreDoc(obj) {
  const fields = {};
  for (const k of Object.keys(obj)) fields[k] = toFirestoreValue(obj[k]);
  return { fields };
}

/**
 * Récupère TOUS les sujets (tous statuts) — sert à la fois à :
 *   - trouver les 'pending' à traiter,
 *   - constituer la liste anti-doublons pour la génération de sujets.
 * Requête sans filtre ni orderBy → AUCUN index composite requis.
 */
async function listAllTopics(idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'blog_topics' }],
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
  return (data || [])
    .filter((x) => x.document)
    .map((x) => firestoreDocToObject(x.document));
}

/** Titres déjà publiés (anti-doublons complémentaire). */
async function listPublishedTitles(idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
  const body = { structuredQuery: { from: [{ collectionId: 'blog_published' }], limit: 200 } };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) return []; // non bloquant
  const data = await r.json();
  return (data || [])
    .filter((x) => x.document)
    .map((x) => firestoreDocToObject(x.document))
    .map((d) => d.title || d.topic_requested || '')
    .filter(Boolean);
}

async function writeTopic(topicObj, idToken) {
  // POST sans documentId → ID auto-généré par Firestore
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/blog_topics`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(buildFirestoreDoc(topicObj)),
  });
  if (!r.ok) throw new Error(`Firestore write topic ${r.status}: ${await r.text()}`);
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
// AUTO-GÉNÉRATION DE SUJETS (Claude)
// ─────────────────────────────────────────────────────────

const TOPICS_SYSTEM_PROMPT = `Tu es responsable éditorial SEO du blog d'ALTEORE. Tu génères des SUJETS d'articles de blog en français, destinés aux dirigeants de TPE/PME français : restaurateurs, boulangers, commerçants, coiffeurs, artisans du bâtiment, agences.

${ALTEORE_CONTEXT}

Objectifs SEO :
- Mixer les intentions : ~50% guides pratiques de gestion/pilotage (marges, trésorerie, seuil de rentabilité, coût de revient, prix de vente, masse salariale, saisonnalité/intersaison, stocks), ~25% comparatifs bottom-funnel (vs concurrents, alternatives, "Excel vs logiciel", "quel logiciel pour..."), ~25% réglementation française 2026 utile au dirigeant (TVA, CCN/IDCC, URSSAF, facture électronique, obligations employeur).
- Couvrir TOUS les métiers cibles de façon équilibrée dans la fournée (au moins 1 sujet par métier), plus quelques sujets transverses (metier "all").
- Formuler chaque sujet comme une vraie requête/problématique de dirigeant, spécifique et chiffrable, avec l'année 2026 quand pertinent.
- INTERDIT de proposer un sujet identique ou très proche d'un sujet de la liste "déjà traités" fournie.

Tu réponds UNIQUEMENT avec un tableau JSON valide, sans texte autour, sans markdown :
[
  {"topic": "Sujet complet et spécifique", "metier": "restaurant|boulangerie|boutique|coiffeur|artisan|agence|all", "category": "guides|comparatifs|reglementation", "length": "short|medium|long"}
]`;

async function generateNewTopics(existingTitles) {
  const userPrompt = `Génère exactement ${TOPIC_BATCH_SIZE} nouveaux sujets d'articles.

Sujets déjà traités (NE PAS reproposer, ni de variantes proches) :
${existingTitles.slice(0, 200).map((t) => `- ${t}`).join('\n') || '- (aucun)'}

Retourne UNIQUEMENT le tableau JSON.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 3000,
      system: TOPICS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!r.ok) throw new Error(`Claude topics API ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Claude topics : pas de bloc text');

  let raw = textBlock.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  let topics;
  try {
    topics = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Claude topics : JSON invalide (${e.message})`);
  }
  if (!Array.isArray(topics)) throw new Error('Claude topics : la réponse n\'est pas un tableau');

  const VALID_METIERS = ['restaurant', 'boulangerie', 'boutique', 'coiffeur', 'artisan', 'agence', 'all'];
  const VALID_CATS = ['guides', 'comparatifs', 'reglementation'];
  return topics
    .filter((t) => t && typeof t.topic === 'string' && t.topic.length > 10)
    .map((t) => ({
      topic: t.topic.trim().slice(0, 220),
      metier: VALID_METIERS.includes(t.metier) ? t.metier : 'all',
      category: VALID_CATS.includes(t.category) ? t.category : 'guides',
      length: ['short', 'medium', 'long'].includes(t.length) ? t.length : 'medium',
    }))
    .slice(0, TOPIC_BATCH_SIZE);
}

/**
 * Si la file pending est trop basse, génère et enregistre une fournée.
 * Renvoie le nombre de sujets ajoutés (0 si pas nécessaire ou en cas d'échec
 * — l'échec est non bloquant tant qu'il reste au moins 1 sujet pending).
 */
async function refillTopicsIfNeeded(allTopics, idToken) {
  const pendingCount = allTopics.filter((t) => t.status === 'pending').length;
  if (pendingCount >= TOPIC_REFILL_THRESHOLD) return { added: 0 };

  // Anti-doublons : tous les sujets connus (tous statuts) + titres publiés
  const known = allTopics.map((t) => t.topic).filter(Boolean);
  let published = [];
  try { published = await listPublishedTitles(idToken); } catch (e) { /* non bloquant */ }
  const existingTitles = [...new Set([...known, ...published])];

  const newTopics = await generateNewTopics(existingTitles);
  if (!newTopics.length) throw new Error('Génération de sujets : fournée vide');

  // Priorité : à la suite des priorités existantes (les sujets manuels à
  // priorité basse restent servis en premier)
  const maxPriority = allTopics.reduce((m, t) => Math.max(m, Number(t.priority) || 0), 0);
  const nowIso = new Date().toISOString();
  let added = 0;
  for (let i = 0; i < newTopics.length; i++) {
    await writeTopic({
      ...newTopics[i],
      priority: maxPriority + 1 + i,
      status: 'pending',
      source: 'auto',
      created_at: nowIso,
    }, idToken);
    added++;
  }
  return { added, samples: newTopics.slice(0, 3).map((t) => t.topic) };
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

async function sendRecapEmail(results, pendingLeft, refill) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[cron-generate-blog] RESEND_API_KEY absent, email skipped');
    return;
  }

  const published = results.filter((r) => r.publishedUrl);
  const ko = results.filter((r) => r.error);

  let subject;
  if (results.length === 0) {
    subject = '❌ Blog Alteore : aucun sujet disponible et la regénération a échoué';
  } else if (ko.length && !published.length) {
    subject = `❌ Blog Alteore : échec de génération`;
  } else if (published.length) {
    subject = `📝 Article publié automatiquement : ${published[0].title} — Alteore`;
  } else {
    subject = `⚠️ Blog Alteore : article généré mais non publié — action requise`;
  }

  const rows = results.map((r) => {
    if (r.error) {
      return `<tr><td style="padding:10px;border-bottom:1px solid #e5e5ea;color:#b33;">❌ ${r.topic}</td><td style="padding:10px;border-bottom:1px solid #e5e5ea;color:#b33;font-size:12px;">${r.error}</td></tr>`;
    }
    if (r.publishedUrl) {
      return `<tr><td style="padding:10px;border-bottom:1px solid #e5e5ea;"><strong>✅ ${r.title}</strong><br/><span style="color:#6e6e73;font-size:13px;">${r.topic}</span></td><td style="padding:10px;border-bottom:1px solid #e5e5ea;font-size:12px;"><a href="${r.publishedUrl}" style="color:#0071e3;">Voir l'article en ligne →</a></td></tr>`;
    }
    return `<tr><td style="padding:10px;border-bottom:1px solid #e5e5ea;"><strong>⚠️ ${r.title}</strong><br/><span style="color:#6e6e73;font-size:13px;">Généré mais NON publié (${r.publishError || 'erreur publication'}) — publie-le depuis l'admin</span></td><td style="padding:10px;border-bottom:1px solid #e5e5ea;font-size:12px;"><a href="${APP_URL}/admin-blog.html" style="color:#0071e3;">Ouvrir l'admin →</a></td></tr>`;
  }).join('');

  const refillBlock = (refill && refill.added > 0)
    ? `<div style="background:#eef7ee;border:1px solid #bfe3bf;border-radius:10px;padding:14px 16px;margin:18px 0 0;font-size:13px;color:#1a6b1a;">🤖 File de sujets réapprovisionnée automatiquement : <strong>${refill.added} nouveaux sujets</strong> générés par l'IA.<br/><span style="color:#3c7a3c;">Ex : ${(refill.samples || []).join(' · ')}</span></div>`
    : '';

  const failBlock = (results.length === 0)
    ? `<div style="background:#fdecec;border:1px solid #f5c2c2;border-radius:10px;padding:14px 16px;margin:0 0 18px;font-size:13px;color:#8a1f1f;">La file de sujets est vide ET la regénération automatique a échoué${refill && refill.error ? ` (${refill.error})` : ''}. Vérifie ANTHROPIC_API_KEY dans Vercel ou ajoute un sujet manuellement dans blog_topics.</div>`
    : '';

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f7;margin:0;padding:40px 20px;">
<div style="max-width:560px;margin:0 auto;background:white;border-radius:14px;padding:36px 32px;box-shadow:0 4px 16px rgba(0,0,0,.06);">
  <h1 style="font-size:22px;margin:0 0 8px;color:#1d1d1f;">📝 Blog automatique Alteore</h1>
  <p style="font-size:14px;color:#6e6e73;margin:0 0 24px;">${new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} — prochaine publication : ${new Date().getUTCDay() === 5 ? 'mardi' : 'vendredi'}</p>
  ${failBlock}
  ${rows ? `<table style="width:100%;border-collapse:collapse;font-size:14px;"><tbody>${rows}</tbody></table>` : ''}
  ${refillBlock}
  <p style="font-size:13px;color:#6e6e73;margin-top:20px;">Sujets restants en file : <strong>${pendingLeft}</strong> (réapprovisionnement auto sous ${TOPIC_REFILL_THRESHOLD})</p>
  <div style="margin-top:24px;text-align:center;">
    <a href="${APP_URL}/admin-blog.html" style="display:inline-block;background:#0071e3;color:white;text-decoration:none;font-weight:600;padding:12px 28px;border-radius:22px;font-size:14px;">Ouvrir l'admin blog →</a>
  </div>
  <p style="font-size:11px;color:#a1a1a6;margin-top:30px;text-align:center;border-top:1px solid #e5e5ea;padding-top:18px;">Email automatique du cron /api/cron-generate-blog (mardi & vendredi, 11h Paris). Aucune action requise sauf mention contraire.</p>
</div>
</body></html>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: RESEND_FROM, to: ADMIN_EMAIL, subject, html }),
  });
  if (!r.ok) console.warn(`[cron-generate-blog] Resend email failed ${r.status}: ${await r.text()}`);
}

// ─────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Protection cron secret (Vercel envoie `Authorization: Bearer <CRON_SECRET>`)
  const providedSecret = req.headers['x-cron-secret']
    || (req.headers.authorization || '').replace('Bearer ', '');
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized (CRON_SECRET mismatch)' });
  }

  try {
    const idToken = await getAdminToken();

    // 0. Lire toute la file + réapprovisionner si nécessaire
    let allTopics = await listAllTopics(idToken);
    let refill = { added: 0 };
    try {
      refill = await refillTopicsIfNeeded(allTopics, idToken);
      if (refill.added > 0) allTopics = await listAllTopics(idToken); // relire la file à jour
    } catch (refillErr) {
      refill = { added: 0, error: String(refillErr.message || refillErr).slice(0, 200) };
      console.warn('[cron-generate-blog] refill failed:', refill.error);
      // Non bloquant : on continue avec les pending existants s'il y en a
    }

    // 1. Pioche le(s) sujet(s) pending les plus prioritaires (tri en mémoire)
    const pending = allTopics
      .filter((t) => t.status === 'pending')
      .sort((a, b) => (Number(a.priority) || 9999) - (Number(b.priority) || 9999));
    const topics = pending.slice(0, ARTICLES_PER_RUN);
    const pendingLeft = Math.max(0, pending.length - topics.length);

    if (topics.length === 0) {
      // File vide ET regénération échouée → email d'alerte explicite
      await sendRecapEmail([], 0, refill).catch((e) => console.warn('[cron-generate-blog] email err:', e.message));
      return res.status(200).json({
        ok: false,
        generated: 0,
        published: 0,
        refill,
        message: 'Aucun sujet disponible et la regénération automatique a échoué. Email d\'alerte envoyé.',
      });
    }

    // 2. Génère + publie (en série)
    const results = [];
    for (const t of topics) {
      const entry = { topic: t.topic };
      try {
        const gen = await callGenerate(t.topic, t.metier || 'all', t.category || 'guides', t.length || 'medium');
        entry.title = gen.title;
        entry.slug = gen.slug;
        entry.tokens = gen.tokens_used;

        try {
          const pub = await callPublish(gen.slug);
          entry.publishedUrl = pub.publishedUrl;
          entry.commitUrl = pub.commitUrl;
        } catch (pubErr) {
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
    await sendRecapEmail(results, pendingLeft, refill).catch((e) => console.warn('[cron-generate-blog] email err:', e.message));

    return res.status(200).json({
      ok: true,
      generated: results.filter((r) => !r.error).length,
      published: results.filter((r) => r.publishedUrl).length,
      failed: results.filter((r) => r.error).length,
      topics_refilled: refill.added || 0,
      pending_left: pendingLeft,
      results,
    });
  } catch (err) {
    console.error('[cron-generate-blog]', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};
