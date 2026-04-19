// api/agent-memory-refresh.js
//
// ═══════════════════════════════════════════════════════════════════════════
// RÉGÉNÉRATION DU RÉSUMÉ BUSINESS (Wave 3)
// ═══════════════════════════════════════════════════════════════════════════
//
// Appelé par :
//   - Cron hebdo chaque lundi 3h UTC (api/cron-agent-memory-refresh.js)
//   - Action manuelle UI (api/agent-memory.js action: 'refresh_summary')
//
// Méthode d'appel :
//   - Cron : Authorization = Bearer CRON_SECRET
//   - Depuis agent-memory.js (action manuelle) : Authorization = Bearer CRON_SECRET
//
// Pour un uid donné :
//   1. Lit un snapshot de l'activité : pilotage 6 derniers mois, profil
//      entreprise, employés, clients fid, marges, historique CA 12 mois
//   2. Demande à Claude Sonnet de synthétiser en un texte ~1500-2500 caractères
//   3. Écrit dans agent/{uid}/memory/business-summary
//
// Coût estimé : ~0.10-0.20€ par régénération. Pour 100 clients = 10-20€/sem
// soit 40-80€/mois. À surveiller.
// ═══════════════════════════════════════════════════════════════════════════

const FIREBASE_PROJECT = 'altiora-70599';
const MODEL = 'claude-sonnet-4-5-20250929';

// ── Firestore helpers (pattern standard) ──

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
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

async function _fsHeaders() {
  const token = await getAdminToken();
  const h = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = 'Bearer ' + token;
  return h;
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
  if (f.stringValue !== undefined)    return f.stringValue;
  if (f.integerValue !== undefined)   return parseInt(f.integerValue);
  if (f.doubleValue !== undefined)    return parseFloat(f.doubleValue);
  if (f.booleanValue !== undefined)   return f.booleanValue;
  if (f.timestampValue !== undefined) return f.timestampValue;
  if (f.nullValue !== undefined)      return null;
  if (f.arrayValue !== undefined)     return (f.arrayValue.values || []).map(fvRaw);
  if (f.mapValue !== undefined) {
    const out = {};
    for (const [k, v] of Object.entries(f.mapValue.fields || {})) out[k] = fvRaw(v);
    return out;
  }
  return null;
}

function fv(doc, field) { return fvRaw(doc?.fields?.[field]); }

function docToObject(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc?.fields || {})) out[k] = fvRaw(v);
  return out;
}

function toFsValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string')           return { stringValue: val };
  if (typeof val === 'boolean')          return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFsValue) } };
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) fields[k] = toFsValue(v);
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

async function fsPatch(path, data) {
  // Firestore REST : PATCH avec updateMask = upsert (crée le doc si absent, maj sinon).
  // On ne passe PAS currentDocument.exists pour garder ce comportement.
  const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?${mask}`;
  const fields = {};
  for (const [k, v] of Object.entries(data)) fields[k] = toFsValue(v);
  const res = await fetch(url, {
    method: 'PATCH',
    headers: await _fsHeaders(),
    body: JSON.stringify({ fields })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`fsPatch failed (${res.status}): ${txt.slice(0, 300)}`);
  }
  return res.json();
}

// ── Helpers CA (copiés de agent-chat.js) ──
function extractCaHt(data) {
  if (!data) return 0;
  const ca = data.ca || [], fp = data.facturesPro || [];
  let s = 0;
  for (const r of ca) {
    const a = parseFloat(r.ht055) || 0, b = parseFloat(r.ht10) || 0, c = parseFloat(r.ht20) || 0;
    const d = parseFloat(r.ht21) || 0, e = parseFloat(r.ht85) || 0;
    s += a + b + c + d + e;
    if (!a && !b && !c && !d && !e) s += parseFloat(r.montantHT) || 0;
  }
  for (const r of fp) {
    s += (parseFloat(r.ht055) || 0) + (parseFloat(r.ht10) || 0) + (parseFloat(r.ht20) || 0)
       + (parseFloat(r.ht21) || 0) + (parseFloat(r.ht85) || 0);
  }
  return Math.round(s * 100) / 100;
}

function sumArr(arr, key = 'montantHT') {
  if (!Array.isArray(arr)) return 0;
  let s = 0;
  for (const r of arr) s += parseFloat(r[key]) || 0;
  return Math.round(s * 100) / 100;
}

// ═══════════════════════════════════════════════════════════════════════════
// Snapshot business : rassemble toutes les données clés pour Claude
// ═══════════════════════════════════════════════════════════════════════════

async function buildBusinessSnapshot(uid) {
  const snapshot = {};

  // 1. Profil entreprise
  const profilDoc = await fsGet(`profil/${uid}/data/main`);
  if (profilDoc) {
    const p = docToObject(profilDoc);
    snapshot.profil = {
      nom: p.nomEntreprise || p.nom || null,
      secteur: p.secteur || p.activite || null,
      forme_juridique: p.formeJuridique || null,
      siret: p.siret || null,
      cp_ville: p.cp && p.ville ? `${p.cp} ${p.ville}` : null,
      effectif: p.effectif || null,
    };
  }

  // 2. User doc (prénom, plan)
  const userDoc = await fsGet(`users/${uid}`);
  if (userDoc) {
    snapshot.dirigeant = {
      prenom: fv(userDoc, 'name') || fv(userDoc, 'prenom') || null,
      plan: fv(userDoc, 'plan') || null,
    };
  }

  // 3. Pilotage : 6 derniers mois
  const now = new Date(); now.setHours(12, 0, 0, 0);
  const mois = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const doc = await fsGet(`pilotage/${uid}/months/${key}`);
    if (!doc) { mois.push({ periode: key, renseigne: false }); continue; }
    const data = docToObject(doc);
    mois.push({
      periode: key,
      renseigne: true,
      ca_ht: extractCaHt(data),
      charges_fixes: sumArr(data.chargesFixe),
      charges_variables: sumArr(data.chargesVar),
      leasing: sumArr(data.leasing),
    });
  }
  mois.reverse();
  snapshot.pilotage_6_mois = mois;

  // 4. Historique CA 12 mois (juste les chiffres)
  const historique = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const doc = await fsGet(`pilotage/${uid}/months/${key}`);
    const ca = doc ? extractCaHt(docToObject(doc)) : 0;
    historique.push({ periode: key, ca_ht: ca });
  }
  historique.reverse();
  snapshot.historique_12_mois = historique;

  // 5. Employés
  const empRes = await fsList(`rh/${uid}/employes`, 100);
  const empDocs = empRes?.documents || [];
  snapshot.rh = {
    nombre_employes: empDocs.length,
    actifs: empDocs.filter(d => fv(d, 'actif') !== false).length,
    masse_salariale_brute_mensuelle: empDocs.reduce((s, d) => {
      const sal = parseFloat(fv(d, 'salaireBrutMensuel') || fv(d, 'salaireBrut') || 0);
      return s + (fv(d, 'actif') !== false ? sal : 0);
    }, 0),
    postes: [...new Set(empDocs.map(d => fv(d, 'poste') || fv(d, 'fonction')).filter(Boolean))],
  };

  // 6. Fidélisation (stats seulement, pas la liste)
  const fidRes = await fsList(`fidelite/${uid}/clients`, 500);
  const fidDocs = fidRes?.documents || [];
  if (fidDocs.length > 0) {
    const now2 = Date.now();
    const SIXTY_DAYS = 60 * 24 * 3600 * 1000;
    let actifs = 0;
    let caTotal = 0;
    for (const d of fidDocs) {
      const lv = fv(d, 'lastVisit') || fv(d, 'derniereVisite');
      if (lv && (now2 - new Date(lv).getTime()) < SIXTY_DAYS) actifs++;
      caTotal += parseFloat(fv(d, 'totalDepense') || fv(d, 'total') || 0);
    }
    snapshot.fidelisation = {
      nombre_clients: fidDocs.length,
      clients_actifs_60j: actifs,
      ca_total_genere: Math.round(caTotal * 100) / 100,
    };
  }

  // 7. Marges (stats agrégées)
  const margesRes = await fsList(`marges/${uid}/produits`, 100);
  const margesDocs = margesRes?.documents || [];
  if (margesDocs.length > 0) {
    const margins = margesDocs.map(d => {
      const pv = parseFloat(fv(d, 'prixVente') || 0);
      const cr = parseFloat(fv(d, 'coutRevient') || 0);
      return pv > 0 ? ((pv - cr) / pv) * 100 : 0;
    });
    snapshot.marges = {
      nombre_produits: margesDocs.length,
      marge_moyenne_pct: Math.round((margins.reduce((s, m) => s + m, 0) / margins.length) * 10) / 10,
      marge_max_pct: Math.round(Math.max(...margins) * 10) / 10,
      marge_min_pct: Math.round(Math.min(...margins) * 10) / 10,
    };
  }

  // 8. Faits déjà mémorisés (pour que Claude en tienne compte et ne re-résume pas)
  const factsRes = await fsList(`agent/${uid}/memory-facts`, 50);
  const factsDocs = factsRes?.documents || [];
  snapshot.faits_deja_memorises = factsDocs
    .map(d => fv(d, 'fait'))
    .filter(Boolean)
    .slice(0, 30);

  return snapshot;
}

// ═══════════════════════════════════════════════════════════════════════════
// Génération du résumé via Claude
// ═══════════════════════════════════════════════════════════════════════════

async function generateSummary(snapshot) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY manquante');

  const prompt = `Tu es Léa, employée IA d'Alteore. Tu dois écrire un résumé de synthèse du business du dirigeant que tu accompagnes. Ce résumé te sera présenté au début de chaque conversation future pour que tu aies toujours le contexte en tête.

Voici toutes les données disponibles aujourd'hui :

\`\`\`json
${JSON.stringify(snapshot, null, 2)}
\`\`\`

Rédige un résumé business en 1500 à 2500 caractères qui couvre :
1. **Identité** : type d'entreprise, secteur, dirigeant, plan Alteore
2. **Taille & forme** : effectif, forme juridique, localisation
3. **Activité financière** : niveau de CA (moyen mensuel des 12 derniers mois), tendance (hausse, stable, baisse), saisonnalité éventuelle détectée, mois exceptionnels à la hausse ou à la baisse
4. **Structure de charges** : ratio charges/CA, leasing, présence de crédits
5. **RH** : nombre d'employés actifs, masse salariale, postes
6. **Commerce** : si fidélisation présente, nombre de clients actifs, CA généré
7. **Rentabilité produit** : si marges configurées, marge moyenne et dispersion
8. **Particularités** : tout ce qui ressort comme atypique ou remarquable

RÈGLES :
- Style informatif, factuel, en français. Pas de salutation, pas de signature.
- Structure en paragraphes courts (pas de listes à puces).
- Chiffres précis au format français (**15 420 €**, **12,5 %**).
- Ne pas inclure d'infos non présentes dans le snapshot (pas d'invention).
- Si une section n'a pas de données, passe à la suivante sans mentionner l'absence.
- Les faits déjà mémorisés peuvent être utilisés comme contexte mais ne doivent pas être recopiés tels quels.
- Pense à ce résumé comme "ce que je dois savoir pour comprendre ce dirigeant dans 3 mois".

Réponds uniquement avec le texte du résumé, rien d'autre.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

  return {
    text,
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Handler
// ═══════════════════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Auth : interne uniquement (CRON_SECRET via Authorization)
  const authHeader = req.headers['authorization'] || '';
  const providedSecret = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const cronSecret = process.env.CRON_SECRET || 'internal';
  if (providedSecret !== cronSecret) {
    return res.status(401).json({ error: 'Non autorisé (secret requis)' });
  }

  const { uid, trigger } = req.body || {};
  if (!uid) return res.status(400).json({ error: "Paramètre 'uid' requis" });

  // Marquer le début pour le rate limit (même en cas d'échec, on enregistre la tentative)
  const startedAt = new Date().toISOString();
  try {
    await fsPatch(`agent/${uid}/memory/business-summary`, {
      lastRefreshAttempt: startedAt,
    });
  } catch (e) {
    // Non bloquant
    console.warn('[memory-refresh] mark attempt failed:', e.message);
  }

  try {
    console.log(`[memory-refresh] uid=${uid} trigger=${trigger || 'unknown'}`);

    const snapshot = await buildBusinessSnapshot(uid);
    const result = await generateSummary(snapshot);

    if (!result.text || result.text.length < 100) {
      throw new Error('Résumé généré trop court ou vide');
    }

    // Lire la version actuelle pour incrémenter
    const current = await fsGet(`agent/${uid}/memory/business-summary`);
    const currentVersion = parseInt(fv(current, 'version') || 0);

    await fsPatch(`agent/${uid}/memory/business-summary`, {
      text: result.text,
      generatedAt: new Date().toISOString(),
      version: currentVersion + 1,
      trigger: trigger || 'unknown',
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });

    console.log(`[memory-refresh] ✅ uid=${uid} version=${currentVersion + 1} chars=${result.text.length} in=${result.inputTokens} out=${result.outputTokens}`);

    return res.status(200).json({
      success: true,
      version: currentVersion + 1,
      chars: result.text.length,
      tokens: { input: result.inputTokens, output: result.outputTokens },
    });

  } catch (e) {
    console.error('[memory-refresh] Exception:', e);
    return res.status(500).json({ error: e.message });
  }
};
