/**
 * /api/import-blog-topics
 *
 * POST : importe la liste de sujets initiaux dans Firestore blog_topics/.
 * Idempotent : ne remplace pas les sujets déjà présents (ne touche que ceux
 * qui n'existent pas encore).
 *
 * Auth : admin humain (Bearer idToken) uniquement.
 *
 * Required env vars:
 *   - FIREBASE_API_KEY, FIREBASE_API_EMAIL, FIREBASE_API_PASSWORD
 *   - BLOG_ADMIN_EMAIL (optionnel, défaut contact@adrienemily.com)
 */

const FIREBASE_PROJECT_ID = 'altiora-70599';
const ADMIN_EMAIL = (process.env.BLOG_ADMIN_EMAIL || 'contact@adrienemily.com').toLowerCase();

// Seed inline (évite d'avoir à lire un fichier JSON depuis le disque)
const SEED = [
  { id: '001-marge-restaurant', priority: 1, topic: "Comment calculer la marge d'un restaurant en 2026", metier: 'restaurant', category: 'guides', length: 'medium' },
  { id: '002-tva-boulangerie', priority: 2, topic: 'Quelle TVA pour ma boulangerie en 2026 : 5,5%, 10% ou 20%', metier: 'boulangerie', category: 'reglementation', length: 'medium' },
  { id: '003-cout-chantier-artisan', priority: 3, topic: "Coût de revient d'un chantier artisan : méthode et exemple chiffré", metier: 'artisan', category: 'guides', length: 'long' },
  { id: '004-indicateurs-boutique', priority: 4, topic: 'Les 7 indicateurs essentiels pour piloter une boutique', metier: 'boutique', category: 'guides', length: 'medium' },
  { id: '005-fideliser-salon', priority: 5, topic: 'Comment fidéliser sa clientèle dans un salon de coiffure', metier: 'coiffeur', category: 'guides', length: 'medium' },
  { id: '006-treso-agence', priority: 6, topic: "Trésorerie prévisionnelle d'une agence : Excel vs logiciel dédié", metier: 'agence', category: 'guides', length: 'medium' },
  { id: '007-seuil-rentabilite', priority: 7, topic: 'Seuil de rentabilité TPE : calcul, formule et interprétation', metier: 'all', category: 'guides', length: 'medium' },
  { id: '008-marge-brute-nette', priority: 8, topic: 'Marge brute vs marge nette : le guide du commerçant en 2026', metier: 'all', category: 'guides', length: 'medium' },
  { id: '009-pointage-btp', priority: 9, topic: 'Pointage mobile sur chantier BTP : obligation légale ou confort de gestion', metier: 'artisan', category: 'reglementation', length: 'medium' },
  { id: '010-facture-electronique', priority: 10, topic: 'Facturation électronique 2026-2027 : ce qui change pour les TPE', metier: 'all', category: 'reglementation', length: 'long' },
  { id: '011-alteore-vs-axonaut', priority: 11, topic: 'Alteore vs Axonaut pour un commerçant en 2026 : comparatif complet', metier: 'all', category: 'comparatifs', length: 'long' },
  { id: '012-alteore-vs-pennylane', priority: 12, topic: 'Alteore vs Pennylane : lequel choisir pour une TPE', metier: 'all', category: 'comparatifs', length: 'long' },
  { id: '013-caisse-vs-pilotage', priority: 13, topic: 'Logiciel de caisse vs logiciel de pilotage : faut-il les deux', metier: 'all', category: 'comparatifs', length: 'medium' },
  { id: '014-obat-vs-alteore', priority: 14, topic: 'Obat vs Alteore pour un artisan : pour qui, quel usage', metier: 'artisan', category: 'comparatifs', length: 'medium' },
  { id: '015-planity-vs-alteore', priority: 15, topic: 'Planity vs Alteore pour un coiffeur : complémentaires ou concurrents', metier: 'coiffeur', category: 'comparatifs', length: 'medium' },
  { id: '016-alternatives-axonaut', priority: 16, topic: '5 alternatives à Axonaut pour les commerçants en 2026', metier: 'all', category: 'comparatifs', length: 'long' },
  { id: '017-comparatif-restauration', priority: 17, topic: 'Comparatif des 7 logiciels de gestion pour restaurateurs en 2026', metier: 'restaurant', category: 'comparatifs', length: 'long' },
  { id: '018-excel-vs-logiciel', priority: 18, topic: 'Excel vs logiciel de gestion : quand franchir le pas', metier: 'all', category: 'comparatifs', length: 'medium' },
  { id: '019-qonto-alteore-combo', priority: 19, topic: 'Qonto et Alteore : le combo gagnant pour une agence', metier: 'agence', category: 'comparatifs', length: 'medium' },
  { id: '020-logiciels-tpe-2026', priority: 20, topic: 'Logiciels de gestion TPE : les 10 à connaître en 2026', metier: 'all', category: 'comparatifs', length: 'long' },
  { id: '021-ccn-hcr', priority: 21, topic: 'CCN HCR 2026 : les changements à connaître pour un restaurateur', metier: 'restaurant', category: 'reglementation', length: 'long' },
  { id: '022-urssaf-artisan', priority: 22, topic: 'Nouvelles règles URSSAF 2026 pour les artisans', metier: 'artisan', category: 'reglementation', length: 'medium' },
  { id: '023-obligations-coiffeur-employeur', priority: 23, topic: "Code du travail 2026 : les obligations d'un coiffeur employeur", metier: 'coiffeur', category: 'reglementation', length: 'medium' },
  { id: '024-syntec', priority: 24, topic: 'Convention SYNTEC : le minimum à savoir pour votre agence', metier: 'agence', category: 'reglementation', length: 'medium' },
  { id: '025-smic-prime-anciennete', priority: 25, topic: "Taux horaire 2026 : SMIC, panier repas, prime d'ancienneté", metier: 'all', category: 'reglementation', length: 'medium' },
  { id: '026-facture-electronique-calendrier', priority: 26, topic: 'Facture électronique obligatoire : calendrier 2026-2027 détaillé', metier: 'all', category: 'reglementation', length: 'long' },
  { id: '027-ccn-boulangerie', priority: 27, topic: 'CCN boulangerie-pâtisserie : heures de nuit et primes en 2026', metier: 'boulangerie', category: 'reglementation', length: 'medium' },
  { id: '028-ccn-btp-1596-1597', priority: 28, topic: "CCN BTP 1596 vs 1597 : laquelle s'applique à votre entreprise", metier: 'artisan', category: 'reglementation', length: 'medium' },
  { id: '029-registre-personnel', priority: 29, topic: 'Registre unique du personnel : que doit-il contenir en 2026', metier: 'all', category: 'reglementation', length: 'medium' },
  { id: '030-dematerialisation-paie', priority: 30, topic: 'Dématérialisation des bulletins de paie : ce qui change en 2026', metier: 'all', category: 'reglementation', length: 'medium' },
];

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
// Firebase helpers (admin token pour écrire en tant que api@altiora.app)
// ─────────────────────────────────────────────────────────

async function getAdminToken() {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${process.env.FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.FIREBASE_API_EMAIL, password: process.env.FIREBASE_API_PASSWORD, returnSecureToken: true }),
  });
  if (!r.ok) throw new Error(`Firebase auth failed: ${r.status} ${await r.text()}`);
  return (await r.json()).idToken;
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

async function firestoreGet(path, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Firestore GET ${path} ${r.status}: ${await r.text()}`);
  return r.json();
}

async function firestoreCreate(collection, docId, obj, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}?documentId=${encodeURIComponent(docId)}`;
  const fields = {};
  for (const k of Object.keys(obj)) fields[k] = toFirestoreValue(obj[k]);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) throw new Error(`Firestore create ${collection}/${docId} ${r.status}: ${await r.text()}`);
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

    const idToken = await getAdminToken();
    const nowIso = new Date().toISOString();

    const created = [];
    const skipped = [];

    for (const t of SEED) {
      const existing = await firestoreGet(`blog_topics/${t.id}`, idToken);
      if (existing) {
        skipped.push(t.id);
        continue;
      }
      await firestoreCreate('blog_topics', t.id, {
        topic: t.topic,
        metier: t.metier,
        category: t.category,
        length: t.length,
        priority: t.priority,
        status: 'pending',
        created_at: nowIso,
      }, idToken);
      created.push(t.id);
    }

    return res.status(200).json({
      ok: true,
      total: SEED.length,
      created: created.length,
      skipped: skipped.length,
      created_ids: created,
      skipped_ids: skipped,
    });
  } catch (err) {
    console.error('[import-blog-topics]', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};
