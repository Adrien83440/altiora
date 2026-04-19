/**
 * api/vocal-ai.js
 * ════════════════════════════════════════════════════════════════════════
 * Assistant vocal business (Wave 3.6)
 *
 * Deux modes :
 *
 * ── MODE STANDARD (clients sans Léa) ────────────────────────────────
 *   - Claude Haiku 4.5 (réponse rapide, coût minimal)
 *   - Prompt amélioré mais style neutre
 *   - Audio : lu par SpeechSynthesis navigateur (pas d'audioUrl renvoyé)
 *
 * ── MODE LÉA (clients avec agentEnabled / trial / admin / betaTester) ──
 *   - Claude Sonnet 4.5 avec mémoire long terme (résumé + 15 faits max)
 *   - Prompt "oral chaleureux" : contractions, expressions naturelles,
 *     chiffres en toutes lettres, pas de listes, pas de markdown
 *   - Audio : pré-généré côté serveur via OpenAI TTS (modèle `tts-1`,
 *     voix `nova`). Retourné en data URL base64 pour lecture directe.
 *   - Fallback : si OpenAI échoue → on retourne juste le texte, le front
 *     tombe sur SpeechSynthesis navigateur (robustesse)
 *
 * Structure de la réponse :
 *   {
 *     answer: "texte à afficher/parler",
 *     leaMode: true|false,
 *     audioUrl: "data:audio/mp3;base64,..." (uniquement si mode Léa + TTS OK)
 *   }
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

// ── Auth Firebase ──
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

// ── Rate limiting (10/min/user) ──
const _rlBuckets = new Map();
function _rateLimit(uid, res, max = 10) {
  const now = Date.now();
  let b = _rlBuckets.get(uid);
  if (!b || now > b.r) { b = { c: 0, r: now + 60000 }; _rlBuckets.set(uid, b); }
  b.c++;
  if (b.c > max) { res.status(429).json({ error: 'Trop de requêtes.' }); return true; }
  return false;
}

// ── Firestore Admin ──
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

// ── Mémoire Léa (légère pour vocal : 15 faits max, pas les préférences) ──
async function loadLeaMemoryLight(uid) {
  const [summaryDoc, factsRes] = await Promise.all([
    fsGet(`agent/${uid}/memory/business-summary`),
    fsList(`agent/${uid}/memory-facts`, 30),
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
    .slice(0, 15);
  return { summary, facts };
}

// ═══════════════════════════════════════════════════════════════════════════
// PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

function buildStandardPrompt(question, metrics, prenom) {
  return `Tu es un assistant vocal business pour un chef d'entreprise TPE/PME français. Il te pose une question à voix haute et tu dois répondre comme si tu parlais — phrases courtes, naturelles, directes. Tutoie-le.

${prenom ? 'Son prénom : ' + prenom : ''}

SES DONNÉES ACTUELLES :
${JSON.stringify(metrics, null, 2)}

SA QUESTION : "${question}"

CONSIGNES :
- Réponds en 2-4 phrases maximum, comme à l'oral
- Donne des chiffres précis tirés de ses données
- Sois direct et concret
- Pas de formules de politesse excessives
- Si tu ne peux pas répondre avec les données dispo, dis-le simplement
- Utilise "euros" en toutes lettres (pas €) pour la lecture vocale
- Pas de listes à puces, que du texte fluide`;
}

function buildLeaPrompt(question, metrics, prenom, memory) {
  let memSection = '';
  if (memory.summary) {
    memSection += `\n\n## CE QUE TU SAIS DU BUSINESS (mémoire long terme)\n${memory.summary}`;
  }
  if (memory.facts.length) {
    memSection += `\n\n## FAITS MÉMORISÉS (références récentes, utilise-les si pertinent)\n`;
    for (const f of memory.facts) {
      memSection += `- [${f.categorie}] ${f.fait}\n`;
    }
  }

  return `Tu es Léa, l'employée IA d'Alteore. Tu viens d'entendre la question du dirigeant à voix haute et tu lui réponds ORALEMENT. Pas à l'écrit.${memSection}

## DONNÉES FINANCIÈRES ACTUELLES
${JSON.stringify(metrics, null, 2)}

## SA QUESTION
"${question}"
${prenom ? '\nSon prénom : ' + prenom : ''}

## COMMENT PARLER (CRITIQUE)
Tu es en train de PARLER, pas d'écrire un rapport. Adopte le style naturel d'une vraie conversation :

✅ **OUI** :
- Contractions orales : "t'as" au lieu de "tu as", "c'est" au lieu de "cela est", "y'a" au lieu de "il y a"
- Petites transitions orales : "alors", "bon", "écoute", "tu sais", "en gros", "du coup"
- Phrases courtes, qui respirent (2 à 4 phrases max)
- Chiffres en toutes lettres uniquement : "quinze mille quatre cent vingt euros" (pas "15 420 €")
- Pourcentages : "douze pour cent" (pas "12 %")
- Mois nommés : "en avril" (pas "04/2026")
- Réactions humaines : félicite sincèrement si c'est une bonne news, alerte calmement sinon
- Références à la mémoire quand pertinent : "vu ton objectif de deux cent cinquante mille euros…"

❌ **NON** :
- Listes à puces
- Gras, italique, markdown
- Symboles € % $ →
- Chiffres en format numérique (jamais "45 320", toujours "quarante-cinq mille trois cent vingt")
- Phrases interminables
- "Selon mes données…", "D'après l'analyse…" → trop formel, pas oral
- Formules de politesse creuses ("J'espère que ça t'aide !")

## ATTITUDE
- Directe et factuelle comme un DAF
- Chaleureuse et encourageante si ça performe
- Calme et pragmatique si problème
- Humaine, jamais robotique

Réponds maintenant, à l'oral, comme si tu étais en face de lui.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// OpenAI TTS (mode Léa uniquement)
// ═══════════════════════════════════════════════════════════════════════════

async function generateAudioOpenAI(text) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.warn('[vocal-ai] OPENAI_API_KEY manquante, fallback SpeechSynthesis côté front');
    return null;
  }
  try {
    const resp = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',          // rapide (~1-2s), qualité suffisante pour vocal conversationnel
        voice: 'nova',            // féminine, chaleureuse, naturelle en français
        input: text,
        response_format: 'mp3',
        speed: 1.0,
      }),
    });
    if (!resp.ok) {
      const errTxt = await resp.text();
      console.warn('[vocal-ai] OpenAI TTS error', resp.status, errTxt.slice(0, 200));
      return null;
    }
    // L'API renvoie un audio binaire → on le convertit en base64 data URL
    const buf = await resp.arrayBuffer();
    const base64 = Buffer.from(buf).toString('base64');
    return `data:audio/mp3;base64,${base64}`;
  } catch (e) {
    console.warn('[vocal-ai] OpenAI TTS exception:', e.message);
    return null;
  }
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
    const { question, metrics, prenom, tts_only, text_to_speak } = req.body;

    // ── Mode TTS-only (Wave 3.7 — app mobile Léa) ──
    // Le front mobile appelle agent-chat pour la réponse (avec tools),
    // puis vocal-ai juste pour la synthèse audio via OpenAI.
    // Évite de regénérer la réponse Claude deux fois.
    if (tts_only === true) {
      if (!text_to_speak || typeof text_to_speak !== 'string') {
        return res.status(400).json({ error: "text_to_speak requis en mode tts_only" });
      }
      if (text_to_speak.length > 2000) {
        return res.status(400).json({ error: "Texte trop long pour TTS (max 2000 caractères)" });
      }
      // Vérifier l'accès Léa : TTS OpenAI réservé aux clients Léa
      const userDoc = await fsGet(`users/${auth.uid}`);
      if (!hasLeaAccess(userDoc)) {
        return res.status(403).json({ error: "TTS OpenAI réservé aux abonnés Léa", leaMode: false });
      }
      const audioUrl = await generateAudioOpenAI(text_to_speak);
      return res.status(200).json({
        audioUrl,       // null si OpenAI a échoué → front fallback SpeechSynthesis
        leaMode: true,
        ttsOnly: true,
      });
    }

    if (!question) return res.status(400).json({ error: 'Question manquante' });
    if (typeof question !== 'string' || question.length > 500) {
      return res.status(400).json({ error: 'Question invalide (max 500 caractères)' });
    }

    // ── Détection mode Léa ──
    const userDoc = await fsGet(`users/${auth.uid}`);
    const leaMode = hasLeaAccess(userDoc);

    let prompt, model, maxTokens;

    if (leaMode) {
      const memory = await loadLeaMemoryLight(auth.uid);
      prompt = buildLeaPrompt(question, metrics || {}, prenom, memory);
      model = 'claude-sonnet-4-5-20250929';
      maxTokens = 350; // court, c'est de l'oral
    } else {
      prompt = buildStandardPrompt(question, metrics || {}, prenom);
      model = 'claude-haiku-4-5-20251001';
      maxTokens = 300;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model, max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: 'Erreur API', details: errText.slice(0, 500) });
    }

    const data = await response.json();
    const text = (data.content?.[0]?.text || 'Désolé, je n\'ai pas pu analyser ta question.').trim();

    // ── TTS OpenAI en mode Léa ──
    let audioUrl = null;
    if (leaMode) {
      audioUrl = await generateAudioOpenAI(text);
    }

    return res.status(200).json({
      answer: text,
      leaMode,
      audioUrl,  // null si mode standard ou si OpenAI a échoué → front fallback SpeechSynthesis
    });

  } catch (err) {
    console.error('vocal-ai error:', err);
    return res.status(500).json({ error: err.message });
  }
}
