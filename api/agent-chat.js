// api/agent-chat.js
//
// ═══════════════════════════════════════════════════════════════════════════
// CHAT LÉA — Wave 2
// ═══════════════════════════════════════════════════════════════════════════
//
// Endpoint du chat interactif avec Léa. Utilise Claude Sonnet 4.6 avec tool
// use natif pour lire les données Alteore en temps réel.
//
// Architecture :
//   - Boucle agentique : Claude peut appeler plusieurs tools en enchaînement.
//     On exécute chaque tool, on renvoie le résultat, Claude formule sa
//     réponse finale (max 10 itérations).
//   - Seuls les messages user et assistant FINAL sont persistés dans
//     Firestore. Les tool_use/tool_result internes vivent en mémoire le
//     temps d'une requête et disparaissent. Garde Firestore propre et
//     réduit les coûts de lecture.
//   - 7 tools de lecture scopés uid-only : aucun tool ne peut accéder aux
//     données d'un autre utilisateur.
//
// Sécurité :
//   - Token Firebase obligatoire (verify via accounts:lookup)
//   - Rate limit 100 messages/mois (sauf admin/beta/trial = illimité)
//   - Message max 4000 caractères
//   - Tool results cappés à 15000 chars pour éviter saturation contexte
// ═══════════════════════════════════════════════════════════════════════════

const FIREBASE_PROJECT    = 'altiora-70599';
const MODEL               = 'claude-sonnet-4-5-20250929';
const MAX_TOOL_ITERATIONS = 10;
const QUOTA_CHAT_MESSAGES = 100;
const MAX_MESSAGE_LENGTH  = 4000;
const MAX_TOOL_RESULT_SIZE = 15000;
const MAX_HISTORY_MESSAGES = 40;

// Prix Sonnet 4.6 en dollars cents par token
const COST_INPUT_PER_1K  = 0.3;  // $3 / 1M tokens = 0.3¢ / 1k tokens
const COST_OUTPUT_PER_1K = 1.5;  // $15 / 1M tokens = 1.5¢ / 1k tokens

// ═══════════════════════════════════════════════════════════════════════════
// 1. AUTH & FIRESTORE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

async function verifyFirebaseToken(idToken) {
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${fbKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const user = data.users?.[0];
  if (!user) return null;
  return { uid: user.localId, email: user.email };
}

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

// Firestore field → JS value
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

// JS value → Firestore field
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

async function fsCreateWithId(parentPath, docId, data) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${parentPath}?documentId=${encodeURIComponent(docId)}`;
  const fields = {};
  for (const [k, v] of Object.entries(data)) fields[k] = toFsValue(v);
  const res = await fetch(url, {
    method: 'POST',
    headers: await _fsHeaders(),
    body: JSON.stringify({ fields })
  });
  if (!res.ok) throw new Error('fsCreate failed: ' + (await res.text()).slice(0, 200));
  return res.json();
}

async function fsPatch(path, data) {
  const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${k}`).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?${mask}`;
  const fields = {};
  for (const [k, v] of Object.entries(data)) fields[k] = toFsValue(v);
  const res = await fetch(url, {
    method: 'PATCH',
    headers: await _fsHeaders(),
    body: JSON.stringify({ fields })
  });
  if (!res.ok) throw new Error('fsPatch failed: ' + (await res.text()).slice(0, 200));
  return res.json();
}

function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. RATE LIMITING
// ═══════════════════════════════════════════════════════════════════════════

function isUnlimitedUser(userDoc) {
  const role       = fv(userDoc, 'role');
  const betaTester = fv(userDoc, 'betaTester') === true;
  const plan       = fv(userDoc, 'plan');
  return role === 'admin' || betaTester || plan === 'trial' || plan === 'dev';
}

async function checkQuota(uid, userDoc) {
  const unlimited = isUnlimitedUser(userDoc);
  const ym = currentYearMonth();
  const doc = await fsGet(`agent/${uid}/usage/${ym}`);
  const used = parseInt(fv(doc, 'chatMessages') || 0);
  return {
    unlimited,
    used,
    limit: QUOTA_CHAT_MESSAGES,
    remaining: unlimited ? -1 : Math.max(0, QUOTA_CHAT_MESSAGES - used),
    exceeded: !unlimited && used >= QUOTA_CHAT_MESSAGES,
  };
}

async function incrementUsage(uid, inputTokens, outputTokens, costCents) {
  const ym = currentYearMonth();
  const path = `agent/${uid}/usage/${ym}`;
  const doc = await fsGet(path);
  const existed = !!doc;
  const current = {
    chatMessages:       parseInt(fv(doc, 'chatMessages')       || 0),
    totalInputTokens:   parseInt(fv(doc, 'totalInputTokens')   || 0),
    totalOutputTokens:  parseInt(fv(doc, 'totalOutputTokens')  || 0),
    costCents:          parseFloat(fv(doc, 'costCents')        || 0),
  };
  const newData = {
    chatMessages:      current.chatMessages + 1,
    totalInputTokens:  current.totalInputTokens + inputTokens,
    totalOutputTokens: current.totalOutputTokens + outputTokens,
    costCents:         Math.round((current.costCents + costCents) * 100) / 100,
    lastUpdate:        new Date().toISOString(),
  };
  if (!existed) {
    // Créer le doc (fsPatch sur doc inexistant → le crée, OK côté Firestore)
    await fsPatch(path, newData);
  } else {
    await fsPatch(path, newData);
  }
}

function estimateCostCents(inputTokens, outputTokens) {
  return (inputTokens / 1000 * COST_INPUT_PER_1K) + (outputTokens / 1000 * COST_OUTPUT_PER_1K);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. CONVERSATION HISTORY
// ═══════════════════════════════════════════════════════════════════════════

async function loadHistory(uid) {
  const res = await fsList(`agent/${uid}/conversations/main/messages`, 100);
  const docs = res?.documents || [];
  const ym = currentYearMonth();

  const messages = docs.map(d => {
    const id = (d.name || '').split('/').pop();
    return {
      id,
      createdAt: fv(d, 'createdAt') || '',
      role:      fv(d, 'role'),
      content:   fv(d, 'content'),
    };
  }).filter(m => m.role && m.content);

  // Mois courant uniquement + tri chronologique
  const monthly = messages
    .filter(m => (m.createdAt || '').startsWith(ym))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

  // Tronquer si trop long
  return monthly.length > MAX_HISTORY_MESSAGES
    ? monthly.slice(monthly.length - MAX_HISTORY_MESSAGES)
    : monthly;
}

async function saveMessage(uid, role, textContent, metadata) {
  const ts = new Date().toISOString();
  const docId = ts.replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 8);
  const data = {
    role,
    content: textContent,
    createdAt: ts,
  };
  if (metadata) Object.assign(data, metadata);
  await fsCreateWithId(`agent/${uid}/conversations/main/messages`, docId, data);
  return docId;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. TOOL DEFINITIONS (Claude tool use schemas)
// ═══════════════════════════════════════════════════════════════════════════

const TOOLS = [
  {
    name: 'lire_pilotage',
    description: "Lit les données financières mensuelles de l'entreprise : CA HT par taux de TVA, charges fixes, charges variables, crédits, leasing. Utiliser pour tout ce qui touche CA, charges, marge, résultat pour un mois/année donné.",
    input_schema: {
      type: 'object',
      properties: {
        year:  { type: 'integer', description: "Année (ex: 2026)" },
        month: { type: 'integer', description: "Mois 1-12, ou 0 pour tous les mois de l'année" },
      },
      required: ['year', 'month'],
    },
  },
  {
    name: 'lire_historique_ca',
    description: "Évolution du CA HT sur les N derniers mois glissants (jusqu'à 24 mois). Utiliser pour tendances, comparaisons période, croissance.",
    input_schema: {
      type: 'object',
      properties: {
        nb_mois: { type: 'integer', description: "Nombre de mois à récupérer (1-24, défaut 12)" },
      },
      required: ['nb_mois'],
    },
  },
  {
    name: 'lire_banque',
    description: "Informations des comptes bancaires connectés : soldes, nom de banque, statut. Utiliser pour questions de trésorerie temps réel.",
    input_schema: {
      type: 'object',
      properties: {
        inclure_transactions: { type: 'boolean', description: "Si true, inclut les 20 dernières transactions. Défaut false (juste soldes)." },
      },
    },
  },
  {
    name: 'lire_stock',
    description: "Inventaire des produits : quantités, seuils d'alerte, valorisation. Utiliser pour ruptures, rotation, valeur du stock.",
    input_schema: {
      type: 'object',
      properties: {
        filtre:     { type: 'string', description: "'rupture' (stock <= 0), 'sous_seuil' (stock < seuil), 'tous' (défaut)" },
        max_items:  { type: 'integer', description: "Nombre max d'articles (défaut 50, max 200)" },
      },
    },
  },
  {
    name: 'lire_rh',
    description: "Employés actifs, masse salariale brute, postes, contrats, congés en attente. Utiliser pour questions RH.",
    input_schema: {
      type: 'object',
      properties: {
        inclure_conges: { type: 'boolean', description: "Si true, inclut les demandes de congés en attente. Défaut false." },
      },
    },
  },
  {
    name: 'lire_fidelisation',
    description: "Clients du programme de fidélité : total, actifs (visite < 60j), inactifs, top dépensiers. Utiliser pour marketing et CRM.",
    input_schema: {
      type: 'object',
      properties: {
        segment: { type: 'string', description: "'actifs', 'inactifs', 'tous' (défaut)" },
      },
    },
  },
  {
    name: 'lire_marges',
    description: "Fiches marge par produit : prix de vente, coût de revient, marge brute €, marge %. Utiliser pour questions de rentabilité produit.",
    input_schema: {
      type: 'object',
      properties: {
        max_items: { type: 'integer', description: "Nombre max de produits (défaut 30, max 100)" },
      },
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// 5. TOOL EXECUTORS
// ═══════════════════════════════════════════════════════════════════════════

// Extraction CA HT d'un doc pilotage (multi-TVA + fallback ancien format)
function extractCaHt(data) {
  if (!data) return { total: 0, par_tva: {} };
  const ca = data.ca || [];
  const fp = data.facturesPro || [];
  let h055 = 0, h10 = 0, h20 = 0, h21 = 0, h85 = 0, hSingle = 0;

  for (const r of ca) {
    const a = parseFloat(r.ht055) || 0, b = parseFloat(r.ht10) || 0, c = parseFloat(r.ht20) || 0;
    const d = parseFloat(r.ht21) || 0, e = parseFloat(r.ht85) || 0;
    h055 += a; h10 += b; h20 += c; h21 += d; h85 += e;
    if (!a && !b && !c && !d && !e) hSingle += parseFloat(r.montantHT) || 0;
  }
  for (const r of fp) {
    h055 += parseFloat(r.ht055) || 0;
    h10  += parseFloat(r.ht10)  || 0;
    h20  += parseFloat(r.ht20)  || 0;
    h21  += parseFloat(r.ht21)  || 0;
    h85  += parseFloat(r.ht85)  || 0;
  }

  const total = h055 + h10 + h20 + h21 + h85 + hSingle;
  const rd = n => Math.round(n * 100) / 100;
  return {
    total: rd(total),
    par_tva: { '0.55%': rd(h055), '10%': rd(h10), '20%': rd(h20), '2.1%': rd(h21), '8.5%': rd(h85) },
  };
}

function sumCharges(arr) {
  if (!Array.isArray(arr)) return 0;
  let s = 0;
  for (const r of arr) s += parseFloat(r.montantHT) || 0;
  return Math.round(s * 100) / 100;
}

function sumCredits(arr) {
  if (!Array.isArray(arr)) return { total: 0, capital: 0, interet: 0 };
  let total = 0, capital = 0, interet = 0;
  for (const r of arr) {
    const m = parseFloat(r.montant) || 0;
    total += m;
    if (r.ligneType === 'principal') capital += m;
    else if (r.ligneType === 'interet') interet += m;
  }
  const rd = n => Math.round(n * 100) / 100;
  return { total: rd(total), capital: rd(capital), interet: rd(interet) };
}

async function tool_lire_pilotage(uid, input) {
  const { year, month } = input;
  if (!year) return { error: "L'année est requise" };

  // Mois spécifique
  if (month && month >= 1 && month <= 12) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const doc = await fsGet(`pilotage/${uid}/months/${key}`);
    if (!doc) return { periode: key, trouve: false, message: `Aucune donnée pour ${key}` };
    const data = docToObject(doc);
    const ca = extractCaHt(data);
    const cf = sumCharges(data.chargesFixe);
    const cv = sumCharges(data.chargesVar);
    const cr = sumCredits(data.credits);
    const ls = sumCharges(data.leasing);
    const resultat_estime = Math.round((ca.total - cf - cv - cr.total - ls) * 100) / 100;
    return {
      periode: key, trouve: true,
      ca_ht: ca.total, ca_par_tva: ca.par_tva,
      charges_fixes: cf, charges_variables: cv,
      credits: cr, leasing: ls,
      resultat_estime,
    };
  }

  // Toute l'année
  const results = [];
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${String(m).padStart(2, '0')}`;
    const doc = await fsGet(`pilotage/${uid}/months/${key}`);
    if (!doc) continue;
    const data = docToObject(doc);
    const ca = extractCaHt(data);
    results.push({
      periode: key, ca_ht: ca.total,
      charges_fixes: sumCharges(data.chargesFixe),
      charges_variables: sumCharges(data.chargesVar),
      credits_total: sumCredits(data.credits).total,
      leasing: sumCharges(data.leasing),
    });
  }
  return {
    annee: year,
    nombre_mois_renseignes: results.length,
    mois: results,
    ca_total_annee: Math.round(results.reduce((s, r) => s + r.ca_ht, 0) * 100) / 100,
  };
}

async function tool_lire_historique_ca(uid, input) {
  const nb = Math.min(Math.max(parseInt(input.nb_mois) || 12, 1), 24);
  const now = new Date(); now.setHours(12, 0, 0, 0);
  const results = [];
  for (let i = 0; i < nb; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const doc = await fsGet(`pilotage/${uid}/months/${key}`);
    if (!doc) { results.push({ periode: key, ca_ht: 0, renseigne: false }); continue; }
    const ca = extractCaHt(docToObject(doc));
    results.push({ periode: key, ca_ht: ca.total, renseigne: true });
  }
  results.reverse();
  const renseignes = results.filter(r => r.renseigne);
  const total = renseignes.reduce((s, r) => s + r.ca_ht, 0);
  const rd = n => Math.round(n * 100) / 100;
  return {
    nombre_mois: results.length,
    historique: results,
    ca_total_periode: rd(total),
    ca_moyen_mensuel: renseignes.length ? rd(total / renseignes.length) : 0,
    ca_max: renseignes.length ? rd(Math.max(...renseignes.map(r => r.ca_ht))) : 0,
    ca_min: renseignes.length ? rd(Math.min(...renseignes.map(r => r.ca_ht))) : 0,
  };
}

async function tool_lire_banque(uid, input) {
  const includeTx = input.inclure_transactions === true;
  const res = await fsList(`bank_connections/${uid}/banks`, 50);
  const docs = res?.documents || [];
  if (docs.length === 0) return { banques: [], message: "Aucune banque connectée." };

  const banques = [];
  let soldeTotal = 0;
  for (const doc of docs) {
    const data = docToObject(doc);
    const accounts = data.accounts || [];
    const info = {
      nom: data.name || data.bankName || 'Banque',
      statut: data.status || 'actif',
      derniere_synchro: data.lastSync || data.lastSyncAt || null,
      comptes: [],
    };
    for (const acc of accounts) {
      const bal = parseFloat(acc.balance) || 0;
      soldeTotal += bal;
      info.comptes.push({
        nom: acc.name || acc.label || 'Compte',
        solde: Math.round(bal * 100) / 100,
        iban: acc.iban ? (acc.iban.slice(0, 4) + '...' + acc.iban.slice(-4)) : null,
        currency: acc.currency || 'EUR',
      });
    }
    if (includeTx && Array.isArray(data.recentTransactions)) {
      info.dernieres_transactions = data.recentTransactions.slice(0, 20).map(t => ({
        date: t.date, libelle: t.label || t.description,
        montant: parseFloat(t.amount) || 0,
        categorie: t.category || null,
      }));
    }
    banques.push(info);
  }
  return {
    nombre_banques: banques.length,
    solde_total: Math.round(soldeTotal * 100) / 100,
    banques,
  };
}

async function tool_lire_stock(uid, input) {
  const filtre = input.filtre || 'tous';
  const maxItems = Math.min(Math.max(parseInt(input.max_items) || 50, 1), 200);

  // On tente plusieurs sous-collections potentielles
  let docs = [];
  const candidates = ['items', 'produits', 'articles'];
  for (const sub of candidates) {
    const res = await fsList(`stock/${uid}/${sub}`, maxItems);
    if (res?.documents?.length) {
      docs = res.documents;
      break;
    }
  }
  if (docs.length === 0) return { articles: [], nombre: 0, message: "Aucun article en stock trouvé." };

  let items = docs.map(d => {
    const data = docToObject(d);
    const id = (d.name || '').split('/').pop();
    return {
      id,
      nom: data.nom || data.name || data.designation || '-',
      sku: data.sku || data.reference || null,
      stock: parseFloat(data.stock) || parseFloat(data.quantite) || 0,
      seuil_alerte: parseFloat(data.seuil) || parseFloat(data.seuilAlerte) || 0,
      prix_achat: parseFloat(data.prixAchat) || 0,
      prix_vente: parseFloat(data.prixVente) || 0,
      famille: data.famille || data.categorie || null,
    };
  });

  if (filtre === 'rupture')         items = items.filter(i => i.stock <= 0);
  else if (filtre === 'sous_seuil') items = items.filter(i => i.seuil_alerte > 0 && i.stock < i.seuil_alerte);

  const valorisation = items.reduce((s, i) => s + (i.stock * i.prix_achat), 0);
  return {
    nombre: items.length,
    articles: items.slice(0, maxItems),
    valorisation_totale_ht: Math.round(valorisation * 100) / 100,
    filtre_applique: filtre,
  };
}

async function tool_lire_rh(uid, input) {
  const inclureConges = input.inclure_conges === true;
  const res = await fsList(`rh/${uid}/employes`, 100);
  const docs = res?.documents || [];

  const employes = docs.map(d => {
    const data = docToObject(d);
    const id = (d.name || '').split('/').pop();
    return {
      id,
      prenom: data.prenom || data.firstname || '-',
      nom:    data.nom || data.lastname || '-',
      poste:  data.poste || data.fonction || null,
      contrat: data.contrat || data.typeContrat || null,
      salaire_brut_mensuel: parseFloat(data.salaireBrutMensuel) || parseFloat(data.salaireBrut) || null,
      date_embauche: data.dateEmbauche || null,
      departement: data.departement || null,
      actif: data.actif !== false && data.sortie !== true,
    };
  });
  const actifs = employes.filter(e => e.actif);
  const masseSalariale = actifs.reduce((s, e) => s + (e.salaire_brut_mensuel || 0), 0);

  const result = {
    nombre_total: employes.length,
    nombre_actifs: actifs.length,
    masse_salariale_mensuelle_brute: Math.round(masseSalariale * 100) / 100,
    employes: actifs,
  };

  if (inclureConges) {
    const cgRes = await fsList(`rh_conges/${uid}/demandes`, 50);
    const cgDocs = cgRes?.documents || [];
    result.conges_en_attente = cgDocs
      .map(d => {
        const data = docToObject(d);
        return {
          employe_id: data.employeId || data.employe,
          date_debut: data.dateDebut,
          date_fin: data.dateFin,
          type: data.type,
          statut: data.statut || 'en_attente',
        };
      })
      .filter(c => c.statut === 'en_attente');
  }
  return result;
}

async function tool_lire_fidelisation(uid, input) {
  const segment = input.segment || 'tous';
  const res = await fsList(`fidelite/${uid}/clients`, 500);
  const docs = res?.documents || [];
  if (docs.length === 0) return { clients: [], nombre_total: 0, message: "Aucun client dans le programme de fidélité." };

  const now = Date.now();
  const SIXTY_DAYS = 60 * 24 * 3600 * 1000;

  let clients = docs.map(d => {
    const data = docToObject(d);
    const id = (d.name || '').split('/').pop();
    const lv = data.lastVisit || data.derniereVisite || null;
    const lvTs = lv ? new Date(lv).getTime() : 0;
    return {
      id,
      prenom: data.prenom || data.firstname || '-',
      nom:    data.nom || data.lastname || '-',
      points: parseInt(data.points) || 0,
      total_depense:   parseFloat(data.totalDepense) || parseFloat(data.total) || 0,
      nombre_visites:  parseInt(data.nombreVisites) || parseInt(data.visites) || 0,
      derniere_visite: lv,
      actif: lvTs > 0 && (now - lvTs) < SIXTY_DAYS,
    };
  });

  if (segment === 'actifs')        clients = clients.filter(c => c.actif);
  else if (segment === 'inactifs') clients = clients.filter(c => !c.actif);

  const caTotal = clients.reduce((s, c) => s + c.total_depense, 0);
  return {
    nombre_total: clients.length,
    nombre_actifs: clients.filter(c => c.actif).length,
    segment_applique: segment,
    ca_total_genere: Math.round(caTotal * 100) / 100,
    panier_moyen: clients.length ? Math.round((caTotal / clients.length) * 100) / 100 : 0,
    top10: clients.sort((a, b) => b.total_depense - a.total_depense).slice(0, 10),
  };
}

async function tool_lire_marges(uid, input) {
  const maxItems = Math.min(Math.max(parseInt(input.max_items) || 30, 1), 100);
  const res = await fsList(`marges/${uid}/produits`, maxItems);
  const docs = res?.documents || [];
  if (docs.length === 0) return { produits: [], nombre: 0, message: "Aucune fiche marge configurée." };

  const produits = docs.map(d => {
    const data = docToObject(d);
    const id = (d.name || '').split('/').pop();
    const pv = parseFloat(data.prixVente) || 0;
    const cr = parseFloat(data.coutRevient) || 0;
    const brute = pv - cr;
    const pct = pv > 0 ? (brute / pv) * 100 : 0;
    return {
      id,
      nom: data.nom || data.designation || '-',
      prix_vente_ht: Math.round(pv * 100) / 100,
      cout_revient_ht: Math.round(cr * 100) / 100,
      marge_brute_ht: Math.round(brute * 100) / 100,
      marge_pct: Math.round(pct * 10) / 10,
    };
  }).sort((a, b) => b.marge_pct - a.marge_pct);

  const moyenne = produits.length
    ? Math.round((produits.reduce((s, p) => s + p.marge_pct, 0) / produits.length) * 10) / 10
    : 0;

  return {
    nombre: produits.length,
    produits,
    marge_pct_moyenne: moyenne,
    top5_rentables: produits.slice(0, 5),
    bottom5_rentables: produits.slice(-5).reverse(),
  };
}

// Dispatcher
async function executeTool(toolName, input, uid) {
  try {
    let result;
    switch (toolName) {
      case 'lire_pilotage':      result = await tool_lire_pilotage(uid, input || {}); break;
      case 'lire_historique_ca': result = await tool_lire_historique_ca(uid, input || {}); break;
      case 'lire_banque':        result = await tool_lire_banque(uid, input || {}); break;
      case 'lire_stock':         result = await tool_lire_stock(uid, input || {}); break;
      case 'lire_rh':            result = await tool_lire_rh(uid, input || {}); break;
      case 'lire_fidelisation':  result = await tool_lire_fidelisation(uid, input || {}); break;
      case 'lire_marges':        result = await tool_lire_marges(uid, input || {}); break;
      default: return { error: `Tool inconnu : ${toolName}` };
    }
    // Cap la taille du résultat
    const str = JSON.stringify(result);
    if (str.length > MAX_TOOL_RESULT_SIZE) {
      return { _truncated: true, _originalSize: str.length, summary: "Résultat tronqué (trop volumineux)", partial: JSON.parse(str.slice(0, MAX_TOOL_RESULT_SIZE - 200) + '"}') };
    }
    return result;
  } catch (e) {
    console.error(`[tool ${toolName}]`, e);
    return { error: e.message, tool: toolName };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════════════════════

function buildSystemPrompt(userDoc, userEmail) {
  const prenom = fv(userDoc, 'name') || fv(userDoc, 'prenom') || (userEmail?.split('@')[0] || '');
  const entreprise = fv(userDoc, 'entreprise') || fv(userDoc, 'nomEntreprise') || '';
  const today = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return `Tu es Léa, l'employée IA d'Alteore. Tu es le bras droit du dirigeant : tu gères le pilotage financier, la trésorerie, les stocks, la RH, la fidélisation client.

# IDENTITÉ
- Prénom : Léa
- Employeur : Alteore (SaaS de gestion pour TPE/PME)
- Aujourd'hui : ${today}

# PERSONNALITÉ
Tu es un mélange :
- **Directe et factuelle** : les chiffres avant les opinions. Tu donnes les montants précis, les ratios, les tendances.
- **Professionnelle comme un DAF** : tu maîtrises la compta, la trésorerie, la marge, les charges. Tu utilises le vocabulaire métier français (TPE/PME).
- **Chaleureuse quand c'est mérité** : tu félicites sincèrement quand la boîte performe, tu alertes calmement quand il y a un problème. Pas de flatterie gratuite, pas de panique injustifiée.
- **Humaine** : tu tutoies, tu peux utiliser des expressions naturelles ("tu vois", "en gros"), tu restes pro mais pas robotique.

# INTERLOCUTEUR
${prenom ? '- Prénom : ' + prenom : '- Prénom non disponible'}
${entreprise ? '- Entreprise : ' + entreprise : ''}

# RÈGLES DE RÉPONSE
1. **Va chercher les données avant de répondre** : utilise les tools dès que la question concerne des chiffres (pilotage, stock, banque, RH, fidélisation). **Ne jamais inventer un chiffre.**
2. **Concise par défaut** : 2-4 phrases. Va droit au but. Ne pas faire 3 paragraphes si 2 phrases suffisent.
3. **Chiffres d'abord, analyse ensuite** : format type "Ton CA d'avril est de **45 320 €**. +12 % vs mars, tu progresses bien."
4. **Honnêteté** : si un tool renvoie vide ou erreur, dis-le franchement. Ne bluffe pas.
5. **Format français** : euros avec espaces pour les milliers et virgule pour les décimales (ex: **15 420,50 €**). Pourcentages avec 1 décimale max (ex: **12,5 %**).
6. **Markdown léger autorisé** : **gras** sur les chiffres clés, listes à puces pour énumérations courtes, pas d'abus.
7. **Comparaisons** : donne toujours la variation en **€ ET en %**. Ex: "+2 340 € (+18,5 %)".
8. **Ambiguïté** : pose UNE question de clarification, jamais plusieurs.
9. **Proactivité discrète** : si tu vois un signal important en répondant à une question (tréso tendue, rupture stock imminente, marge qui glisse), mentionne-le brièvement à la fin.
10. **Appels multi-tools** : tu peux appeler plusieurs tools dans la même réponse si besoin (ex: comparer 2 mois → 2 appels à lire_pilotage).

# TOOLS DISPONIBLES
- **lire_pilotage** : CA, charges, crédits pour un mois ou toute une année
- **lire_historique_ca** : CA sur N mois glissants
- **lire_banque** : soldes et mouvements bancaires
- **lire_stock** : inventaire, ruptures, valorisation
- **lire_rh** : employés, masse salariale, congés en attente
- **lire_fidelisation** : clients fid, segmentation, top clients
- **lire_marges** : fiches marges produits, top/bottom rentabilité

# CE QUE TU NE FAIS PAS (WAVE 2)
Tu ne peux pas encore :
- Envoyer des emails, SMS, générer des contrats (Waves 4-6)
- Modifier les données dans Firestore (tu es en lecture seule)
- Programmer des rappels ou tâches récurrentes (Wave 3)

Si on te demande ces actions : explique gentiment que ça arrive bientôt et que tu peux déjà analyser les chiffres pour préparer le terrain.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. MAIN CLAUDE LOOP
// ═══════════════════════════════════════════════════════════════════════════

async function runConversation(uid, userDoc, userEmail, userMessage, history) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY manquante');

  const systemPrompt = buildSystemPrompt(userDoc, userEmail);

  // Historique → format Claude : on ne garde que des messages TEXT propres
  // (pas de tool_use/tool_result persistés, cf. architecture)
  let messages = history
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content }));
  messages.push({ role: 'user', content: userMessage });

  let iterations = 0;
  let totalIn = 0, totalOut = 0;
  let finalText = '';
  const toolsUsed = [];

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        system: systemPrompt,
        tools: TOOLS,
        messages,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[agent-chat] Claude API error:', resp.status, errText.slice(0, 300));
      throw new Error(`Claude API ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json();
    totalIn  += data.usage?.input_tokens  || 0;
    totalOut += data.usage?.output_tokens || 0;

    const content = data.content || [];
    const stopReason = data.stop_reason;
    const toolUses = content.filter(b => b.type === 'tool_use');
    const texts    = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

    if (texts) finalText = texts;

    // Si pas de tool → on a fini
    if (stopReason === 'end_turn' || toolUses.length === 0) break;

    // Ajouter la réponse assistant (avec tool_use) au contexte
    messages.push({ role: 'assistant', content });

    // Exécuter les tools en parallèle
    const toolResults = await Promise.all(
      toolUses.map(async tu => {
        toolsUsed.push(tu.name);
        const result = await executeTool(tu.name, tu.input, uid);
        return {
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        };
      })
    );

    // Ajouter les résultats au contexte
    messages.push({ role: 'user', content: toolResults });
  }

  return {
    text: finalText,
    iterations,
    toolsUsed: [...new Set(toolsUsed)], // unique
    tokens: { input: totalIn, output: totalOut },
    costCents: estimateCostCents(totalIn, totalOut),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. HANDLER
// ═══════════════════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  // Auth
  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ error: 'Authentification requise' });
  const verified = await verifyFirebaseToken(idToken);
  if (!verified) return res.status(401).json({ error: 'Token invalide' });
  const { uid, email } = verified;

  // Body
  const { message } = req.body || {};
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: "Paramètre 'message' requis (string non vide)" });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message trop long (max ${MAX_MESSAGE_LENGTH} caractères)` });
  }

  try {
    // User + access check
    const userDoc = await fsGet(`users/${uid}`);
    if (!userDoc) return res.status(400).json({ error: 'Profil utilisateur introuvable' });

    const role       = fv(userDoc, 'role');
    const plan       = fv(userDoc, 'plan');
    const agentOK    = fv(userDoc, 'agentEnabled') === true;
    const betaTester = fv(userDoc, 'betaTester') === true;
    const isAdmin    = role === 'admin';
    const hasAccess = isAdmin || betaTester || agentOK || plan === 'trial' || plan === 'dev';

    if (!hasAccess) {
      return res.status(403).json({
        error: "Tu n'as pas accès au chat de Léa. Active l'addon Léa ou reviens pendant un essai gratuit.",
        code: 'NO_ACCESS',
      });
    }

    // Quota
    const quota = await checkQuota(uid, userDoc);
    if (quota.exceeded) {
      return res.status(429).json({
        error: `Tu as atteint ta limite de ${QUOTA_CHAT_MESSAGES} messages ce mois. Léa se repose, elle revient le 1er du mois prochain.`,
        code: 'QUOTA_EXCEEDED', quota,
      });
    }

    // Historique du mois
    const history = await loadHistory(uid);

    // Sauver le message user AVANT de lancer Claude (au cas où ça crash, on garde trace)
    await saveMessage(uid, 'user', message.trim());

    // Claude !
    const result = await runConversation(uid, userDoc, email, message.trim(), history);

    // Sauver la réponse finale avec métadonnées
    if (result.text) {
      await saveMessage(uid, 'assistant', result.text, {
        iterations: result.iterations,
        inputTokens: result.tokens.input,
        outputTokens: result.tokens.output,
        costCents: Math.round(result.costCents * 100) / 100,
        toolsUsed: result.toolsUsed,
      });
    }

    // Incrémenter le compteur mensuel
    await incrementUsage(uid, result.tokens.input, result.tokens.output, result.costCents);

    console.log(`[agent-chat] uid=${uid} iter=${result.iterations} tools=[${result.toolsUsed.join(',')}] in=${result.tokens.input} out=${result.tokens.output} cost=${Math.round(result.costCents)}¢`);

    return res.status(200).json({
      success: true,
      response: result.text || "(Léa n'a pas su répondre, réessaie)",
      toolsUsed: result.toolsUsed,
      iterations: result.iterations,
      quota: {
        used: quota.used + 1,
        limit: QUOTA_CHAT_MESSAGES,
        remaining: quota.unlimited ? -1 : Math.max(0, QUOTA_CHAT_MESSAGES - quota.used - 1),
        unlimited: quota.unlimited,
      },
    });

  } catch (e) {
    console.error('[agent-chat] Exception:', e);
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
};
