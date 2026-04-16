/**
 * /api/generate-blog-post
 *
 * POST body: { topic, metier, category, length }
 *   - topic      : sujet de l'article (ex: "Comment calculer la marge d'un restaurant")
 *   - metier     : restaurant|boulangerie|boutique|coiffeur|artisan|agence|all
 *   - category   : guides|comparatifs|reglementation
 *   - length     : short (800) | medium (1200) | long (1800) — défaut medium
 *
 * Steps:
 *   1. Appelle Claude Sonnet 4.5 avec un prompt structuré → article JSON
 *   2. Valide et nettoie le JSON
 *   3. Render HTML à partir du template
 *   4. Sauvegarde dans Firestore: blog_drafts/{slug}
 *   5. Retourne { ok, slug, draftUrl, tokensUsed }
 *
 * Required env vars:
 *   - ANTHROPIC_API_KEY
 *   - FIREBASE_API_KEY, FIREBASE_API_EMAIL, FIREBASE_API_PASSWORD
 */

const FIREBASE_PROJECT_ID = 'altiora-70599';
const ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929';

// ─────────────────────────────────────────────────────────
// Firebase helpers (REST API + admin token)
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
  const data = await r.json();
  return data.idToken;
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

async function firestoreWrite(collection, docId, obj, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}?documentId=${encodeURIComponent(docId)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(buildFirestoreDoc(obj)),
  });
  if (!r.ok) {
    // Document may already exist → use PATCH
    if (r.status === 409) {
      const patchUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${encodeURIComponent(docId)}`;
      const r2 = await fetch(patchUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(buildFirestoreDoc(obj)),
      });
      if (!r2.ok) throw new Error(`Firestore PATCH ${r2.status}: ${await r2.text()}`);
      return;
    }
    throw new Error(`Firestore write ${r.status}: ${await r.text()}`);
  }
}

// ─────────────────────────────────────────────────────────
// Slug helper
// ─────────────────────────────────────────────────────────

function slugify(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

// ─────────────────────────────────────────────────────────
// Claude call
// ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Tu es rédacteur SEO senior pour ALTEORE, un logiciel SaaS de gestion pour TPE, PME, artisans et commerçants français. Tu écris des articles de blog de qualité éditoriale en français.

Ton ton est : expert, direct, concret, avec des chiffres et exemples. Pas de langage corporate ni de superlatifs. Tu utilises le "vous" (pas le "tu"). Tu cites les conventions collectives, IDCC, taux de TVA quand c'est pertinent.

Tu réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans markdown fences, sans commentaire. Le JSON doit avoir exactement cette structure :

{
  "title": "Titre SEO-friendly pour le <title> (max 60 car, avec le mot-clé principal)",
  "slug": "slug-url-friendly-sans-accents",
  "meta_description": "150-160 caractères, inclut mot-clé, incite au clic",
  "h1": "Titre H1 visible (souvent identique ou proche du title)",
  "hero_emoji": "🍽️ (1 emoji représentatif du métier/sujet)",
  "category_label": "Guides métier · Restaurant (court, visible)",
  "reading_time_min": 7,
  "keywords": ["mot-clé 1", "mot-clé 2", "..."],
  "toc": [
    {"id": "ancre-courte", "title": "Titre de section"}
  ],
  "sections": [
    {
      "id": "ancre-courte",
      "title": "Titre H2",
      "blocks": [
        {"type": "p", "content": "Paragraphe de 2-4 phrases. Utilise **mot** pour bold, *mot* pour italic, [texte](url) pour lien."},
        {"type": "h3", "content": "Sous-titre H3"},
        {"type": "ul", "items": ["Item 1", "Item 2"]},
        {"type": "ol", "items": ["Item 1", "Item 2"]},
        {"type": "formula", "label": "Formule", "content": "Marge brute (%) = (CA − Coût) / CA × 100"},
        {"type": "info", "content": "**Benchmark 2026 :** texte important à retenir"},
        {"type": "table", "headers": ["Col 1", "Col 2", "Col 3"], "rows": [["A", "B", "C"], ["D", "E", "F"]]}
      ]
    }
  ],
  "faq": [
    {"q": "Question naturelle ?", "a": "Réponse complète, 2-4 phrases, avec des chiffres si pertinent"}
  ],
  "cta_title": "Titre CTA final (ex: Calculez vos marges en temps réel)",
  "cta_text": "Phrase courte d'incitation (1-2 phrases)",
  "related": [
    {"url": "/logiciel-gestion-restaurant", "cat": "Logiciel métier", "title": "Alteore pour les restaurateurs", "desc": "Découvrez les 6 modules pensés pour votre restaurant."}
  ]
}

Règles strictes :
- 4 à 6 sections H2
- Chaque section a 2 à 5 blocks
- FAQ : 3 à 5 questions, questions sous forme naturelle (commencent par Comment/Quel/Pourquoi/Est-ce que...)
- Au moins 1 block de type "formula" ou "table" ou "info" dans les sections (renforce la crédibilité SEO)
- Utilise les données 2026 et les références réglementaires françaises (CCN, IDCC, taux TVA, URSSAF)
- Mentionne Alteore 1 à 2 fois maximum, toujours comme outil utile (pas comme pub)
- related : 3 liens, privilégier les landings métier Alteore (/logiciel-gestion-<metier>) et /pricing
- Les ancres "id" des sections doivent apparaître dans toc ET dans sections (même valeur)
- Évite les hallucinations : pas de statistiques inventées, pas de sources non vérifiables`;

async function callClaude(topic, metier, category, wordTarget) {
  const userPrompt = `Rédige un article de blog pour Alteore sur le sujet :
"${topic}"

Métier cible : ${metier}
Catégorie : ${category}
Longueur cible : environ ${wordTarget} mots

Retourne UNIQUEMENT le JSON structuré demandé, sans autre texte.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!r.ok) throw new Error(`Claude API ${r.status}: ${await r.text()}`);
  const data = await r.json();

  if (data.stop_reason === 'max_tokens') {
    throw new Error('Claude a atteint max_tokens — article tronqué, réessayer avec un sujet moins large');
  }

  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Claude : pas de bloc text dans la réponse');

  let raw = textBlock.text.trim();
  // Strip markdown fences si présentes
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');

  let article;
  try {
    article = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Claude a renvoyé du JSON invalide : ${e.message}\n\nDébut réponse: ${raw.slice(0, 300)}`);
  }

  return {
    article,
    usage: data.usage || {},
  };
}

// ─────────────────────────────────────────────────────────
// HTML rendering
// ─────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inlineFormat(s) {
  // Ordre important : bold avant italic (** avant *)
  let out = escapeHtml(s);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, url) => {
    const safeUrl = url.startsWith('/') || url.startsWith('https://') || url.startsWith('mailto:') ? url : '#';
    return `<a href="${safeUrl}">${text}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  return out;
}

function renderBlock(b) {
  switch (b.type) {
    case 'p':
      return `<p>${inlineFormat(b.content || '')}</p>`;
    case 'h3':
      return `<h3>${escapeHtml(b.content || '')}</h3>`;
    case 'ul':
      return `<ul>${(b.items || []).map((i) => `<li>${inlineFormat(i)}</li>`).join('')}</ul>`;
    case 'ol':
      return `<ol>${(b.items || []).map((i) => `<li>${inlineFormat(i)}</li>`).join('')}</ol>`;
    case 'formula':
      return `<div class="formula"><strong>${escapeHtml(b.label || 'Formule')}</strong>${escapeHtml(b.content || '')}</div>`;
    case 'info':
      return `<div class="info-box"><p>${inlineFormat(b.content || '')}</p></div>`;
    case 'table': {
      const headers = (b.headers || []).map((h) => `<th>${escapeHtml(h)}</th>`).join('');
      const rows = (b.rows || []).map((row) => `<tr>${row.map((c, i) => `<td${i === 0 ? '' : ''}>${inlineFormat(String(c))}</td>`).join('')}</tr>`).join('');
      return `<div class="ex-table-wrap"><table class="ex-table"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></div>`;
    }
    default:
      return '';
  }
}

function renderArticleHtml(a, publishedAtIso) {
  const slug = a.slug;
  const url = `https://alteore.com/blog/${slug}`;
  const pubDate = publishedAtIso || new Date().toISOString();
  const pubDateFr = new Date(pubDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

  const breadcrumbJson = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Accueil', item: 'https://alteore.com/' },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: 'https://alteore.com/blog' },
      { '@type': 'ListItem', position: 3, name: a.title, item: url },
    ],
  });

  const articleJson = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.title,
    description: a.meta_description,
    image: 'https://alteore.com/og-image.png',
    datePublished: pubDate,
    dateModified: pubDate,
    author: { '@type': 'Organization', name: 'Équipe ALTEORE', url: 'https://alteore.com' },
    publisher: { '@type': 'Organization', name: 'ALTEORE', logo: { '@type': 'ImageObject', url: 'https://alteore.com/icon-512.png' } },
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    inLanguage: 'fr-FR',
    articleSection: a.category_label || 'Guides',
    keywords: (a.keywords || []).join(', '),
  });

  const faqJson = a.faq && a.faq.length ? JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: a.faq.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  }) : null;

  const tocHtml = (a.toc || []).map((t) => `<li><a href="#${escapeHtml(t.id)}">${escapeHtml(t.title)}</a></li>`).join('');

  const sectionsHtml = (a.sections || []).map((s) => {
    const blocksHtml = (s.blocks || []).map(renderBlock).join('\n    ');
    return `<h2 id="${escapeHtml(s.id)}">${escapeHtml(s.title)}</h2>\n    ${blocksHtml}`;
  }).join('\n\n    ');

  const faqHtml = (a.faq && a.faq.length) ? `
  <div class="faq-block">
    <h2>Questions fréquentes</h2>
    ${a.faq.map((f) => `<details class="faq-item"><summary>${escapeHtml(f.q)}</summary><div class="a">${inlineFormat(f.a)}</div></details>`).join('\n    ')}
  </div>` : '';

  const relatedHtml = (a.related && a.related.length) ? `
<section class="related">
  <div class="related-t">À lire aussi</div>
  <h2>Autres lectures recommandées</h2>
  <div class="related-grid">
    ${a.related.slice(0, 3).map((r) => `<a class="related-card" href="${escapeHtml(r.url)}"><div class="related-card-cat">${escapeHtml(r.cat || '')}</div><div class="related-card-t">${escapeHtml(r.title)}</div><div class="related-card-d">${escapeHtml(r.desc || '')}</div></a>`).join('\n    ')}
  </div>
</section>` : '';

  // Template HTML — identique au blog-article-exemple.html
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>${escapeHtml(a.title)} — ALTEORE</title>
  <meta name="description" content="${escapeHtml(a.meta_description)}"/>
  <meta name="keywords" content="${escapeHtml((a.keywords || []).join(', '))}"/>
  <meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1"/>
  <meta name="author" content="Équipe ALTEORE"/>
  <link rel="canonical" href="${url}"/>

  <meta property="og:type" content="article"/>
  <meta property="og:url" content="${url}"/>
  <meta property="og:title" content="${escapeHtml(a.title)}"/>
  <meta property="og:description" content="${escapeHtml(a.meta_description)}"/>
  <meta property="og:image" content="https://alteore.com/og-image.png"/>
  <meta property="og:image:width" content="1200"/>
  <meta property="og:image:height" content="630"/>
  <meta property="og:locale" content="fr_FR"/>
  <meta property="og:site_name" content="ALTEORE"/>
  <meta property="article:published_time" content="${pubDate}"/>
  <meta property="article:modified_time" content="${pubDate}"/>
  <meta property="article:author" content="Équipe ALTEORE"/>
  <meta property="article:section" content="${escapeHtml(a.category_label || 'Guides')}"/>

  <meta name="twitter:card" content="summary_large_image"/>
  <meta name="twitter:title" content="${escapeHtml(a.title)}"/>
  <meta name="twitter:description" content="${escapeHtml(a.meta_description)}"/>
  <meta name="twitter:image" content="https://alteore.com/og-image.png"/>

  <meta name="theme-color" content="#0071e3"/>
  <meta name="format-detection" content="telephone=no"/>

  <link rel="alternate" hreflang="fr-FR" href="${url}"/>
  <link rel="alternate" hreflang="x-default" href="${url}"/>

  <link rel="icon" href="/favicon.ico" sizes="any"/>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg"/>
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"/>
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png"/>
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"/>
  <link rel="manifest" href="/site.webmanifest"/>

  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&display=swap" rel="stylesheet"/>

  <script type="application/ld+json">${breadcrumbJson}</script>
  <script type="application/ld+json">${articleJson}</script>
  ${faqJson ? `<script type="application/ld+json">${faqJson}</script>` : ''}

  <style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  :root{--bg:#f5f5f7;--white:#fff;--text:#1d1d1f;--muted:#6e6e73;--subtle:#a1a1a6;--border:#d2d2d7;--blue:#0071e3;--blue-dark:#0051a2;--blue-light:#4fa0ff;--blue-ghost:#e8f0fe;--r:14px;--rlg:20px;--rxl:28px;--sh:0 4px 16px rgba(0,0,0,.08),0 1px 4px rgba(0,0,0,.04);--nav-h:52px;}
  html{scroll-behavior:smooth;}
  body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text','Inter',sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;}
  nav{position:fixed;top:0;left:0;right:0;z-index:200;height:var(--nav-h);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);background:rgba(245,245,247,.82);border-bottom:1px solid rgba(0,0,0,.06);display:flex;align-items:center;justify-content:space-between;padding:0 32px;}
  .nav-logo{display:flex;align-items:center;gap:9px;text-decoration:none;}
  .nav-logo-text{font-size:16px;font-weight:700;color:var(--text);letter-spacing:.3px;}
  .nav-links{display:flex;align-items:center;gap:28px;}
  .nav-links a{font-size:13px;font-weight:500;color:var(--muted);text-decoration:none;transition:color .2s;}
  .nav-links a:hover{color:var(--text);}
  .nav-links a.active{color:var(--blue);}
  .nav-actions{display:flex;align-items:center;gap:10px;}
  .nav-btn{font-family:inherit;font-size:13px;font-weight:600;padding:7px 16px;border-radius:20px;cursor:pointer;transition:all .2s;text-decoration:none;display:inline-flex;align-items:center;}
  .nav-btn-ghost{background:transparent;color:var(--text);border:none;}
  .nav-btn-ghost:hover{color:var(--blue);}
  .nav-btn-fill{background:var(--blue);color:white;border:none;}
  .nav-btn-fill:hover{background:var(--blue-dark);transform:translateY(-1px);}
  @media (max-width:820px){.nav-links{display:none;}}
  .art-header{padding:calc(var(--nav-h)+60px) 24px 40px;max-width:800px;margin:0 auto;text-align:center;}
  .breadcrumb{font-size:13px;color:var(--muted);margin-bottom:24px;}
  .breadcrumb a{color:var(--muted);text-decoration:none;transition:color .2s;}
  .breadcrumb a:hover{color:var(--blue);}
  .breadcrumb .sep{margin:0 8px;opacity:.5;}
  .art-cat{display:inline-block;font-size:12px;font-weight:600;color:var(--blue);text-transform:uppercase;letter-spacing:.08em;background:var(--blue-ghost);padding:5px 12px;border-radius:20px;margin-bottom:20px;}
  h1.art-title{font-family:'Fraunces','Playfair Display',Georgia,serif;font-size:clamp(32px,5vw,52px);font-weight:600;line-height:1.15;letter-spacing:-0.015em;color:var(--text);margin-bottom:20px;}
  .art-meta{display:flex;align-items:center;justify-content:center;gap:16px;font-size:14px;color:var(--muted);flex-wrap:wrap;}
  .art-meta-item{display:flex;align-items:center;gap:6px;}
  .art-meta-sep{width:3px;height:3px;background:var(--subtle);border-radius:50%;}
  .art-wrap{max-width:760px;margin:0 auto;padding:0 24px 80px;}
  .art-hero-img{width:100%;aspect-ratio:16/9;background:linear-gradient(135deg,var(--blue-ghost) 0%,rgba(79,160,255,.15) 100%);border-radius:var(--rxl);margin-bottom:48px;display:flex;align-items:center;justify-content:center;font-size:120px;}
  .toc{background:white;border:1px solid var(--border);border-radius:var(--rlg);padding:22px 28px;margin-bottom:44px;}
  .toc-t{font-size:12px;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px;}
  .toc ol{list-style:none;counter-reset:tocitem;padding:0;}
  .toc ol li{counter-increment:tocitem;padding:6px 0;}
  .toc ol li::before{content:counter(tocitem,decimal-leading-zero) "  ";color:var(--subtle);font-family:ui-monospace,Menlo,monospace;font-size:12px;font-weight:500;margin-right:8px;}
  .toc a{color:var(--text);text-decoration:none;font-size:14.5px;font-weight:500;transition:color .2s;}
  .toc a:hover{color:var(--blue);}
  .prose h2{font-family:'Fraunces','Playfair Display',Georgia,serif;font-size:clamp(24px,3.5vw,32px);font-weight:600;line-height:1.2;letter-spacing:-0.01em;color:var(--text);margin-top:56px;margin-bottom:18px;scroll-margin-top:80px;}
  .prose h3{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Inter',sans-serif;font-size:20px;font-weight:700;line-height:1.3;color:var(--text);margin-top:36px;margin-bottom:14px;}
  .prose p{font-size:17px;line-height:1.75;color:var(--text);margin-bottom:20px;}
  .prose p em{font-style:italic;}
  .prose p strong{font-weight:700;}
  .prose ul,.prose ol{margin:0 0 22px 0;padding-left:26px;}
  .prose li{font-size:17px;line-height:1.7;color:var(--text);margin-bottom:8px;}
  .prose a{color:var(--blue);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px;transition:all .2s;}
  .prose a:hover{text-decoration-thickness:2px;}
  .formula{background:linear-gradient(135deg,#0f1f5c 0%,#1a3dce 100%);color:white;border-radius:var(--rlg);padding:28px 32px;margin:30px 0;text-align:center;font-family:ui-monospace,Menlo,monospace;font-size:16px;line-height:1.6;}
  .formula strong{display:block;font-size:12px;font-weight:600;color:rgba(255,255,255,.65);text-transform:uppercase;letter-spacing:.12em;margin-bottom:8px;font-family:-apple-system,Inter,sans-serif;}
  .info-box{background:var(--blue-ghost);border-left:4px solid var(--blue);border-radius:var(--r);padding:20px 24px;margin:28px 0;}
  .info-box p{margin:0;font-size:15.5px;line-height:1.65;color:var(--text);}
  .info-box p strong{color:var(--blue-dark);}
  .ex-table-wrap{overflow-x:auto;border-radius:var(--rlg);border:1px solid var(--border);background:white;margin:30px 0;}
  .ex-table{width:100%;border-collapse:collapse;}
  .ex-table thead th{background:#fafafc;padding:14px 16px;text-align:left;font-size:13px;font-weight:700;color:var(--text);border-bottom:1px solid var(--border);}
  .ex-table td{padding:12px 16px;font-size:14px;color:var(--text);border-bottom:1px solid var(--border);}
  .ex-table tr:last-child td{border-bottom:none;}
  .ex-table td:first-child{font-weight:600;color:var(--muted);background:#fafafc;}
  .faq-block{margin-top:56px;background:white;border:1px solid var(--border);border-radius:var(--rlg);padding:36px 32px;}
  .faq-block h2{margin-top:0;}
  .faq-item{border-bottom:1px solid var(--border);padding:18px 0;}
  .faq-item:last-child{border-bottom:none;padding-bottom:0;}
  .faq-item:first-of-type{padding-top:0;}
  .faq-item summary{font-size:16px;font-weight:600;color:var(--text);cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:12px;}
  .faq-item summary::-webkit-details-marker{display:none;}
  .faq-item summary::after{content:"+";font-size:22px;color:var(--blue);font-weight:300;transition:transform .3s;}
  .faq-item[open] summary::after{transform:rotate(45deg);}
  .faq-item .a{font-size:15.5px;line-height:1.7;color:var(--muted);margin-top:12px;}
  .art-cta{margin-top:56px;background:linear-gradient(135deg,var(--blue) 0%,var(--blue-dark) 100%);color:white;border-radius:var(--rxl);padding:48px 40px;text-align:center;}
  .art-cta h3{font-family:'Fraunces',Georgia,serif;font-size:clamp(24px,3vw,32px);font-weight:600;line-height:1.2;color:white;margin-bottom:14px;}
  .art-cta p{font-size:16px;color:rgba(255,255,255,.88);margin-bottom:24px;line-height:1.55;max-width:480px;margin-left:auto;margin-right:auto;}
  .art-cta .btn{display:inline-block;background:white;color:var(--blue-dark);font-size:15px;font-weight:700;padding:13px 28px;border-radius:23px;text-decoration:none;transition:all .2s;}
  .art-cta .btn:hover{transform:translateY(-1px);box-shadow:0 10px 30px rgba(0,0,0,.2);}
  .related{max-width:1100px;margin:80px auto 0;padding:0 24px 0;}
  .related-t{font-size:13px;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:.08em;text-align:center;margin-bottom:24px;}
  .related h2{font-family:'Fraunces',Georgia,serif;font-size:clamp(26px,3.5vw,36px);font-weight:600;line-height:1.2;text-align:center;margin-bottom:40px;}
  .related-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;}
  .related-card{background:white;border:1px solid var(--border);border-radius:var(--rlg);padding:24px;text-decoration:none;color:var(--text);transition:all .25s;display:block;}
  .related-card:hover{transform:translateY(-3px);box-shadow:var(--sh);border-color:var(--blue);}
  .related-card-cat{font-size:11px;font-weight:600;color:var(--blue);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;}
  .related-card-t{font-size:16px;font-weight:700;line-height:1.35;color:var(--text);margin-bottom:8px;}
  .related-card-d{font-size:13px;color:var(--muted);line-height:1.55;}
  @media (max-width:820px){.related-grid{grid-template-columns:1fr;}}
  footer{background:#000;color:#a1a1a6;padding:60px 24px 28px;margin-top:80px;}
  .ft-wrap{max-width:1100px;margin:0 auto;}
  .ft-top{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:40px;margin-bottom:40px;}
  .ft-logo{display:flex;align-items:center;gap:10px;text-decoration:none;margin-bottom:12px;}
  .ft-logo-txt{font-size:17px;font-weight:700;color:white;letter-spacing:.5px;}
  .ft-desc{font-size:13px;line-height:1.6;color:#a1a1a6;max-width:280px;}
  .ft-col h4{color:white;font-size:13px;font-weight:700;margin-bottom:14px;letter-spacing:.3px;}
  .ft-col a{display:block;color:#a1a1a6;font-size:13px;text-decoration:none;padding:4px 0;transition:color .2s;}
  .ft-col a:hover{color:white;}
  .ft-btm{border-top:1px solid rgba(255,255,255,.1);padding-top:24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:14px;font-size:12px;}
  .ft-btm a{color:#a1a1a6;text-decoration:none;margin-left:18px;}
  .ft-btm a:hover{color:white;}
  @media (max-width:820px){.ft-top{grid-template-columns:1fr 1fr;gap:28px;}nav{padding:0 20px;}}
  @media (max-width:540px){.ft-top{grid-template-columns:1fr;}.ft-btm{flex-direction:column;align-items:flex-start;}.ft-btm a{margin-left:0;margin-right:18px;}}
  </style>
</head>
<body>

<nav>
  <a class="nav-logo" href="/">
    <svg width="30" height="30" viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <defs><linearGradient id="lg1" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#4fa0ff"/><stop offset="100%" stop-color="#0051a2"/></linearGradient></defs>
      <polygon points="50,8 10,88 30,88 50,48 70,88 90,88" fill="url(#lg1)"/>
      <rect x="38" y="30" width="40" height="9" rx="4" fill="url(#lg1)"/>
      <rect x="42" y="47" width="34" height="9" rx="4" fill="url(#lg1)"/>
      <rect x="48" y="64" width="26" height="9" rx="4" fill="url(#lg1)"/>
    </svg>
    <span class="nav-logo-text">ALTEORE</span>
  </a>
  <div class="nav-links">
    <a href="/#modules">Modules</a>
    <a href="/pricing">Tarifs</a>
    <a href="/blog" class="active">Blog</a>
  </div>
  <div class="nav-actions">
    <a class="nav-btn nav-btn-ghost" href="/login">Connexion</a>
    <a class="nav-btn nav-btn-fill" href="/login">Essai gratuit</a>
  </div>
</nav>

<header class="art-header">
  <div class="breadcrumb">
    <a href="/">Accueil</a><span class="sep">›</span><a href="/blog">Blog</a><span class="sep">›</span><span>${escapeHtml(a.category_label || 'Article')}</span>
  </div>
  <span class="art-cat">${escapeHtml(a.category_label || 'Guide')}</span>
  <h1 class="art-title">${escapeHtml(a.h1 || a.title)}</h1>
  <div class="art-meta">
    <span class="art-meta-item">📅 ${pubDateFr}</span>
    <span class="art-meta-sep"></span>
    <span class="art-meta-item">⏱️ ${a.reading_time_min || 7} min de lecture</span>
    <span class="art-meta-sep"></span>
    <span class="art-meta-item">✍️ Équipe ALTEORE</span>
  </div>
</header>

<article class="art-wrap">
  <div class="art-hero-img" aria-hidden="true">${escapeHtml(a.hero_emoji || '📰')}</div>

  ${tocHtml ? `<nav class="toc" aria-label="Table des matières"><div class="toc-t">Table des matières</div><ol>${tocHtml}</ol></nav>` : ''}

  <div class="prose">
    ${sectionsHtml}
  </div>
  ${faqHtml}

  <div class="art-cta">
    <h3>${escapeHtml(a.cta_title || 'Testez Alteore gratuitement')}</h3>
    <p>${escapeHtml(a.cta_text || '15 jours pour tester toutes les fonctionnalités. Sans carte bancaire. Sans engagement.')}</p>
    <a href="/login" class="btn">Commencer gratuitement →</a>
  </div>

</article>
${relatedHtml}

<footer>
  <div class="ft-wrap">
    <div class="ft-top">
      <div>
        <a class="ft-logo" href="/">
          <svg width="26" height="26" viewBox="0 0 100 100" fill="none" aria-hidden="true">
            <defs><linearGradient id="lgf" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#4fa0ff"/><stop offset="100%" stop-color="#0051a2"/></linearGradient></defs>
            <polygon points="50,8 10,88 30,88 50,48 70,88 90,88" fill="url(#lgf)"/>
            <rect x="38" y="30" width="40" height="9" rx="4" fill="url(#lgf)"/>
            <rect x="42" y="47" width="34" height="9" rx="4" fill="url(#lgf)"/>
            <rect x="48" y="64" width="26" height="9" rx="4" fill="url(#lgf)"/>
          </svg>
          <span class="ft-logo-txt">ALTEORE</span>
        </a>
        <p class="ft-desc">La plateforme de gestion tout-en-un pour les TPE, PME, artisans et commerçants.</p>
      </div>
      <div class="ft-col"><h4>Produit</h4><a href="/#modules">Modules</a><a href="/pricing">Tarifs</a><a href="/login">Essai gratuit</a><a href="/blog">Blog</a></div>
      <div class="ft-col"><h4>Métiers</h4><a href="/logiciel-gestion-restaurant">Restaurant</a><a href="/logiciel-gestion-boulangerie">Boulangerie</a><a href="/logiciel-gestion-boutique">Boutique</a><a href="/logiciel-gestion-coiffeur">Coiffeur</a><a href="/logiciel-gestion-artisan">Artisan</a><a href="/logiciel-gestion-agence">Agence</a></div>
      <div class="ft-col"><h4>Légal</h4><a href="/mentions-legales">Mentions légales</a><a href="/cgv">CGV</a><a href="/confidentialite">Confidentialité</a></div>
    </div>
    <div class="ft-btm">
      <span>© 2026 ALTEORE — SAS ALTEORE — SIRET 10271760000013</span>
      <div><a href="/mentions-legales">Mentions</a><a href="/cgv">CGV</a><a href="/confidentialite">Confidentialité</a></div>
    </div>
  </div>
</footer>

</body>
</html>`;
}

// ─────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { topic, metier = 'all', category = 'guides', length = 'medium' } = req.body || {};
    if (!topic || typeof topic !== 'string') {
      return res.status(400).json({ error: 'Missing "topic" (string)' });
    }

    const wordTarget = length === 'short' ? 800 : length === 'long' ? 1800 : 1200;

    // 1. Appel Claude
    const { article, usage } = await callClaude(topic, metier, category, wordTarget);

    // 2. Validation minimale
    if (!article.title || !article.slug || !article.meta_description || !Array.isArray(article.sections)) {
      return res.status(500).json({ error: 'Article JSON incomplet', article });
    }

    // Normaliser le slug
    article.slug = slugify(article.slug || article.title);
    if (!article.slug) return res.status(500).json({ error: 'Slug vide après normalisation' });

    // 3. Render HTML
    const nowIso = new Date().toISOString();
    const html = renderArticleHtml(article, nowIso);

    // 4. Sauvegarder en Firestore
    const idToken = await getAdminToken();
    await firestoreWrite('blog_drafts', article.slug, {
      slug: article.slug,
      title: article.title,
      meta_description: article.meta_description,
      category: category,
      category_label: article.category_label || 'Guide',
      metier: metier,
      hero_emoji: article.hero_emoji || '📰',
      reading_time_min: article.reading_time_min || 7,
      generated_at: nowIso,
      topic_requested: topic,
      html: html,
      article_json: JSON.stringify(article),
      tokens_input: usage.input_tokens || 0,
      tokens_output: usage.output_tokens || 0,
      status: 'draft',
    }, idToken);

    return res.status(200).json({
      ok: true,
      slug: article.slug,
      title: article.title,
      meta_description: article.meta_description,
      category_label: article.category_label,
      word_count_estimated: wordTarget,
      preview_html_length: html.length,
      tokens_used: {
        input: usage.input_tokens || 0,
        output: usage.output_tokens || 0,
      },
    });
  } catch (err) {
    console.error('[generate-blog-post]', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};
