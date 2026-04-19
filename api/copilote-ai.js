/**
 * api/copilote-ai.js
 * ════════════════════════════════════════════════════════════════════════
 * Copilote IA business quotidien — Briefing dashboard
 *
 * Deux modes :
 *   - MODE STANDARD (clients sans Léa) :
 *     - Claude Haiku 4.5
 *     - Analyse basique des métriques
 *     - Titre "Copilote IA"
 *
 *   - MODE LÉA (clients avec agentEnabled / trial / admin / betaTester) :
 *     - Claude Sonnet 4.5
 *     - Analyse enrichie avec :
 *         · Résumé business persistant (memory/business-summary)
 *         · Faits mémorisés (max 20)
 *         · Préférences de style
 *     - Titre "Brief de Léa"
 *     - Insights cliquables (ouvre agent.html avec question pré-remplie)
 *
 * L'API renvoie `leaMode: true|false` pour que le front adapte l'UI.
 * ════════════════════════════════════════════════════════════════════════
 */

const FIREBASE_PROJECT = 'altiora-70599';

// ── CORS ──
function _cors(req, res) {
  const origin = req.headers.origin;
  const allowed = ['https://alteore.com', 'https://www.alteore.com'];
  if (allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  else res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') { res.status(200).end(); return true; }
  return false;
}

// ── Auth Firebase token ──
async function _verifyAuth(req, res) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) { res.status(401).json({ error: 'Non authentifié.' }); return null; }
  try {
    const apiKey = process.env.FIREBASE_API_KEY;
    if (!apiKey) { res.status(500).json({ error: 'Config serveur manquante.' }); return null; }
    const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + apiKey, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token })
    });
    if (!r.ok) { res.status(401).json({ error: 'Token invalide.' }); return null; }
    const d = await r.json();
    const u = d.users?.[0];
    if (!u?.localId) { res.status(401).json({ error: 'Utilisateur introuvable.' }); return null; }
    return { uid: u.localId };
  } catch (e) {
    res.status(401).json({ error: 'Erreur auth.' });
    return null;
  }
}

// ── Rate limiting en mémoire (bucket par uid, 10/min) ──
const _rlBuckets = new Map();
function _rateLimit(uid, res, max = 10) {
  const now = Date.now();
  let b = _rlBuckets.get(uid);
  if (!b || now > b.r) { b = { c: 0, r: now + 60000 }; _rlBuckets.set(uid, b); }
  b.c++;
  if (b.c > max) { res.status(429).json({ error: 'Trop de requêtes.' }); return true; }
  return false;
}

// ── Firestore Admin (pour lire user doc + mémoire Léa) ──
let _adminToken = null;
let _adminTokenExp = 0;

async function getAdminToken() {
  if (_adminToken && Date.now() < _adminTokenExp - 300000) return _adminToken;
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
  const email = process.env.FIREBASE_API_EMAIL;
  const password = process.env.FIREBASE_API_PASSWORD;
  if (!email || !password) return null;
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${fbKey}`,
    {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }
  );
  const data = await r.json();
  if (data.idToken) {
    _adminToken = data.idToken;
    _adminTokenExp = Date.now() + (parseInt(data.expiresIn || '3600') * 1000);
    return _adminToken;
  }
  return null;
}

async function fsGet(path) {
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`;
  const token = await getAdminToken();
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url + (token ? '' : '?key=' + fbKey), { headers });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.json();
}

async function fsList(path, pageSize = 100) {
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?pageSize=${pageSize}`;
  const token = await getAdminToken();
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url + (token ? '' : '&key=' + fbKey), { headers });
  if (!res.ok) return { documents: [] };
  return res.json();
}

function fvRaw(f) {
  if (!f) return null;
  if (f.stringValue !== undefined) return f.stringValue;
  if (f.integerValue !== undefined) return parseInt(f.integerValue);
  if (f.doubleValue !== undefined) return parseFloat(f.doubleValue);
  if (f.booleanValue !== undefined) return f.booleanValue;
  if (f.timestampValue !== undefined) return f.timestampValue;
  if (f.nullValue !== undefined) return null;
  return null;
}
function fv(doc, field) { return fvRaw(doc?.fields?.[field]); }

// ── Détection accès Léa ──
function hasLeaAccess(userDoc) {
  if (!userDoc) return false;
  const role = fv(userDoc, 'role');
  const plan = fv(userDoc, 'plan');
  const agentEnabled = fv(userDoc, 'agentEnabled') === true;
  const betaTester = fv(userDoc, 'betaTester') === true;
  return role === 'admin' || betaTester || agentEnabled || plan === 'trial' || plan === 'dev';
}

// ── Charge la mémoire Léa (cap raisonnable pour dashboard) ──
async function loadLeaMemory(uid) {
  const [summaryDoc, factsRes, prefsRes] = await Promise.all([
    fsGet(`agent/${uid}/memory/business-summary`),
    fsList(`agent/${uid}/memory-facts`, 50),
    fsList(`agent/${uid}/memory-preferences`, 20),
  ]);

  const summary = summaryDoc ? (fv(summaryDoc, 'text') || '') : '';

  const facts = (factsRes?.documents || [])
    .map(d => ({
      fait: fv(d, 'fait') || '',
      categorie: fv(d, 'categorie') || 'autre',
      createdAt: fv(d, 'createdAt') || '',
    }))
    .filter(f => f.fait)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 20); // max 20 faits dans le contexte dashboard

  const preferences = (prefsRes?.documents || [])
    .map(d => ({
      type: (d.name || '').split('/').pop(),
      preference: fv(d, 'preference') || '',
    }))
    .filter(p => p.preference);

  return { summary, facts, preferences };
}

// ═══════════════════════════════════════════════════════════════════════════
// PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

function buildStandardPrompt(metrics, prenom, jour) {
  return `Tu es le copilote IA d'un chef d'entreprise TPE/PME français. Tu analyses ses données et tu lui donnes un briefing quotidien concis, actionnable et personnalisé. Tutoie-le.

Date : ${jour}
${prenom ? 'Prénom : ' + prenom : ''}

DONNÉES DE L'ENTREPRISE :
${JSON.stringify(metrics, null, 2)}

CONSIGNES :
- Réponds UNIQUEMENT en JSON valide (pas de markdown, pas de backticks)
- Structure exacte requise :
{
  "score": <nombre 0-100 score santé global>,
  "scoreLabel": "<Excellent|Bon|Correct|Attention|Critique>",
  "greeting": "<salutation personnalisée courte avec le prénom si dispo, ex: Bonjour Adrien ! ou Bonne journée !>",
  "headline": "<phrase principale du briefing, 1 ligne max, percutante>",
  "insights": [
    {"icon": "<emoji>", "type": "<success|warning|danger|info|tip>", "text": "<insight concis et actionnable, max 2 phrases>"}
  ],
  "actions": [
    {"icon": "<emoji>", "priority": "<high|medium|low>", "text": "<action concrète recommandée>", "link": "<page.html ou null>"}
  ],
  "kpiComment": "<commentaire sur l'évolution des KPIs, 1-2 phrases>"
}

RÈGLES :
- 3 à 5 insights maximum, triés par importance
- 2 à 3 actions concrètes maximum
- Sois direct, pas de blabla. Donne des chiffres précis.
- Si le CA baisse, dis pourquoi (si tu peux le déduire) et quoi faire
- Si stock en rupture, quantifie l'impact potentiel
- Si charges augmentent vs CA, alerte
- Si un employé dépasse les heures légales, alerte urgente
- Si la trésorerie est tendue, propose des actions
- Adapte le ton : encourageant si tout va bien, direct et sérieux si problème
- Le score doit refléter la santé réelle : rentabilité, trésorerie, stock, conformité`;
}

function buildLeaPrompt(metrics, prenom, jour, memory) {
  let memorySection = '';
  if (memory.summary) {
    memorySection += `\n## CE QUE JE SAIS DÉJÀ DE SON BUSINESS (résumé persistant)\n${memory.summary}\n`;
  }
  if (memory.facts.length) {
    memorySection += `\n## FAITS MÉMORISÉS (utilise-les pour personnaliser ton briefing)\n`;
    for (const f of memory.facts) {
      memorySection += `- [${f.categorie}] ${f.fait}\n`;
    }
  }
  if (memory.preferences.length) {
    memorySection += `\n## PRÉFÉRENCES DE STYLE DU DIRIGEANT (à respecter)\n`;
    for (const p of memory.preferences) {
      memorySection += `- ${p.preference}\n`;
    }
  }

  return `Tu es Léa, l'employée IA d'Alteore. Tu es le bras droit du dirigeant et tu lui prépares un briefing de dashboard personnalisé basé sur tes connaissances accumulées.

Date : ${jour}
${prenom ? 'Prénom du dirigeant : ' + prenom : ''}
${memorySection}

## DONNÉES FINANCIÈRES DU JOUR
${JSON.stringify(metrics, null, 2)}

## TON RÔLE
Tu n'es pas un copilote générique, tu es **Léa**. Tu connais déjà ce business grâce à ta mémoire. Utilise ce contexte pour :
- Faire des références pertinentes à l'historique ("le CA d'avril est au-dessus de ta moyenne de ces 6 derniers mois")
- Anticiper : si tu as mémorisé une échéance ou un objectif, mentionne-le
- Personnaliser le ton selon les préférences de style
- Être plus fine et concrète qu'un simple copilote car tu as du contexte

## FORMAT DE RÉPONSE
Réponds UNIQUEMENT en JSON valide (pas de markdown, pas de backticks) :
{
  "score": <nombre 0-100 score santé global, intègre ta connaissance du contexte>,
  "scoreLabel": "<Excellent|Bon|Correct|Attention|Critique>",
  "greeting": "<salutation courte avec le prénom, ex: Bonjour Adrien !>",
  "headline": "<phrase principale du briefing, 1 ligne max, percutante, qui montre que tu connais le business>",
  "insights": [
    {
      "icon": "<emoji>",
      "type": "<success|warning|danger|info|tip>",
      "text": "<insight concis 1-2 phrases, utilise les faits mémorisés si pertinent>",
      "question": "<question précise que l'user pourrait poser à Léa pour creuser cet insight, ex: 'Pourquoi mes charges d'avril sont plus élevées ?' — doit être en français, une phrase simple>"
    }
  ],
  "actions": [
    {"icon": "<emoji>", "priority": "<high|medium|low>", "text": "<action concrète>", "link": "<page.html ou null>"}
  ],
  "kpiComment": "<commentaire sur l'évolution des KPIs, fait le lien avec ta mémoire si possible>"
}

## RÈGLES
- 3 à 5 insights max, chacun avec une question de suivi pertinente (champ "question")
- 2 à 3 actions concrètes max
- Si tu connais un objectif annoncé (via faits mémorisés), mentionne la progression
- Si tu connais une échéance (URSSAF, TVA, etc.), et qu'elle approche, mentionne-la
- Format français des chiffres (15 420 €, 12,5 %)
- Tutoie, sois directe, factuelle, chaleureuse quand c'est mérité
- Le score doit refléter : rentabilité, trésorerie, stock, conformité ET contexte historique`;
}

// ═══════════════════════════════════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  if (_cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await _verifyAuth(req, res);
  if (!auth) return;
  if (_rateLimit(auth.uid, res, 10)) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY manquante' });

  try {
    const { metrics, prenom } = req.body;
    if (!metrics) return res.status(400).json({ error: 'Metrics manquantes' });

    const now = new Date();
    const jour = now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

    // ── Détection mode Léa ──
    const userDoc = await fsGet(`users/${auth.uid}`);
    const leaMode = hasLeaAccess(userDoc);

    let prompt, model, maxTokens;

    if (leaMode) {
      // Charger la mémoire Léa + construire le prompt enrichi
      const memory = await loadLeaMemory(auth.uid);
      prompt = buildLeaPrompt(metrics, prenom, jour, memory);
      model = 'claude-sonnet-4-5-20250929';
      maxTokens = 1800;
    } else {
      // Mode standard (comportement historique)
      prompt = buildStandardPrompt(metrics, prenom, jour);
      model = 'claude-haiku-4-5-20251001';
      maxTokens = 1200;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: 'Erreur API', details: errText.slice(0, 500) });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';

    let result;
    try {
      const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      result = JSON.parse(cleaned);
    } catch (e) {
      result = {
        score: 50,
        scoreLabel: 'Indisponible',
        greeting: 'Bonjour !',
        headline: 'Briefing temporairement indisponible',
        insights: [],
        actions: [],
        kpiComment: '',
        raw: text,
      };
    }

    // Injecter le flag leaMode pour que le front adapte l'UI
    result.leaMode = leaMode;

    return res.status(200).json(result);

  } catch (err) {
    console.error('copilote-ai error:', err);
    return res.status(500).json({ error: err.message });
  }
}
