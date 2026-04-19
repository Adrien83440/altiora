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
  // Upsert : crée le doc si absent, maj sinon.
  const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
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

// Supprime un document Firestore (Wave 3.9)
async function fsDelete(path) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: await _fsHeaders(),
  });
  // 404 est OK (déjà supprimé), les autres codes >= 400 sont des erreurs
  if (!res.ok && res.status !== 404) {
    throw new Error('fsDelete failed: ' + (await res.text()).slice(0, 200));
  }
  return { deleted: res.ok };
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

  // ── WAVE 3.8 : lecture étendue ──
  {
    name: 'lire_planning_rh',
    description: "Planning RH : horaires et shifts des employés sur une période. Utiliser pour questions sur qui travaille quand, qui est de repos, quels horaires un employé a cette semaine, le planning du mois, etc. Par défaut renvoie les 2 prochaines semaines.",
    input_schema: {
      type: 'object',
      properties: {
        date_debut: { type: 'string', description: "Date de début YYYY-MM-DD (défaut: aujourd'hui)" },
        date_fin: { type: 'string', description: "Date de fin YYYY-MM-DD (défaut: aujourd'hui + 14 jours)" },
        employe_id: { type: 'string', description: "Filtrer sur un employé spécifique (optionnel)" },
      },
    },
  },
  {
    name: 'lire_emargements_rh',
    description: "Émargements et pointages : heures effectivement travaillées par les employés, état des fiches mensuelles (signées ou pas), historique des arrivées/départs. Utiliser pour questions sur les heures réelles vs planning, suivi du temps de travail, conformité des fiches d'émargement.",
    input_schema: {
      type: 'object',
      properties: {
        mois: { type: 'string', description: "Mois cible YYYY-MM (défaut: mois courant)" },
        employe_id: { type: 'string', description: "Filtrer sur un employé (optionnel)" },
      },
    },
  },
  {
    name: 'lire_conges_complets',
    description: "Historique complet des congés : approuvés, en attente, refusés, tous types (CP, RTT, maladie, etc.). Utiliser pour questions sur les soldes congés, l'historique de congés d'un employé, les demandes en attente à traiter, la planification des absences.",
    input_schema: {
      type: 'object',
      properties: {
        statut: { type: 'string', description: "'tous' (défaut), 'en_attente', 'approuve', 'refuse'" },
        annee: { type: 'integer', description: "Année cible (ex: 2026). Sans ce filtre = toutes années." },
      },
    },
  },
  {
    name: 'lire_cashflow',
    description: "Trésorerie : solde de départ configuré + projection du mois courant (CA - charges - crédits - leasing). Utiliser pour questions sur la tréso, la santé financière court terme, combien il reste sur le compte en fin de mois, si la boîte est dans le vert ou rouge ce mois-ci.",
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'lire_dettes',
    description: "Dettes de l'entreprise : emprunts bancaires (avec taux, durée, capital), leasings (avec loyers), dettes fournisseurs en attente, découverts autorisés. Utiliser pour questions sur les mensualités à payer, le niveau d'endettement, les échéances à venir.",
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'lire_profil_entreprise',
    description: "Identité légale et administrative : raison sociale, SIRET, forme juridique, TVA intracom, dirigeant, adresse siège, secteur d'activité, convention collective (CCN/IDCC). Utiliser quand on te demande les infos légales, les coordonnées, ou pour adapter tes conseils au secteur.",
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'lire_fournisseurs',
    description: "Liste des fournisseurs enregistrés + fiches détaillées (factures d'achat archivées). Utiliser pour questions sur les fournisseurs habituels, les achats récents par fournisseur, retrouver une facture.",
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'lire_cartes_cadeaux',
    description: "Cartes cadeaux vendues : celles encore actives (CA différé à venir), celles soldées, soldes restants. Utiliser pour questions sur les cartes cadeaux en circulation, le CA différé total à l'actif.",
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'lire_panier_moyen',
    description: "Panier moyen et nombre de clients mois par mois : panier moyen, nombre de transactions, fréquence de visite. Utiliser pour questions sur l'évolution du panier, la fréquentation du magasin, la valeur client.",
    input_schema: {
      type: 'object',
      properties: {
        annee: { type: 'integer', description: "Année cible (défaut: année courante)" },
      },
    },
  },
  {
    name: 'lire_bilans',
    description: "Bilans comptables annuels analysés : CA, résultat net, EBITDA, capitaux propres, endettement, ratios, analyse IA, points forts/vigilance. Utiliser pour questions sur l'année écoulée, la santé globale de la boîte, la performance annuelle.",
    input_schema: {
      type: 'object',
      properties: {
        annee: { type: 'integer', description: "Année du bilan (défaut: année précédente = dernier bilan clos)" },
      },
    },
  },
  {
    name: 'lire_objectifs_rh',
    description: "Objectifs commerciaux ou opérationnels définis par employé : cible vs réalisé, type (CA, quantité, qualité), statut. Utiliser pour questions sur la performance individuelle, le suivi d'objectifs, les primes.",
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'lire_recrutement_rh',
    description: "Recrutements en cours : offres ouvertes, candidats actifs, entretiens planifiés. Utiliser pour questions sur les recrutements en cours, combien de candidats sur telle offre, prochains entretiens.",
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'enregistrer_fait_business',
    description: "Mémorise un fait important à propos de l'entreprise ou du dirigeant pour le retrouver dans les conversations futures. À utiliser DE MANIÈRE AUTONOME quand tu identifies une info qui pourra être utile plus tard : particularités comptables, échéances récurrentes, événements marquants, décisions du dirigeant, relations clients/employés clés, habitudes business, saisonnalité observée, objectifs annoncés. Ne PAS demander l'autorisation avant d'utiliser ce tool — tu décides toi-même si un fait mérite d'être mémorisé. Après mémorisation, mentionne-le brièvement dans ta réponse (ex: 'Je note que...').",
    input_schema: {
      type: 'object',
      properties: {
        fait: { type: 'string', description: "Le fait à mémoriser, en une phrase claire et autonome (max 300 caractères). Ex: 'L'URSSAF est prélevée le 15 du mois', 'Sophie part en congés du 15 au 30 juin 2026', 'Objectif CA 2026: 250k€'." },
        categorie: { type: 'string', description: "Catégorie du fait : 'comptable', 'rh', 'client', 'strategie', 'saisonnalite', 'echeance', 'preference', 'autre'" },
      },
      required: ['fait'],
    },
  },
  {
    name: 'enregistrer_preference',
    description: "Mémorise une préférence du dirigeant sur la façon dont il veut que tu te comportes. À utiliser quand tu détectes une consigne de style ou d'interaction : 'réponds-moi en plus court', 'évite les emojis', 'détaille davantage les analyses', etc. Surécrit la préférence existante de même type.",
    input_schema: {
      type: 'object',
      properties: {
        preference: { type: 'string', description: "La préférence en une phrase (max 200 caractères)." },
        type: { type: 'string', description: "Type : 'ton', 'longueur', 'format', 'langue', 'autre'" },
      },
      required: ['preference'],
    },
  },
  {
    name: 'ajouter_ca',
    description: "Ajoute une ligne de chiffre d'affaires dans le pilotage mensuel de l'entreprise. Utiliser quand l'utilisateur dicte une vente/un CA à l'oral ou à l'écrit (ex: 'ajoute 1500 euros de CA en TVA 20 aujourd'hui', 'j'ai fait 800€ en 10% ce matin'). Le CA sera visible immédiatement dans le module pilotage. Toujours CONFIRMER le montant, la TVA et le mois cible avant d'ajouter si le message est ambigu. Le montant doit être en HT.",
    input_schema: {
      type: 'object',
      properties: {
        montant_ht: { type: 'number', description: "Montant HT en euros (positif). Ex: 1500 pour 1500€ HT." },
        taux_tva: { type: 'string', description: "Taux de TVA : '20' (standard), '10' (restauration), '5.5' (alimentation), '2.1' (presse), '8.5' (outre-mer). Si non précisé, utiliser '20' par défaut." },
        date: { type: 'string', description: "Date au format JJ/MM/AAAA. Si non précisée, utiliser la date du jour." },
        note: { type: 'string', description: "Note/libellé optionnel pour cette ligne de CA (ex: 'vente boutique', 'facture client Dupont')." },
      },
      required: ['montant_ht'],
    },
  },
  {
    name: 'ajouter_charge',
    description: "Ajoute une ligne de charge dans le pilotage mensuel (charges fixes ou variables). Utiliser quand l'utilisateur dicte une dépense (ex: 'ajoute 250 euros de charge pour le loyer', 'note 50€ de carburant'). Le montant doit être en HT.",
    input_schema: {
      type: 'object',
      properties: {
        montant_ht: { type: 'number', description: "Montant HT en euros (positif)." },
        type_charge: { type: 'string', description: "'fixe' (loyer, assurance, abonnement…) ou 'variable' (carburant, fournitures, matière première…). Si doute, 'variable'." },
        fournisseur: { type: 'string', description: "Nom du fournisseur ou libellé de la charge (ex: 'EDF', 'Essence', 'Loyer')." },
        taux_tva: { type: 'string', description: "Taux TVA : '20' (défaut), '10', '5.5', '2.1', '8.5'." },
        date: { type: 'string', description: "Date JJ/MM/AAAA. Si non précisée, date du jour." },
      },
      required: ['montant_ht', 'type_charge'],
    },
  },
  {
    name: 'ajouter_note',
    description: "Ajoute une note/rappel dans le carnet de bord Léa (pas dans le pilotage financier). Utiliser quand l'utilisateur veut noter une info qui n'est pas un chiffre (ex: 'note que j'ai rencontré un fournisseur intéressant', 'rappelle-moi d'appeler le banquier demain'). Différent d'enregistrer_fait_business qui est pour des faits permanents — ici c'est plutôt une note datée ponctuelle.",
    input_schema: {
      type: 'object',
      properties: {
        contenu: { type: 'string', description: "Contenu de la note (max 500 caractères)." },
        categorie: { type: 'string', description: "'rappel', 'reunion', 'idee', 'todo', 'autre'" },
      },
      required: ['contenu'],
    },
  },

  // ── WAVE 3.9 : écriture étendue (pilotage/stock/marges) ──
  {
    name: 'modifier_ligne_ca',
    description: "CORRIGER une ligne CA existante en remplaçant le montant sur une TVA à une date donnée. Le nouveau montant REMPLACE l'ancien (pas d'accumulation, contrairement à ajouter_ca). Utiliser quand l'utilisateur dit 'corrige', 'remplace', 'modifie', 'change' un CA existant. Pour simplement ajouter du CA, utiliser ajouter_ca.",
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: "Date JJ/MM/AAAA" },
        taux_tva: { type: 'number', description: "Taux TVA : 5.5, 10, 20, 2.1 ou 8.5" },
        nouveau_montant_ht: { type: 'number', description: "Nouveau montant HT (positif ou 0 pour effacer)" },
      },
      required: ['date', 'taux_tva', 'nouveau_montant_ht'],
    },
  },
  {
    name: 'supprimer_ligne_ca',
    description: "Remet à ZÉRO tous les champs TVA d'une ligne CA à une date donnée. Utiliser quand l'utilisateur dit 'supprime', 'efface', 'enlève' une ligne CA entière. Exige confirmer:true explicite pour éviter tout accident. DEMANDE TOUJOURS CONFIRMATION AVANT d'appeler ce tool.",
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: "Date JJ/MM/AAAA" },
        confirmer: { type: 'boolean', description: "DOIT être true pour valider la suppression" },
      },
      required: ['date', 'confirmer'],
    },
  },
  {
    name: 'modifier_ligne_charge',
    description: "Modifier ou supprimer une ligne de charge (fixe ou variable) dans un mois donné. Utiliser pour corriger une charge mal saisie, changer son montant, changer son fournisseur, ou supprimer carrément la ligne. Si plusieurs charges correspondent, le tool renvoie la liste pour désambiguïser.",
    input_schema: {
      type: 'object',
      properties: {
        mois: { type: 'string', description: "Format YYYY-MM (défaut: mois courant)" },
        type: { type: 'string', description: "'fixe' ou 'variable'" },
        identifier: {
          type: 'object',
          description: "Comment identifier la charge : par index (position 0-based) ou par fournisseur (+ montant si ambiguïté)",
          properties: {
            index: { type: 'integer' },
            fournisseur: { type: 'string' },
            montant_ht: { type: 'number' },
          },
        },
        action: { type: 'string', description: "'modifier' ou 'supprimer'" },
        nouvelles_valeurs: {
          type: 'object',
          description: "Requis si action=modifier. Champs à modifier : fournisseur, type, montant_ht, tva_rate, deductible (bool), pointe (bool)",
          properties: {
            fournisseur: { type: 'string' },
            type: { type: 'string' },
            montant_ht: { type: 'number' },
            tva_rate: { type: 'number' },
            deductible: { type: 'boolean' },
            pointe: { type: 'boolean' },
          },
        },
      },
      required: ['type', 'identifier', 'action'],
    },
  },
  {
    name: 'ajouter_produit_stock',
    description: "Créer un NOUVEAU produit dans le module Stock. Utiliser quand l'utilisateur veut référencer un nouvel article (ex: 'ajoute un produit pain de campagne à 2,50€', 'crée la référence CHEM-BLA pour une chemise blanche'). Si un produit similaire existe déjà (même nom/ref/EAN), proposer d'ajuster sa quantité plutôt que créer un doublon.",
    input_schema: {
      type: 'object',
      properties: {
        nom: { type: 'string', description: "Nom du produit (requis, max 200 chars)" },
        ref: { type: 'string', description: "Référence/SKU (généré si absent)" },
        ean: { type: 'string', description: "Code-barres EAN (optionnel)" },
        stock_initial: { type: 'number', description: "Quantité initiale en stock (défaut 0)" },
        prix_achat: { type: 'number', description: "Prix d'achat HT unitaire" },
        prix_vente: { type: 'number', description: "Prix de vente HT unitaire" },
        categorie: { type: 'string' },
        unite: { type: 'string', description: "Ex: pièce, kg, litre" },
        stock_type: { type: 'string', description: "'marchandise' (défaut), 'matiere', 'fini'" },
        fournisseur: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['nom'],
    },
  },
  {
    name: 'ajuster_quantite_stock',
    description: "Modifier la quantité en stock d'un produit EXISTANT. Crée un mouvement d'ajustement (ADJUST) qui établit le nouveau stock absolu. Utiliser pour un inventaire, une casse, une correction d'erreur. Pour créer un nouveau produit, utiliser ajouter_produit_stock.",
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: "Référence/SKU du produit" },
        ean: { type: 'string', description: "Code-barres EAN" },
        nom: { type: 'string', description: "Nom du produit (match partiel autorisé)" },
        nouvelle_quantite: { type: 'number', description: "Quantité absolue après ajustement (>= 0)" },
        motif: { type: 'string', description: "Raison de l'ajustement (inventaire, casse, etc.)" },
      },
      required: ['nouvelle_quantite'],
    },
  },
  {
    name: 'marquer_rupture_stock',
    description: "Raccourci pour mettre un produit à 0 en stock (rupture). Équivalent à ajuster_quantite_stock avec nouvelle_quantite:0.",
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        ean: { type: 'string' },
        nom: { type: 'string' },
        motif: { type: 'string' },
      },
    },
  },
  {
    name: 'creer_fiche_marge',
    description: "Créer une fiche marge dans le module Marges. Calcule automatiquement la marge brute (€ et %) à partir du prix de vente et des coûts. Utiliser quand l'utilisateur veut analyser la rentabilité d'un produit/plat/prestation qu'il est en train de définir.",
    input_schema: {
      type: 'object',
      properties: {
        nom: { type: 'string', description: "Nom du produit/plat/service (requis)" },
        prix_vente: { type: 'number', description: "Prix de vente HT unitaire (requis)" },
        matiere_premiere: { type: 'number', description: "Coût matière première par unité" },
        main_oeuvre: { type: 'number', description: "Coût main d'œuvre par unité" },
        emballage: { type: 'number', description: "Coût emballage par unité" },
        livraison: { type: 'number', description: "Coût livraison par unité" },
        charges_fixes: { type: 'number', description: "Quote-part charges fixes par unité" },
        quantite: { type: 'number', description: "Quantité de référence (défaut 1)" },
        categorie: { type: 'string' },
        emoji: { type: 'string', description: "Emoji visuel (défaut 📦)" },
      },
      required: ['nom', 'prix_vente'],
    },
  },
  {
    name: 'modifier_fiche_marge',
    description: "Modifier les prix, coûts ou infos d'une fiche marge EXISTANTE. Utiliser pour mettre à jour un prix de vente, revoir un coût de matière, etc.",
    input_schema: {
      type: 'object',
      properties: {
        identifier: {
          type: 'object',
          description: "Identifier la fiche par id ou par nom (match partiel autorisé sur nom)",
          properties: {
            id: { type: 'string' },
            nom: { type: 'string' },
          },
        },
        nouvelles_valeurs: {
          type: 'object',
          properties: {
            nom: { type: 'string' },
            prix_vente: { type: 'number' },
            matiere_premiere: { type: 'number' },
            main_oeuvre: { type: 'number' },
            emballage: { type: 'number' },
            livraison: { type: 'number' },
            charges_fixes: { type: 'number' },
            quantite: { type: 'number' },
            categorie: { type: 'string' },
            emoji: { type: 'string' },
          },
        },
      },
      required: ['identifier', 'nouvelles_valeurs'],
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

// ═══════════════════════════════════════════════════════════════════════════
// WAVE 3.8 — LECTURE ÉTENDUE
// 12 tools pour que Léa voit TOUT Alteore :
//   RH avancé : planning, émargements, congés complets, objectifs, recrutement
//   Finance : cashflow, dettes, bilans
//   Référentiels : profil entreprise, fournisseurs, cartes cadeaux, panier moyen
// ═══════════════════════════════════════════════════════════════════════════

// Helper : normaliser YYYY-MM-DD depuis une Date
function fmtDateIso(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Helper : calculer les clés de semaine (format YYYYMMDD du lundi) couvrant une plage de dates
function weeksKeysInRange(startDate, endDate) {
  const keys = new Set();
  const cursor = new Date(startDate);
  cursor.setHours(12, 0, 0, 0);
  while (cursor <= endDate) {
    const dow = cursor.getDay();
    const diff = dow === 0 ? -6 : 1 - dow;
    const mon = new Date(cursor);
    mon.setDate(mon.getDate() + diff);
    mon.setHours(12, 0, 0, 0);
    keys.add(fmtDateIso(mon).replace(/-/g, ''));
    cursor.setDate(cursor.getDate() + 7);
  }
  return Array.from(keys);
}

// ───────────────────────────────────────────────────────────────────
// tool_lire_planning_rh
// Lecture du planning RH : horaires + shifts pour les employés
// Input : { date_debut?: "YYYY-MM-DD", date_fin?: "YYYY-MM-DD", employe_id?: string }
// Si pas de dates → semaine en cours + semaine suivante
// Structure Firestore : rh/{uid}/plan_{YYYYMMDD_du_lundi}/{docId}
//   docId = format "{employeId}_{YYYY-MM-DD}" généralement
//   data = { employeId, jour (YYYY-MM-DD), plages: [{deb, fin}], type }
// ───────────────────────────────────────────────────────────────────
async function tool_lire_planning_rh(uid, input) {
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const dStart = input.date_debut ? new Date(input.date_debut) : today;
  const dEnd = input.date_fin
    ? new Date(input.date_fin)
    : new Date(today.getTime() + 14 * 24 * 3600 * 1000);
  dStart.setHours(12, 0, 0, 0);
  dEnd.setHours(12, 0, 0, 0);

  const filterEmploye = (input.employe_id || '').trim();

  // Lister les employés pour mapper les IDs aux noms
  const empRes = await fsList(`rh/${uid}/employes`, 100);
  const empDocs = empRes?.documents || [];
  const employesMap = {};
  for (const d of empDocs) {
    const data = docToObject(d);
    const id = (d.name || '').split('/').pop();
    employesMap[id] = {
      id,
      prenom: data.prenom || data.firstname || '-',
      nom: data.nom || data.lastname || '-',
    };
  }

  const weekKeys = weeksKeysInRange(dStart, dEnd);
  const creneaux = [];
  for (const wk of weekKeys) {
    try {
      const res = await fsList(`rh/${uid}/plan_${wk}`, 200);
      const docs = res?.documents || [];
      for (const doc of docs) {
        const data = docToObject(doc);
        const employeId = data.employeId || data.employe || '';
        if (filterEmploye && employeId !== filterEmploye) continue;
        const jour = data.jour || data.date || '';
        if (jour) {
          const jDate = new Date(jour);
          if (jDate < dStart || jDate > dEnd) continue;
        }
        const plages = Array.isArray(data.plages) && data.plages.length > 0
          ? data.plages
          : (data.deb && data.fin ? [{ deb: data.deb, fin: data.fin }] : []);
        const emp = employesMap[employeId] || { id: employeId, prenom: '?', nom: '?' };
        creneaux.push({
          employe: emp.prenom + ' ' + emp.nom,
          employe_id: employeId,
          jour: jour,
          plages: plages,
          type: data.type || 'travail',
        });
      }
    } catch (e) { /* semaine sans data, skip */ }
  }

  // Trier par date puis employé
  creneaux.sort(function (a, b) {
    if (a.jour !== b.jour) return a.jour < b.jour ? -1 : 1;
    return a.employe.localeCompare(b.employe);
  });

  return {
    periode: { debut: fmtDateIso(dStart), fin: fmtDateIso(dEnd) },
    nombre_creneaux: creneaux.length,
    nombre_employes_concernes: new Set(creneaux.map(function (c) { return c.employe_id; })).size,
    creneaux: creneaux,
  };
}

// ───────────────────────────────────────────────────────────────────
// tool_lire_emargements_rh
// Heures pointées, écarts planning/réel, fiches d'émargement
// Input : { mois?: "YYYY-MM", employe_id?: string }
// Structure : rh_emargements/{uid}/fiches/{id} et rh_pointages_public/{uid}/events/{dateId}
// ───────────────────────────────────────────────────────────────────
async function tool_lire_emargements_rh(uid, input) {
  const now = new Date();
  const moisTarget = input.mois || (now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0'));
  const filterEmploye = (input.employe_id || '').trim();

  // Lire employés pour nommer
  const empRes = await fsList(`rh/${uid}/employes`, 100);
  const empDocs = empRes?.documents || [];
  const employesMap = {};
  for (const d of empDocs) {
    const data = docToObject(d);
    const id = (d.name || '').split('/').pop();
    employesMap[id] = (data.prenom || '-') + ' ' + (data.nom || '-');
  }

  // Lire fiches d'émargement
  let fiches = [];
  try {
    const res = await fsList(`rh_emargements/${uid}/fiches`, 100);
    const docs = res?.documents || [];
    fiches = docs.map(function (d) {
      const data = docToObject(d);
      const id = (d.name || '').split('/').pop();
      return {
        id,
        employe: employesMap[data.employeId] || data.employeId || '?',
        mois: data.mois || '',
        status: data.status || data.statut || 'en_cours',
        total_heures: parseFloat(data.totalHeures) || parseFloat(data.heures_total) || null,
        signe: !!data.signatureEmploye,
      };
    }).filter(function (f) {
      if (moisTarget && f.mois && f.mois !== moisTarget) return false;
      if (filterEmploye && f.id.indexOf(filterEmploye) === -1) return false;
      return true;
    });
  } catch (e) { /* pas de fiches */ }

  // Lire pointages du mois (si dispo)
  let pointages = [];
  try {
    const res = await fsList(`rh_pointages_public/${uid}/events`, 200);
    const docs = res?.documents || [];
    pointages = docs.map(function (d) {
      const data = docToObject(d);
      const id = (d.name || '').split('/').pop();
      return {
        date: data.date || id,
        employe: employesMap[data.employeId] || data.employeId || '?',
        employe_id: data.employeId || '',
        debut: data.debut || data.heureArrivee || null,
        fin: data.fin || data.heureDepart || null,
        pauses: data.pauses || [],
      };
    }).filter(function (p) {
      if (moisTarget && p.date && p.date.indexOf(moisTarget) !== 0) return false;
      if (filterEmploye && p.employe_id !== filterEmploye) return false;
      return true;
    });
  } catch (e) { /* pas de pointages */ }

  return {
    mois: moisTarget,
    nombre_fiches: fiches.length,
    fiches_par_statut: {
      signees: fiches.filter(function (f) { return f.signe; }).length,
      en_attente: fiches.filter(function (f) { return !f.signe; }).length,
    },
    fiches: fiches,
    nombre_pointages: pointages.length,
    pointages: pointages.slice(0, 50), // limiter volume
  };
}

// ───────────────────────────────────────────────────────────────────
// tool_lire_conges_complets
// Tous les congés (approuvés, en attente, refusés, historique)
// Input : { statut?: 'tous'|'en_attente'|'approuve'|'refuse', annee?: number }
// ───────────────────────────────────────────────────────────────────
async function tool_lire_conges_complets(uid, input) {
  const statutFilter = input.statut || 'tous';
  const anneeFilter = input.annee || null;

  // Employés pour nommer
  const empRes = await fsList(`rh/${uid}/employes`, 100);
  const empDocs = empRes?.documents || [];
  const employesMap = {};
  for (const d of empDocs) {
    const data = docToObject(d);
    const id = (d.name || '').split('/').pop();
    employesMap[id] = (data.prenom || '-') + ' ' + (data.nom || '-');
  }

  const cgRes = await fsList(`rh_conges/${uid}/demandes`, 200);
  const cgDocs = cgRes?.documents || [];
  const conges = cgDocs.map(function (d) {
    const data = docToObject(d);
    const id = (d.name || '').split('/').pop();
    return {
      id,
      employe: employesMap[data.employeId || data.employe] || '?',
      employe_id: data.employeId || data.employe || '',
      date_debut: data.dateDebut || null,
      date_fin: data.dateFin || null,
      type: data.type || 'CP',
      statut: data.statut || 'en_attente',
      nb_jours: parseFloat(data.nbJours) || parseFloat(data.jours) || null,
      motif: data.motif || null,
      date_creation: data.dateCreation || null,
    };
  });

  let filtered = conges;
  if (statutFilter !== 'tous') {
    filtered = filtered.filter(function (c) { return c.statut === statutFilter; });
  }
  if (anneeFilter) {
    filtered = filtered.filter(function (c) {
      return (c.date_debut && String(c.date_debut).indexOf(String(anneeFilter)) === 0)
          || (c.date_fin && String(c.date_fin).indexOf(String(anneeFilter)) === 0);
    });
  }

  // Tri récent en premier
  filtered.sort(function (a, b) {
    return (b.date_debut || '').localeCompare(a.date_debut || '');
  });

  return {
    filtre: { statut: statutFilter, annee: anneeFilter },
    nombre_total: filtered.length,
    repartition_statut: {
      approuve: conges.filter(function (c) { return c.statut === 'approuve'; }).length,
      en_attente: conges.filter(function (c) { return c.statut === 'en_attente'; }).length,
      refuse: conges.filter(function (c) { return c.statut === 'refuse'; }).length,
    },
    conges: filtered.slice(0, 100),
  };
}

// ───────────────────────────────────────────────────────────────────
// tool_lire_cashflow
// Trésorerie actuelle + projection depuis pilotage courant
// Input : {} (pas de paramètre, donne la vue d'ensemble)
// Structure : cashflow/{uid}/config/tresorerie → {solde, date}
// ───────────────────────────────────────────────────────────────────
async function tool_lire_cashflow(uid, input) {
  const cfgDoc = await fsGet(`cashflow/${uid}/config/tresorerie`);
  const cfg = cfgDoc ? docToObject(cfgDoc) : null;

  const soldeDepart = cfg && typeof cfg.solde === 'number' ? cfg.solde : null;
  const dateDepart = cfg ? cfg.date : null;

  // Calculer tréso approx = solde_depart + CA mois courant - charges mois courant
  const now = new Date();
  const monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const pilotageDoc = await fsGet(`pilotage/${uid}/months/${monthKey}`);
  const pilotage = pilotageDoc ? docToObject(pilotageDoc) : {};

  let caHt = 0, caTtc = 0;
  if (Array.isArray(pilotage.ca)) {
    for (const row of pilotage.ca) {
      const h055 = parseFloat(row.ht055) || 0;
      const h10  = parseFloat(row.ht10) || 0;
      const h20  = parseFloat(row.ht20) || 0;
      const h21  = parseFloat(row.ht21) || 0;
      const h85  = parseFloat(row.ht85) || 0;
      const multi = h055 + h10 + h20 + h21 + h85;
      const ht = multi > 0 ? multi : (parseFloat(row.montantHT) || 0);
      caHt += ht;
      caTtc += h055 * 1.055 + h10 * 1.10 + h20 * 1.20 + h21 * 1.021 + h85 * 1.085;
      if (multi === 0 && ht > 0) caTtc += ht * 1.20; // fallback ancien format
    }
  }

  let chargesFixes = 0;
  if (Array.isArray(pilotage.chargesFixe)) {
    chargesFixes = pilotage.chargesFixe.reduce(function (s, r) { return s + (parseFloat(r.montant) || 0); }, 0);
  }
  let chargesVar = 0;
  if (Array.isArray(pilotage.chargesVar)) {
    chargesVar = pilotage.chargesVar.reduce(function (s, r) { return s + (parseFloat(r.montant) || 0); }, 0);
  }
  let creditsMensuels = 0;
  if (Array.isArray(pilotage.credits)) {
    creditsMensuels = pilotage.credits.reduce(function (s, r) { return s + (parseFloat(r.mensualite) || parseFloat(r.montant) || 0); }, 0);
  }
  let leasingMensuels = 0;
  if (Array.isArray(pilotage.leasing)) {
    leasingMensuels = pilotage.leasing.reduce(function (s, r) { return s + (parseFloat(r.mensualite) || parseFloat(r.montant) || 0); }, 0);
  }

  const resultatCourant = caTtc - chargesFixes - chargesVar - creditsMensuels - leasingMensuels;
  const tresoEstime = soldeDepart !== null ? soldeDepart + resultatCourant : null;

  return {
    solde_depart: soldeDepart,
    date_solde_depart: dateDepart,
    mois_courant: monthKey,
    ca_ht_mois: Math.round(caHt * 100) / 100,
    ca_ttc_mois: Math.round(caTtc * 100) / 100,
    charges_fixes_mois: Math.round(chargesFixes * 100) / 100,
    charges_variables_mois: Math.round(chargesVar * 100) / 100,
    credits_mensualite: Math.round(creditsMensuels * 100) / 100,
    leasing_mensualite: Math.round(leasingMensuels * 100) / 100,
    resultat_mois_tresorerie: Math.round(resultatCourant * 100) / 100,
    tresorerie_estimee_fin_mois: tresoEstime !== null ? Math.round(tresoEstime * 100) / 100 : null,
    note: !soldeDepart
      ? "Aucun solde de trésorerie configuré. Le dirigeant peut le faire dans la page Cashflow."
      : null,
  };
}

// ───────────────────────────────────────────────────────────────────
// tool_lire_dettes
// Emprunts, leasings, dettes fournisseurs, découverts
// Structure : dettes/{uid}/data/all → { list: [...] }
// ───────────────────────────────────────────────────────────────────
async function tool_lire_dettes(uid, input) {
  const doc = await fsGet(`dettes/${uid}/data/all`);
  const obj = doc ? docToObject(doc) : {};
  const list = Array.isArray(obj.list) ? obj.list : [];

  const actives = list.filter(function (d) { return d.active !== false; });

  const resume = {
    emprunts: actives.filter(function (d) { return d.type === 'emprunt'; }),
    leasings: actives.filter(function (d) { return d.type === 'leasing'; }),
    fournisseurs: actives.filter(function (d) { return d.type === 'fournisseur'; }),
    decouverts: actives.filter(function (d) { return d.type === 'decouvert'; }),
  };

  // Agrégats
  const totalCapitalEmpruntes = resume.emprunts.reduce(function (s, d) { return s + (parseFloat(d.montant) || 0); }, 0);
  const mensualitesTotales = resume.emprunts.reduce(function (s, d) {
    // Mensualité estimée basique = montant / duree (amortissement linéaire)
    const mens = d.mensualite ? parseFloat(d.mensualite) : (d.montant && d.duree ? d.montant / d.duree : 0);
    return s + (mens || 0);
  }, 0) + resume.leasings.reduce(function (s, d) { return s + (parseFloat(d.loyer) || 0); }, 0);

  return {
    nombre_total: actives.length,
    total_capital_emprunte: Math.round(totalCapitalEmpruntes * 100) / 100,
    mensualites_totales_estimees: Math.round(mensualitesTotales * 100) / 100,
    emprunts: resume.emprunts.map(function (d) {
      return {
        nom: d.nom, montant: d.montant, taux: d.taux, duree_mois: d.duree,
        debut: d.debut, mensualite: d.mensualite || null,
        paiements_realises: (d.paiements || []).length,
      };
    }),
    leasings: resume.leasings.map(function (d) {
      return { nom: d.nom, loyer: d.loyer, duree_mois: d.duree, debut: d.debut };
    }),
    dettes_fournisseurs: resume.fournisseurs.map(function (d) {
      return { nom: d.nom, montant: d.montant, echeance: d.echeance, ref: d.ref };
    }),
    decouverts: resume.decouverts.map(function (d) {
      return { nom: d.nom, plafond: d.plafond, taux: d.tauxDec };
    }),
  };
}

// ───────────────────────────────────────────────────────────────────
// tool_lire_profil_entreprise
// Infos légales et identité de l'entreprise
// Structure : profil/{uid}/data/profil
// ───────────────────────────────────────────────────────────────────
async function tool_lire_profil_entreprise(uid, input) {
  const doc = await fsGet(`profil/${uid}/data/profil`);
  if (!doc) return { message: "Aucun profil entreprise configuré.", existe: false };
  const p = docToObject(doc);
  return {
    existe: true,
    raison_sociale: p.raisonSociale || p.nomEntreprise || null,
    forme_juridique: p.formeJuridique || null,
    siret: p.siret || null,
    siren: p.siren || null,
    tva_intracom: p.tvaIntracom || null,
    naf: p.naf || p.codeNaf || null,
    capital_social: parseFloat(p.capitalSocial) || null,
    dirigeant: p.dirigeant || p.gerant || null,
    adresse: p.adresse || null,
    code_postal: p.codePostal || null,
    ville: p.ville || null,
    telephone: p.telephone || null,
    email: p.email || null,
    activite: p.activite || p.typeActivite || null,
    secteur: p.secteur || null,
    date_creation: p.dateCreation || null,
    effectif: p.effectif || null,
    ccn: p.ccn || p.idcc || null,
  };
}

// ───────────────────────────────────────────────────────────────────
// tool_lire_fournisseurs
// Liste des fournisseurs + fiches fournisseurs (catalogue factures achat)
// Structures : fournisseurs/{uid} (objet simple) + fiches/{uid}/items/{id}
// ───────────────────────────────────────────────────────────────────
async function tool_lire_fournisseurs(uid, input) {
  // Liste de noms de fournisseurs (objet simple)
  const fDoc = await fsGet(`fournisseurs/${uid}`);
  const fObj = fDoc ? docToObject(fDoc) : {};
  const listeNoms = Array.isArray(fObj.list) ? fObj.list : (Array.isArray(fObj.fournisseurs) ? fObj.fournisseurs : []);

  // Fiches détaillées (type facture achat enregistrée)
  const fichesRes = await fsList(`fiches/${uid}/items`, 200);
  const fichesDocs = fichesRes?.documents || [];
  const fiches = fichesDocs.map(function (d) {
    const data = docToObject(d);
    const id = (d.name || '').split('/').pop();
    return {
      id,
      nom: data.nom || data.fournisseur || id,
      categorie: data.categorie || null,
      total_ht: parseFloat(data.totalHt) || parseFloat(data.ht) || null,
      total_ttc: parseFloat(data.totalTtc) || parseFloat(data.ttc) || null,
      date: data.date || null,
      nombre_articles: (data.articles || data.lignes || []).length || null,
    };
  });

  return {
    nombre_noms: listeNoms.length,
    noms_fournisseurs: listeNoms,
    nombre_fiches: fiches.length,
    fiches_recentes: fiches.sort(function (a, b) {
      return (b.date || '').localeCompare(a.date || '');
    }).slice(0, 30),
  };
}

// ───────────────────────────────────────────────────────────────────
// tool_lire_cartes_cadeaux
// Cartes cadeaux vendues (CA différé) + soldes restants
// Structure : pilotage/{uid}/cartes_cadeaux/all → { cartes: [...] }
// ───────────────────────────────────────────────────────────────────
async function tool_lire_cartes_cadeaux(uid, input) {
  const doc = await fsGet(`pilotage/${uid}/cartes_cadeaux/all`);
  const obj = doc ? docToObject(doc) : {};
  const cartes = Array.isArray(obj.cartes) ? obj.cartes : [];

  const actives = cartes.filter(function (c) { return c.statut !== 'soldee'; });
  const soldees = cartes.filter(function (c) { return c.statut === 'soldee'; });

  const totalDifActif = actives.reduce(function (s, c) { return s + (parseFloat(c.solde) || 0); }, 0);
  const totalVendu = cartes.reduce(function (s, c) { return s + (parseFloat(c.montantInitial) || 0); }, 0);

  return {
    nombre_total: cartes.length,
    nombre_actives: actives.length,
    nombre_soldees: soldees.length,
    ca_differe_total: Math.round(totalDifActif * 100) / 100,
    total_vendu_historique: Math.round(totalVendu * 100) / 100,
    cartes_actives: actives.map(function (c) {
      return {
        id: c.id, label: c.label, date_vente: c.dateVente,
        montant_initial: parseFloat(c.montantInitial) || 0,
        solde_restant: parseFloat(c.solde) || 0,
      };
    }),
  };
}

// ───────────────────────────────────────────────────────────────────
// tool_lire_panier_moyen
// Panier moyen, nombre de clients, transactions par mois
// Structure : panier/{uid}/data/all → { y{YEAR}: { months: [{cli, ca, txn}], cats: [] } }
// Input : { annee?: number }
// ───────────────────────────────────────────────────────────────────
async function tool_lire_panier_moyen(uid, input) {
  const annee = input.annee || new Date().getFullYear();
  const doc = await fsGet(`panier/${uid}/data/all`);
  if (!doc) return { message: "Aucune donnée panier moyen. Le dirigeant peut saisir dans la page Panier Moyen.", annee };
  const obj = docToObject(doc);
  const yearData = obj['y' + annee];
  if (!yearData) return { message: "Pas de données panier moyen pour " + annee + ".", annee };

  const months = Array.isArray(yearData.months) ? yearData.months : [];
  const moisNom = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Jun', 'Jul', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc'];

  const monthsDetails = months.slice(0, 12).map(function (m, idx) {
    const cli = parseFloat(m.cli) || 0;
    const ca = parseFloat(m.ca) || 0;
    const txn = parseFloat(m.txn) || 0;
    const panierMoyen = txn > 0 ? ca / txn : 0;
    const txnParClient = cli > 0 ? txn / cli : 0;
    return {
      mois: moisNom[idx],
      clients: cli, ca_ttc: ca, transactions: txn,
      panier_moyen: Math.round(panierMoyen * 100) / 100,
      transactions_par_client: Math.round(txnParClient * 100) / 100,
    };
  });

  const totalCa = monthsDetails.reduce(function (s, m) { return s + m.ca_ttc; }, 0);
  const totalTxn = monthsDetails.reduce(function (s, m) { return s + m.transactions; }, 0);
  const totalClients = monthsDetails.reduce(function (s, m) { return s + m.clients; }, 0);

  return {
    annee: annee,
    ca_ttc_annuel: Math.round(totalCa * 100) / 100,
    transactions_annuelles: totalTxn,
    clients_annuels: totalClients,
    panier_moyen_annuel: totalTxn > 0 ? Math.round((totalCa / totalTxn) * 100) / 100 : 0,
    mois: monthsDetails.filter(function (m) { return m.ca_ttc > 0 || m.clients > 0; }),
    categories: yearData.cats || [],
  };
}

// ───────────────────────────────────────────────────────────────────
// tool_lire_bilans
// Bilans comptables annuels (si module bilan actif)
// Structure : bilans/{uid}/years/{year}
// Input : { annee?: number }
// ───────────────────────────────────────────────────────────────────
async function tool_lire_bilans(uid, input) {
  const annee = input.annee || (new Date().getFullYear() - 1); // par défaut année précédente (dernier bilan clos)
  const doc = await fsGet(`bilans/${uid}/years/${annee}`);
  if (!doc) {
    // Lister toutes les années dispo pour indiquer au dirigeant
    try {
      const list = await fsList(`bilans/${uid}/years`, 20);
      const annees = (list?.documents || []).map(function (d) { return (d.name || '').split('/').pop(); });
      return { message: "Aucun bilan pour " + annee + ".", annees_disponibles: annees, annee };
    } catch (e) {
      return { message: "Aucun bilan pour " + annee + ".", annee };
    }
  }
  const b = docToObject(doc);
  return {
    annee: annee,
    chiffre_affaires: parseFloat(b.chiffreAffaires) || parseFloat(b.ca) || null,
    resultat_net: parseFloat(b.resultatNet) || parseFloat(b.resultat) || null,
    ebitda: parseFloat(b.ebitda) || null,
    capitaux_propres: parseFloat(b.capitauxPropres) || null,
    total_bilan: parseFloat(b.totalBilan) || parseFloat(b.total) || null,
    endettement: parseFloat(b.endettement) || null,
    tresorerie: parseFloat(b.tresorerie) || null,
    ratios: b.ratios || null,
    analyse_ia: b.analyseIa || b.analyse || null,
    points_forts: b.pointsForts || null,
    points_vigilance: b.pointsVigilance || null,
  };
}

// ───────────────────────────────────────────────────────────────────
// tool_lire_objectifs_rh
// Objectifs commerciaux par employé
// Structure : rh_objectifs_public/{uid}/items/{itemId}
// ───────────────────────────────────────────────────────────────────
async function tool_lire_objectifs_rh(uid, input) {
  // Employés
  const empRes = await fsList(`rh/${uid}/employes`, 100);
  const empDocs = empRes?.documents || [];
  const employesMap = {};
  for (const d of empDocs) {
    const data = docToObject(d);
    const id = (d.name || '').split('/').pop();
    employesMap[id] = (data.prenom || '-') + ' ' + (data.nom || '-');
  }

  const res = await fsList(`rh_objectifs_public/${uid}/items`, 100);
  const docs = res?.documents || [];
  if (docs.length === 0) return { message: "Aucun objectif RH défini.", nombre_total: 0 };

  const objectifs = docs.map(function (d) {
    const data = docToObject(d);
    const id = (d.name || '').split('/').pop();
    return {
      id,
      employe: employesMap[data.employeId] || data.employeId || '?',
      employe_id: data.employeId || '',
      libelle: data.libelle || data.titre || id,
      type: data.type || 'ca',
      cible: parseFloat(data.cible) || parseFloat(data.objectif) || null,
      realise: parseFloat(data.realise) || 0,
      periode: data.periode || null,
      statut: data.statut || 'en_cours',
    };
  });

  return {
    nombre_total: objectifs.length,
    objectifs: objectifs,
  };
}

// ───────────────────────────────────────────────────────────────────
// tool_lire_recrutement_rh
// Offres, candidats, entretiens
// Structures : rh_recrutement/{uid}/{offres|candidats|entretiens}/{id}
// ───────────────────────────────────────────────────────────────────
async function tool_lire_recrutement_rh(uid, input) {
  let offres = [], candidats = [], entretiens = [];

  try {
    const res = await fsList(`rh_recrutement/${uid}/offres`, 50);
    const docs = res?.documents || [];
    offres = docs.map(function (d) {
      const data = docToObject(d);
      const id = (d.name || '').split('/').pop();
      return {
        id,
        intitule: data.intitule || data.titre || id,
        type_contrat: data.typeContrat || data.contrat || null,
        statut: data.statut || 'ouverte',
        date_publication: data.datePublication || null,
        nombre_candidats: parseInt(data.nbCandidats) || 0,
      };
    });
  } catch (e) { /* skip */ }

  try {
    const res = await fsList(`rh_recrutement/${uid}/candidats`, 100);
    const docs = res?.documents || [];
    candidats = docs.map(function (d) {
      const data = docToObject(d);
      const id = (d.name || '').split('/').pop();
      return {
        id,
        nom: (data.prenom || '') + ' ' + (data.nom || ''),
        email: data.email || null,
        poste: data.poste || data.offreIntitule || null,
        statut: data.statut || 'a_contacter',
        score: data.score || null,
      };
    });
  } catch (e) { /* skip */ }

  try {
    const res = await fsList(`rh_recrutement/${uid}/entretiens`, 50);
    const docs = res?.documents || [];
    entretiens = docs.map(function (d) {
      const data = docToObject(d);
      const id = (d.name || '').split('/').pop();
      return {
        id,
        candidat: data.candidatNom || data.candidat || '?',
        date: data.date || null,
        type: data.type || 'telephonique',
        statut: data.statut || 'planifie',
      };
    });
  } catch (e) { /* skip */ }

  return {
    nombre_offres_ouvertes: offres.filter(function (o) { return o.statut === 'ouverte'; }).length,
    nombre_candidats_actifs: candidats.filter(function (c) { return c.statut !== 'refuse' && c.statut !== 'embauche'; }).length,
    nombre_entretiens_planifies: entretiens.filter(function (e) { return e.statut === 'planifie'; }).length,
    offres: offres,
    candidats: candidats.slice(0, 30),
    entretiens: entretiens,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MÉMOIRE LONG TERME (Wave 3)
// ═══════════════════════════════════════════════════════════════════════════

// Cap le nombre de faits persistés par user pour éviter dérive contexte + coût.
// Au-delà, on rejette les nouveaux faits avec un message explicatif pour Léa.
const MAX_FACTS_PER_USER = 80;

async function tool_enregistrer_fait_business(uid, input) {
  const fait = (input.fait || '').trim();
  const categorie = (input.categorie || 'autre').trim();
  if (!fait) return { error: "Le champ 'fait' est requis" };
  if (fait.length > 300) return { error: "Le fait est trop long (max 300 caractères)" };

  // Vérifier le quota
  const existing = await fsList(`agent/${uid}/memory-facts`, MAX_FACTS_PER_USER + 1);
  const existingDocs = existing?.documents || [];
  if (existingDocs.length >= MAX_FACTS_PER_USER) {
    return {
      error: `Limite de ${MAX_FACTS_PER_USER} faits atteinte. Suggère au dirigeant de nettoyer sa mémoire dans la section 🧠 Mémoire de la page Léa.`,
      saved: false,
    };
  }

  // Déduplication simple : si le même fait existe déjà (case-insensitive), on ignore
  const lower = fait.toLowerCase();
  for (const d of existingDocs) {
    const existingFait = (fv(d, 'fait') || '').toLowerCase();
    if (existingFait === lower) {
      return { saved: false, message: "Ce fait existe déjà, rien à mémoriser.", duplicate: true };
    }
  }

  const ts = new Date().toISOString();
  const docId = ts.replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 8);
  await fsCreateWithId(`agent/${uid}/memory-facts`, docId, {
    fait,
    categorie,
    source: 'conversation',
    createdAt: ts,
  });

  return { saved: true, fait, categorie, factId: docId };
}

async function tool_enregistrer_preference(uid, input) {
  const preference = (input.preference || '').trim();
  const type = (input.type || 'autre').trim();
  if (!preference) return { error: "Le champ 'preference' est requis" };
  if (preference.length > 200) return { error: "Préférence trop longue (max 200 caractères)" };

  // Document singleton par type : on écrase à chaque fois
  const path = `agent/${uid}/memory-preferences/${type}`;
  const existing = await fsGet(path);

  const data = {
    preference,
    type,
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    await fsPatch(path, data);
  } else {
    // fsPatch sur path inexistant fonctionne sur Firestore REST : il crée le doc.
    await fsPatch(path, data);
  }

  return { saved: true, type, preference };
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOLS D'ÉCRITURE (Wave 3.7 — app mobile Léa)
// ═══════════════════════════════════════════════════════════════════════════
// Ces tools permettent à Léa d'écrire dans le pilotage. Scope strict sur l'uid.
// Chaque écriture est horodatée et marquée `source: 'lea'` pour traçabilité.
//
// Structure pilotage/{uid}/months/{YYYY-MM} :
//   { ca: [{date, ht055, ht10, ht20, ...}], chargesFixe: [...], chargesVar: [...] }

function parseDateFrToIso(dateStr) {
  // '25/04/2026' → '25/4/2026' (format utilisé dans pilotage)
  if (!dateStr) {
    const d = new Date();
    return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
  }
  const parts = dateStr.split('/');
  if (parts.length !== 3) return null;
  const d = parseInt(parts[0]);
  const m = parseInt(parts[1]);
  const y = parseInt(parts[2]);
  if (!d || !m || !y || d < 1 || d > 31 || m < 1 || m > 12 || y < 2020 || y > 2100) return null;
  return `${d}/${m}/${y}`;
}

function monthKeyFromDate(dateStr) {
  // '25/4/2026' → '2026-04'
  const parts = dateStr.split('/');
  const m = parseInt(parts[1]);
  const y = parseInt(parts[2]);
  return `${y}-${String(m).padStart(2, '0')}`;
}

function normalizeTva(taux) {
  // Accepte '20', '20%', '20.0', '5,5' etc. → renvoie le nom de champ pilotage
  if (!taux) return 'ht20';
  const s = String(taux).replace(',', '.').replace('%', '').trim();
  const n = parseFloat(s);
  if (n === 20) return 'ht20';
  if (n === 10) return 'ht10';
  if (n === 5.5) return 'ht055';
  if (n === 2.1) return 'ht21';
  if (n === 8.5) return 'ht85';
  return 'ht20'; // fallback sécurisé
}

async function tool_ajouter_ca(uid, input) {
  const montantHt = parseFloat(input.montant_ht);
  if (!montantHt || isNaN(montantHt) || montantHt <= 0) {
    return { error: "Le montant HT doit être un nombre positif.", success: false };
  }
  if (montantHt > 1000000) {
    return { error: "Montant trop élevé, merci de vérifier.", success: false };
  }
  const dateIso = parseDateFrToIso(input.date);
  if (!dateIso) return { error: "Date invalide. Format attendu : JJ/MM/AAAA.", success: false };
  const monthKey = monthKeyFromDate(dateIso);
  const tvaField = normalizeTva(input.taux_tva);

  // Lire le doc existant du mois (ou construire un template par défaut si absent)
  const path = `pilotage/${uid}/months/${monthKey}`;
  const doc = await fsGet(path);
  const existing = doc ? docToObject(doc) : {};

  // ── Structure ca[] attendue par pilotage.html ──
  // Le tableau ca contient UNE ENTRÉE PAR JOUR du mois (pré-générée).
  // On NE PUSH PAS une nouvelle ligne — ça casserait la condition
  // `s.ca.length === data.ca.length` dans pilotage.html (ligne 1306).
  // On CHERCHE la ligne du jour par date et on REMPLIT le bon champ ht*.
  //
  // Format date : "D/M/YYYY" (ex: "25/4/2026", pas de padding zéro).

  // Construire le tableau ca avec toutes les lignes du mois si absent
  const parts = dateIso.split('/');
  const dayOfMonth = parseInt(parts[0]);
  const monthNum = parseInt(parts[1]);
  const yearNum = parseInt(parts[2]);
  const daysInMonth = new Date(yearNum, monthNum, 0).getDate();

  let ca;
  if (Array.isArray(existing.ca) && existing.ca.length === daysInMonth) {
    // Structure existante correcte → on la réutilise
    ca = existing.ca.map(r => ({ ...r }));  // copie défensive
  } else {
    // Pas de doc ou mauvaise taille → on reconstruit la structure standard
    ca = [];
    for (let d = 1; d <= daysInMonth; d++) {
      ca.push({
        date: `${d}/${monthNum}/${yearNum}`,
        ht055: '', ht10: '', ht20: '',
      });
    }
    // Si existing.ca avait des données (ancienne structure), on les migre vers la nouvelle
    if (Array.isArray(existing.ca)) {
      for (const oldRow of existing.ca) {
        if (!oldRow.date) continue;
        const oldParts = String(oldRow.date).split('/');
        const oldDay = parseInt(oldParts[0]);
        if (oldDay >= 1 && oldDay <= daysInMonth) {
          ca[oldDay - 1] = { ...ca[oldDay - 1], ...oldRow };
        }
      }
    }
  }

  // Trouver la ligne du jour (index = dayOfMonth - 1 si structure standard)
  let targetIdx = dayOfMonth - 1;
  // Vérifier que l'index correspond bien à la date attendue (sécurité)
  if (!ca[targetIdx] || ca[targetIdx].date !== dateIso) {
    // Fallback : recherche par date
    targetIdx = ca.findIndex(r => r && r.date === dateIso);
    if (targetIdx === -1) {
      return { error: `Ligne du ${dateIso} introuvable dans le pilotage.`, success: false };
    }
  }

  // Accumuler le montant si la case a déjà une valeur (permet plusieurs ventes/jour)
  const existingVal = parseFloat(ca[targetIdx][tvaField]) || 0;
  const newVal = existingVal + montantHt;
  ca[targetIdx][tvaField] = String(newVal);

  // Marquer la ligne comme touchée par Léa (pour traçabilité, n'affecte pas l'affichage)
  if (!ca[targetIdx]._leaAdditions) ca[targetIdx]._leaAdditions = [];
  ca[targetIdx]._leaAdditions.push({
    montant: montantHt,
    tva: tvaField,
    addedAt: new Date().toISOString(),
    note: (input.note || '').slice(0, 200),
  });

  // Écrire en merge
  await fsPatch(path, { ca });

  const tvaDisplay = tvaField === 'ht055' ? '5,5%' : tvaField === 'ht10' ? '10%' : tvaField === 'ht21' ? '2,1%' : tvaField === 'ht85' ? '8,5%' : '20%';
  const accumuleMsg = existingVal > 0
    ? ` (ajouté aux ${existingVal}€ déjà présents, total ${newVal}€)`
    : '';
  return {
    success: true,
    ajouté: {
      montant_ht: montantHt,
      tva: tvaDisplay,
      date: dateIso,
      mois: monthKey,
      total_du_jour: newVal,
    },
    message: `${montantHt}€ HT en TVA ${tvaDisplay} ajoutés au ${dateIso}${accumuleMsg}. Visible immédiatement dans pilotage ${monthKey}.`,
  };
}

async function tool_ajouter_charge(uid, input) {
  const montantHt = parseFloat(input.montant_ht);
  if (!montantHt || isNaN(montantHt) || montantHt <= 0) {
    return { error: "Le montant HT doit être un nombre positif.", success: false };
  }
  if (montantHt > 500000) {
    return { error: "Montant trop élevé, merci de vérifier.", success: false };
  }
  const typeCharge = (input.type_charge || 'variable').toLowerCase();
  if (typeCharge !== 'fixe' && typeCharge !== 'variable') {
    return { error: "type_charge doit être 'fixe' ou 'variable'.", success: false };
  }
  const dateIso = parseDateFrToIso(input.date);
  if (!dateIso) return { error: "Date invalide. Format JJ/MM/AAAA.", success: false };
  const monthKey = monthKeyFromDate(dateIso);

  const path = `pilotage/${uid}/months/${monthKey}`;
  const doc = await fsGet(path);
  const existing = doc ? docToObject(doc) : {};
  const fieldName = typeCharge === 'fixe' ? 'chargesFixe' : 'chargesVar';
  const current = Array.isArray(existing[fieldName]) ? existing[fieldName] : [];

  // Taux TVA (en nombre, format existant)
  const tvaNum = (function() {
    if (!input.taux_tva) return 20;
    const s = String(input.taux_tva).replace(',', '.').replace('%', '').trim();
    const n = parseFloat(s);
    return [20, 10, 5.5, 2.1, 8.5, 0].includes(n) ? n : 20;
  })();

  const newLine = {
    fournisseur: (input.fournisseur || '').slice(0, 100),
    type: '',  // catégorie libre, vide par défaut, l'user peut compléter dans pilotage
    montantHT: String(montantHt),
    tvaRate: tvaNum,
    deductible: 'Oui',
    pointe: 'Non',
  };

  current.push(newLine);
  const patchData = {};
  patchData[fieldName] = current;
  await fsPatch(path, patchData);

  return {
    success: true,
    ajouté: {
      montant_ht: montantHt,
      type: typeCharge,
      fournisseur: input.fournisseur || null,
      date: dateIso,
      mois: monthKey,
    },
    message: `Charge ${typeCharge} de ${montantHt}€ HT ajoutée au ${dateIso}${input.fournisseur ? ' (' + input.fournisseur + ')' : ''}.`,
  };
}

async function tool_ajouter_note(uid, input) {
  const contenu = (input.contenu || '').trim();
  if (!contenu) return { error: "Le contenu de la note est requis.", success: false };
  if (contenu.length > 500) return { error: "Note trop longue (max 500 caractères).", success: false };
  const categorie = (input.categorie || 'autre').trim();

  const ts = new Date().toISOString();
  const docId = ts.replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 8);
  await fsCreateWithId(`agent/${uid}/notes`, docId, {
    contenu,
    categorie,
    createdAt: ts,
    source: 'lea',
  });

  return {
    success: true,
    ajouté: { contenu, categorie },
    message: `Note enregistrée : "${contenu.slice(0, 100)}${contenu.length > 100 ? '...' : ''}"`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// WAVE 3.9 — ÉCRITURE ÉTENDUE (mobile uniquement)
// 8 tools pour que Léa puisse modifier/supprimer dans pilotage/stock/marges
// NB : RH, fidélisation et banque restent exclus (choix produit du dirigeant)
// ═══════════════════════════════════════════════════════════════════════════

// Helper commun : charger pilotage d'un mois + garantir structure standard
async function loadPilotageMonth(uid, dateIso) {
  const monthKey = monthKeyFromDate(dateIso);
  const path = `pilotage/${uid}/months/${monthKey}`;
  const doc = await fsGet(path);
  const existing = doc ? docToObject(doc) : {};

  const parts = dateIso.split('/');
  const monthNum = parseInt(parts[1]);
  const yearNum = parseInt(parts[2]);
  const daysInMonth = new Date(yearNum, monthNum, 0).getDate();

  // Garantir structure ca[] de 1 ligne par jour
  let ca;
  if (Array.isArray(existing.ca) && existing.ca.length === daysInMonth) {
    ca = existing.ca.map(r => ({ ...r }));
  } else {
    ca = [];
    for (let d = 1; d <= daysInMonth; d++) {
      ca.push({ date: `${d}/${monthNum}/${yearNum}`, ht055: '', ht10: '', ht20: '' });
    }
    if (Array.isArray(existing.ca)) {
      for (const oldRow of existing.ca) {
        if (!oldRow.date) continue;
        const oldParts = String(oldRow.date).split('/');
        const oldDay = parseInt(oldParts[0]);
        if (oldDay >= 1 && oldDay <= daysInMonth) {
          ca[oldDay - 1] = { ...ca[oldDay - 1], ...oldRow };
        }
      }
    }
  }

  return { path, existing, ca, daysInMonth, monthNum, yearNum };
}

// ───────────────────────────────────────────────────────────────────
// tool_modifier_ligne_ca
// Modifie le montant HT d'une ligne CA à une date donnée, sur une TVA donnée.
// Utile pour CORRIGER une erreur, pas pour ajouter (utiliser ajouter_ca pour ajouter).
// Input : { date: "JJ/MM/AAAA", taux_tva: 5.5|10|20|2.1|8.5, nouveau_montant_ht: number }
// Le nouveau montant REMPLACE la valeur existante sur cette TVA (pas d'accumulation)
// ───────────────────────────────────────────────────────────────────
async function tool_modifier_ligne_ca(uid, input) {
  const montantHt = parseFloat(input.nouveau_montant_ht);
  if (isNaN(montantHt) || montantHt < 0) {
    return { error: "Le nouveau montant HT doit être un nombre positif ou zéro.", success: false };
  }
  if (montantHt > 1000000) {
    return { error: "Montant trop élevé, vérifie.", success: false };
  }
  const dateIso = parseDateFrToIso(input.date);
  if (!dateIso) return { error: "Date invalide. Format JJ/MM/AAAA.", success: false };
  const tvaField = normalizeTva(input.taux_tva);

  const { path, ca } = await loadPilotageMonth(uid, dateIso);

  // Trouver la ligne du jour
  const parts = dateIso.split('/');
  const dayOfMonth = parseInt(parts[0]);
  let targetIdx = dayOfMonth - 1;
  if (!ca[targetIdx] || ca[targetIdx].date !== dateIso) {
    targetIdx = ca.findIndex(r => r && r.date === dateIso);
    if (targetIdx === -1) return { error: `Ligne du ${dateIso} introuvable.`, success: false };
  }

  const ancienVal = parseFloat(ca[targetIdx][tvaField]) || 0;
  ca[targetIdx][tvaField] = montantHt === 0 ? '' : String(montantHt);

  // Traçabilité
  if (!ca[targetIdx]._leaModifications) ca[targetIdx]._leaModifications = [];
  ca[targetIdx]._leaModifications.push({
    action: 'modification',
    ancien: ancienVal,
    nouveau: montantHt,
    tva: tvaField,
    modifiedAt: new Date().toISOString(),
  });

  await fsPatch(path, { ca });

  const tvaDisplay = tvaField === 'ht055' ? '5,5%' : tvaField === 'ht10' ? '10%' : tvaField === 'ht21' ? '2,1%' : tvaField === 'ht85' ? '8,5%' : '20%';
  return {
    success: true,
    message: `Ligne CA du ${dateIso} en TVA ${tvaDisplay} : ${ancienVal}€ → ${montantHt}€`,
    ancien_montant: ancienVal,
    nouveau_montant: montantHt,
    date: dateIso,
    tva: tvaDisplay,
  };
}

// ───────────────────────────────────────────────────────────────────
// tool_supprimer_ligne_ca
// Remet à zéro TOUS les champs TVA d'une ligne CA à une date donnée.
// Input : { date: "JJ/MM/AAAA", confirmer: true }
// Exige explicitement confirmer:true pour éviter toute suppression accidentelle.
// ───────────────────────────────────────────────────────────────────
async function tool_supprimer_ligne_ca(uid, input) {
  if (input.confirmer !== true) {
    return { error: "Confirmation requise. Mets 'confirmer: true' pour valider la suppression.", success: false };
  }
  const dateIso = parseDateFrToIso(input.date);
  if (!dateIso) return { error: "Date invalide. Format JJ/MM/AAAA.", success: false };

  const { path, ca } = await loadPilotageMonth(uid, dateIso);

  const parts = dateIso.split('/');
  const dayOfMonth = parseInt(parts[0]);
  let targetIdx = dayOfMonth - 1;
  if (!ca[targetIdx] || ca[targetIdx].date !== dateIso) {
    targetIdx = ca.findIndex(r => r && r.date === dateIso);
    if (targetIdx === -1) return { error: `Ligne du ${dateIso} introuvable.`, success: false };
  }

  // Snapshot avant pour traçabilité
  const snapshot = {
    ht055: ca[targetIdx].ht055 || '',
    ht10: ca[targetIdx].ht10 || '',
    ht20: ca[targetIdx].ht20 || '',
    ht21: ca[targetIdx].ht21 || '',
    ht85: ca[targetIdx].ht85 || '',
    montantHT: ca[targetIdx].montantHT || '',
  };
  const avaitContenu = Object.values(snapshot).some(v => parseFloat(v) > 0);

  // Remettre à vide tous les champs de montant
  ca[targetIdx].ht055 = '';
  ca[targetIdx].ht10 = '';
  ca[targetIdx].ht20 = '';
  if ('ht21' in ca[targetIdx]) ca[targetIdx].ht21 = '';
  if ('ht85' in ca[targetIdx]) ca[targetIdx].ht85 = '';
  if ('montantHT' in ca[targetIdx]) ca[targetIdx].montantHT = '';

  if (!ca[targetIdx]._leaModifications) ca[targetIdx]._leaModifications = [];
  ca[targetIdx]._leaModifications.push({
    action: 'suppression',
    avant: snapshot,
    modifiedAt: new Date().toISOString(),
  });

  await fsPatch(path, { ca });

  return {
    success: true,
    message: avaitContenu
      ? `Ligne CA du ${dateIso} remise à zéro.`
      : `Ligne CA du ${dateIso} déjà vide, rien à faire.`,
    date: dateIso,
    avait_contenu: avaitContenu,
  };
}

// ───────────────────────────────────────────────────────────────────
// tool_modifier_ligne_charge
// Modifie ou supprime une ligne de charge (fixe ou variable) dans le mois courant.
// Comme les charges n'ont pas d'ID stable (c'est un tableau), on identifie par
// position dans la liste (index) OU par fournisseur+montant si fourni.
// Input : {
//   mois?: "YYYY-MM" (défaut: courant),
//   type: "fixe" | "variable",
//   identifier: { index?: number, fournisseur?: string, montant_ht?: number },
//   action: "modifier" | "supprimer",
//   nouvelles_valeurs?: { fournisseur?, type?, montant_ht?, tva_rate?, deductible?, pointe? }
// }
// ───────────────────────────────────────────────────────────────────
async function tool_modifier_ligne_charge(uid, input) {
  const monthKey = input.mois || currentYearMonth();
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    return { error: "Format mois invalide. Format : YYYY-MM.", success: false };
  }

  const typeCharge = (input.type || '').toLowerCase();
  if (typeCharge !== 'fixe' && typeCharge !== 'variable') {
    return { error: "Le champ 'type' doit être 'fixe' ou 'variable'.", success: false };
  }
  const champ = typeCharge === 'fixe' ? 'chargesFixe' : 'chargesVar';

  const action = (input.action || '').toLowerCase();
  if (action !== 'modifier' && action !== 'supprimer') {
    return { error: "Le champ 'action' doit être 'modifier' ou 'supprimer'.", success: false };
  }

  const path = `pilotage/${uid}/months/${monthKey}`;
  const doc = await fsGet(path);
  if (!doc) return { error: `Aucun doc pilotage pour le mois ${monthKey}.`, success: false };
  const existing = docToObject(doc);
  const charges = Array.isArray(existing[champ]) ? existing[champ].map(c => ({ ...c })) : [];

  if (charges.length === 0) {
    return { error: `Aucune charge ${typeCharge} dans ${monthKey}.`, success: false };
  }

  // Identifier la ligne
  const id = input.identifier || {};
  let targetIdx = -1;
  if (typeof id.index === 'number' && id.index >= 0 && id.index < charges.length) {
    targetIdx = id.index;
  } else if (id.fournisseur) {
    const srch = String(id.fournisseur).toLowerCase();
    // Match exact d'abord, puis partial
    targetIdx = charges.findIndex(c => (c.fournisseur || '').toLowerCase() === srch);
    if (targetIdx === -1) {
      targetIdx = charges.findIndex(c => (c.fournisseur || '').toLowerCase().includes(srch));
    }
    if (targetIdx !== -1 && id.montant_ht !== undefined) {
      // Vérifier que le montant colle (désambiguïsation)
      const got = parseFloat(charges[targetIdx].montantHT) || 0;
      if (Math.abs(got - parseFloat(id.montant_ht)) > 0.01) {
        // Chercher une autre ligne avec le bon montant
        const altIdx = charges.findIndex(c =>
          (c.fournisseur || '').toLowerCase().includes(srch) &&
          Math.abs((parseFloat(c.montantHT) || 0) - parseFloat(id.montant_ht)) < 0.01
        );
        if (altIdx !== -1) targetIdx = altIdx;
      }
    }
  }

  if (targetIdx === -1) {
    return {
      error: "Ligne introuvable. Précise l'index (0-based) ou le fournisseur exact.",
      success: false,
      charges_disponibles: charges.map((c, i) => ({
        index: i,
        fournisseur: c.fournisseur,
        type: c.type,
        montant_ht: c.montantHT,
      })),
    };
  }

  const avant = { ...charges[targetIdx] };

  if (action === 'supprimer') {
    charges.splice(targetIdx, 1);
    await fsPatch(path, { [champ]: charges });
    return {
      success: true,
      message: `Charge ${typeCharge} "${avant.fournisseur || 'sans nom'}" (${avant.montantHT}€) supprimée.`,
      charge_supprimee: avant,
    };
  }

  // action === 'modifier'
  const nv = input.nouvelles_valeurs || {};
  if (nv.fournisseur !== undefined) charges[targetIdx].fournisseur = String(nv.fournisseur);
  if (nv.type !== undefined) charges[targetIdx].type = String(nv.type);
  if (nv.montant_ht !== undefined) {
    const m = parseFloat(nv.montant_ht);
    if (isNaN(m) || m < 0) return { error: "montant_ht invalide.", success: false };
    charges[targetIdx].montantHT = String(m);
  }
  if (nv.tva_rate !== undefined) charges[targetIdx].tvaRate = parseFloat(nv.tva_rate) || 20;
  if (nv.deductible !== undefined) charges[targetIdx].deductible = nv.deductible ? 'Oui' : 'Non';
  if (nv.pointe !== undefined) charges[targetIdx].pointe = nv.pointe ? 'Oui' : 'Non';

  await fsPatch(path, { [champ]: charges });

  return {
    success: true,
    message: `Charge ${typeCharge} modifiée.`,
    avant: avant,
    apres: charges[targetIdx],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// STOCK — Wave 3.9
// ═══════════════════════════════════════════════════════════════════════════

function genUid() {
  return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ───────────────────────────────────────────────────────────────────
// tool_ajouter_produit_stock
// Crée un nouveau produit dans stock/{uid}/products/{id}
// Input : {
//   nom: string (requis), ref?: string (SKU, généré si absent),
//   ean?: string, stock_initial?: number (défaut 0), prix_achat?: number,
//   prix_vente?: number, categorie?: string, unite?: string, notes?: string,
//   stock_type?: "marchandise"|"matiere"|"fini" (défaut "marchandise")
// }
// ───────────────────────────────────────────────────────────────────
async function tool_ajouter_produit_stock(uid, input) {
  const nom = (input.nom || '').trim();
  if (!nom) return { error: "Le nom du produit est requis.", success: false };
  if (nom.length > 200) return { error: "Nom trop long (max 200).", success: false };

  const id = genUid();
  const ref = (input.ref || '').trim() || id.slice(-6).toUpperCase();
  const stockType = ['marchandise', 'matiere', 'fini'].includes(input.stock_type) ? input.stock_type : 'marchandise';

  const product = {
    id,
    ref,
    name: nom,
    stockType,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (input.ean) product.ean = String(input.ean);
  if (input.stock_initial !== undefined) product.stockBase = parseFloat(input.stock_initial) || 0;
  if (input.prix_achat !== undefined) product.pa = parseFloat(input.prix_achat) || 0;
  if (input.prix_vente !== undefined) product.pv = parseFloat(input.prix_vente) || 0;
  if (input.categorie) product.categorie = String(input.categorie);
  if (input.unite) product.unite = String(input.unite);
  if (input.notes) product.notes = String(input.notes).slice(0, 500);
  if (input.fournisseur) product.fournisseur = String(input.fournisseur);

  await fsCreateWithId(`stock/${uid}/products`, id, product);

  return {
    success: true,
    message: `Produit "${nom}" (réf ${ref}) ajouté au stock.`,
    produit: {
      id, ref, nom, stock_initial: product.stockBase || 0,
      prix_achat: product.pa || 0, prix_vente: product.pv || 0,
      stock_type: stockType,
    },
  };
}

// ───────────────────────────────────────────────────────────────────
// tool_ajuster_quantite_stock
// Ajuste la quantité d'un produit existant en créant un mouvement ADJUST.
// Ne modifie PAS le produit — le stock effectif est recalculé dynamiquement
// à partir de stockBase + tous les mouvements.
// Input : {
//   ref?: string (SKU) OU ean?: string OU nom?: string (l'un des 3 requis),
//   nouvelle_quantite: number (requis, >= 0),
//   motif?: string (recommandé: "inventaire", "casse", "correction", etc.)
// }
// ───────────────────────────────────────────────────────────────────
async function tool_ajuster_quantite_stock(uid, input) {
  const newQty = parseFloat(input.nouvelle_quantite);
  if (isNaN(newQty) || newQty < 0) {
    return { error: "nouvelle_quantite doit être >= 0.", success: false };
  }
  if (newQty > 1000000) {
    return { error: "Quantité trop élevée, vérifie.", success: false };
  }

  // Trouver le produit
  const prodList = await fsList(`stock/${uid}/products`, 2000);
  const prodDocs = prodList?.documents || [];
  let found = null;
  const srchRef = (input.ref || '').trim().toLowerCase();
  const srchEan = (input.ean || '').trim();
  const srchNom = (input.nom || '').trim().toLowerCase();
  if (!srchRef && !srchEan && !srchNom) {
    return { error: "Précise au moins un identifiant : ref, ean ou nom.", success: false };
  }

  for (const d of prodDocs) {
    const p = docToObject(d);
    const id = (d.name || '').split('/').pop();
    if (srchRef && (p.ref || '').toLowerCase() === srchRef) { found = { ...p, id }; break; }
    if (srchEan && (p.ean || '') === srchEan) { found = { ...p, id }; break; }
    if (srchNom && (p.name || '').toLowerCase() === srchNom) { found = { ...p, id }; break; }
  }
  // Fallback : match partiel sur nom
  if (!found && srchNom) {
    for (const d of prodDocs) {
      const p = docToObject(d);
      const id = (d.name || '').split('/').pop();
      if ((p.name || '').toLowerCase().includes(srchNom)) { found = { ...p, id }; break; }
    }
  }

  if (!found) {
    return { error: `Produit introuvable. Essaie avec une autre référence ou vérifie l'inventaire.`, success: false };
  }

  // Calculer le stock actuel = stockBase + sum(mouvements)
  const movList = await fsList(`stock/${uid}/movements`, 1000);
  const movDocs = movList?.documents || [];
  let currentQty = parseFloat(found.stockBase) || 0;
  let lastAdjustQty = null;
  for (const d of movDocs) {
    const m = docToObject(d);
    if ((m.ref || '').toLowerCase() !== (found.ref || '').toLowerCase()) continue;
    if (m.type === 'ADJUST') {
      // ADJUST définit la quantité absolue
      currentQty = parseFloat(m.qty) || 0;
      lastAdjustQty = currentQty;
    } else if (m.type === 'IN' || m.type === 'RETURN_IN') {
      currentQty += parseFloat(m.qty) || 0;
    } else if (m.type === 'OUT' || m.type === 'LOSS' || m.type === 'RETURN_OUT') {
      currentQty -= parseFloat(m.qty) || 0;
    }
  }

  // Créer le mouvement ADJUST
  const movId = genUid();
  const motif = (input.motif || 'Ajustement par Léa').slice(0, 200);
  const mov = {
    id: movId,
    date: new Date().toISOString().slice(0, 10),
    type: 'ADJUST',
    ref: found.ref,
    qty: newQty,
    pa: parseFloat(found.pa) || 0,
    note: `${motif} (${currentQty} → ${newQty}, via Léa)`,
  };
  await fsCreateWithId(`stock/${uid}/movements`, movId, mov);

  return {
    success: true,
    message: `Stock "${found.name}" ajusté : ${currentQty} → ${newQty} (${motif})`,
    produit: { id: found.id, ref: found.ref, nom: found.name },
    ancien_stock: currentQty,
    nouveau_stock: newQty,
    difference: newQty - currentQty,
    motif,
  };
}

// ───────────────────────────────────────────────────────────────────
// tool_marquer_rupture_stock
// Raccourci : met un produit à 0 (équivalent ajuster_quantite_stock avec 0)
// Input : { ref?: string, ean?: string, nom?: string (un requis) }
// ───────────────────────────────────────────────────────────────────
async function tool_marquer_rupture_stock(uid, input) {
  return tool_ajuster_quantite_stock(uid, {
    ref: input.ref,
    ean: input.ean,
    nom: input.nom,
    nouvelle_quantite: 0,
    motif: input.motif || 'Rupture de stock',
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// MARGES — Wave 3.9
// ═══════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────
// tool_creer_fiche_marge
// Crée une fiche marge produit dans marges/{uid}/produits/{id}
// Input : {
//   nom: string (requis),
//   prix_vente: number (requis, HT),
//   matiere_premiere?: number, main_oeuvre?: number,
//   emballage?: number, livraison?: number,
//   charges_fixes?: number, quantite?: number (défaut 1),
//   categorie?: string, emoji?: string
// }
// ───────────────────────────────────────────────────────────────────
async function tool_creer_fiche_marge(uid, input) {
  const nom = (input.nom || '').trim();
  if (!nom) return { error: "Le nom du produit est requis.", success: false };
  if (nom.length > 200) return { error: "Nom trop long.", success: false };

  const pv = parseFloat(input.prix_vente);
  if (isNaN(pv) || pv < 0) return { error: "prix_vente doit être un nombre >= 0.", success: false };

  const id = 'prod_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const fiche = {
    nom,
    pv: String(pv),
    qte: String(parseFloat(input.quantite) || 1),
    mp: String(parseFloat(input.matiere_premiere) || 0),
    mo: String(parseFloat(input.main_oeuvre) || 0),
    emb: String(parseFloat(input.emballage) || 0),
    liv: String(parseFloat(input.livraison) || 0),
    cfTotal: String(parseFloat(input.charges_fixes) || 0),
    categorie: String(input.categorie || '').slice(0, 80),
    emoji: String(input.emoji || '📦').slice(0, 4),
    createdAt: new Date().toISOString(),
    source: 'lea',
  };

  await fsCreateWithId(`marges/${uid}/produits`, id, fiche);

  // Calcul indicatif de marge pour retour immédiat
  const coutTotal = parseFloat(fiche.mp) + parseFloat(fiche.mo) + parseFloat(fiche.emb) + parseFloat(fiche.liv) + parseFloat(fiche.cfTotal);
  const margeEur = pv - coutTotal;
  const margePct = pv > 0 ? (margeEur / pv) * 100 : 0;

  return {
    success: true,
    message: `Fiche marge "${nom}" créée (PV ${pv}€, marge brute ${Math.round(margeEur * 100) / 100}€ soit ${Math.round(margePct * 10) / 10}%).`,
    fiche: {
      id, nom, prix_vente: pv,
      cout_total: Math.round(coutTotal * 100) / 100,
      marge_eur: Math.round(margeEur * 100) / 100,
      marge_pct: Math.round(margePct * 10) / 10,
    },
  };
}

// ───────────────────────────────────────────────────────────────────
// tool_modifier_fiche_marge
// Modifie les prix/coûts d'une fiche existante.
// Input : {
//   identifier: { id?: string, nom?: string (un requis) },
//   nouvelles_valeurs: {
//     nom?, prix_vente?, matiere_premiere?, main_oeuvre?,
//     emballage?, livraison?, charges_fixes?, quantite?, categorie?, emoji?
//   }
// }
// ───────────────────────────────────────────────────────────────────
async function tool_modifier_fiche_marge(uid, input) {
  const id = input.identifier || {};
  const nv = input.nouvelles_valeurs || {};

  // Trouver la fiche
  let ficheId = (id.id || '').trim();
  let existingDoc = null;

  if (ficheId) {
    existingDoc = await fsGet(`marges/${uid}/produits/${ficheId}`);
    if (!existingDoc) return { error: `Fiche id "${ficheId}" introuvable.`, success: false };
  } else if (id.nom) {
    const srchNom = String(id.nom).toLowerCase().trim();
    const list = await fsList(`marges/${uid}/produits`, 500);
    const docs = list?.documents || [];
    const found = docs.find(d => {
      const data = docToObject(d);
      return (data.nom || '').toLowerCase() === srchNom;
    }) || docs.find(d => {
      const data = docToObject(d);
      return (data.nom || '').toLowerCase().includes(srchNom);
    });
    if (!found) return { error: `Aucune fiche marge trouvée pour "${id.nom}".`, success: false };
    ficheId = (found.name || '').split('/').pop();
    existingDoc = found;
  } else {
    return { error: "Précise un identifier : id ou nom.", success: false };
  }

  const existing = docToObject(existingDoc);
  const updated = { ...existing };

  if (nv.nom !== undefined) updated.nom = String(nv.nom);
  if (nv.prix_vente !== undefined) updated.pv = String(parseFloat(nv.prix_vente) || 0);
  if (nv.matiere_premiere !== undefined) updated.mp = String(parseFloat(nv.matiere_premiere) || 0);
  if (nv.main_oeuvre !== undefined) updated.mo = String(parseFloat(nv.main_oeuvre) || 0);
  if (nv.emballage !== undefined) updated.emb = String(parseFloat(nv.emballage) || 0);
  if (nv.livraison !== undefined) updated.liv = String(parseFloat(nv.livraison) || 0);
  if (nv.charges_fixes !== undefined) updated.cfTotal = String(parseFloat(nv.charges_fixes) || 0);
  if (nv.quantite !== undefined) updated.qte = String(parseFloat(nv.quantite) || 1);
  if (nv.categorie !== undefined) updated.categorie = String(nv.categorie).slice(0, 80);
  if (nv.emoji !== undefined) updated.emoji = String(nv.emoji).slice(0, 4);
  updated.updatedAt = new Date().toISOString();

  await fsPatch(`marges/${uid}/produits/${ficheId}`, updated);

  const pv = parseFloat(updated.pv) || 0;
  const coutTotal = (parseFloat(updated.mp) || 0) + (parseFloat(updated.mo) || 0)
                  + (parseFloat(updated.emb) || 0) + (parseFloat(updated.liv) || 0)
                  + (parseFloat(updated.cfTotal) || 0);
  const margeEur = pv - coutTotal;
  const margePct = pv > 0 ? (margeEur / pv) * 100 : 0;

  return {
    success: true,
    message: `Fiche marge "${updated.nom}" modifiée. Marge brute ${Math.round(margeEur * 100) / 100}€ (${Math.round(margePct * 10) / 10}%).`,
    fiche: {
      id: ficheId, nom: updated.nom, prix_vente: pv,
      cout_total: Math.round(coutTotal * 100) / 100,
      marge_eur: Math.round(margeEur * 100) / 100,
      marge_pct: Math.round(margePct * 10) / 10,
    },
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
      // ── Wave 3.8 : lecture étendue ──
      case 'lire_planning_rh':     result = await tool_lire_planning_rh(uid, input || {}); break;
      case 'lire_emargements_rh':  result = await tool_lire_emargements_rh(uid, input || {}); break;
      case 'lire_conges_complets': result = await tool_lire_conges_complets(uid, input || {}); break;
      case 'lire_cashflow':        result = await tool_lire_cashflow(uid, input || {}); break;
      case 'lire_dettes':          result = await tool_lire_dettes(uid, input || {}); break;
      case 'lire_profil_entreprise': result = await tool_lire_profil_entreprise(uid, input || {}); break;
      case 'lire_fournisseurs':    result = await tool_lire_fournisseurs(uid, input || {}); break;
      case 'lire_cartes_cadeaux':  result = await tool_lire_cartes_cadeaux(uid, input || {}); break;
      case 'lire_panier_moyen':    result = await tool_lire_panier_moyen(uid, input || {}); break;
      case 'lire_bilans':          result = await tool_lire_bilans(uid, input || {}); break;
      case 'lire_objectifs_rh':    result = await tool_lire_objectifs_rh(uid, input || {}); break;
      case 'lire_recrutement_rh':  result = await tool_lire_recrutement_rh(uid, input || {}); break;
      case 'enregistrer_fait_business': result = await tool_enregistrer_fait_business(uid, input || {}); break;
      case 'enregistrer_preference':    result = await tool_enregistrer_preference(uid, input || {}); break;
      case 'ajouter_ca':         result = await tool_ajouter_ca(uid, input || {}); break;
      case 'ajouter_charge':     result = await tool_ajouter_charge(uid, input || {}); break;
      case 'ajouter_note':       result = await tool_ajouter_note(uid, input || {}); break;
      // ── Wave 3.9 : écriture étendue ──
      case 'modifier_ligne_ca':       result = await tool_modifier_ligne_ca(uid, input || {}); break;
      case 'supprimer_ligne_ca':      result = await tool_supprimer_ligne_ca(uid, input || {}); break;
      case 'modifier_ligne_charge':   result = await tool_modifier_ligne_charge(uid, input || {}); break;
      case 'ajouter_produit_stock':   result = await tool_ajouter_produit_stock(uid, input || {}); break;
      case 'ajuster_quantite_stock':  result = await tool_ajuster_quantite_stock(uid, input || {}); break;
      case 'marquer_rupture_stock':   result = await tool_marquer_rupture_stock(uid, input || {}); break;
      case 'creer_fiche_marge':       result = await tool_creer_fiche_marge(uid, input || {}); break;
      case 'modifier_fiche_marge':    result = await tool_modifier_fiche_marge(uid, input || {}); break;
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
// 6. SYSTEM PROMPT + MÉMOIRE LONG TERME
// ═══════════════════════════════════════════════════════════════════════════

// Charge les 3 briques de mémoire long terme de l'utilisateur
async function loadMemory(uid) {
  const out = {
    summary: null,
    facts: [],
    preferences: [],
  };

  // 1. Résumé business
  const summaryDoc = await fsGet(`agent/${uid}/memory/business-summary`);
  if (summaryDoc) {
    out.summary = {
      text: fv(summaryDoc, 'text') || '',
      generatedAt: fv(summaryDoc, 'generatedAt') || null,
      version: parseInt(fv(summaryDoc, 'version') || 0),
    };
  }

  // 2. Faits (liste, triés par date de création desc)
  const factsRes = await fsList(`agent/${uid}/memory-facts`, 100);
  const factsDocs = factsRes?.documents || [];
  out.facts = factsDocs
    .map(d => ({
      id: (d.name || '').split('/').pop(),
      fait: fv(d, 'fait') || '',
      categorie: fv(d, 'categorie') || 'autre',
      createdAt: fv(d, 'createdAt') || '',
    }))
    .filter(f => f.fait)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 50); // max 50 faits dans le contexte (anti-explosion)

  // 3. Préférences (singleton par type)
  const prefsRes = await fsList(`agent/${uid}/memory-preferences`, 20);
  const prefsDocs = prefsRes?.documents || [];
  out.preferences = prefsDocs
    .map(d => ({
      type: (d.name || '').split('/').pop(),
      preference: fv(d, 'preference') || '',
      updatedAt: fv(d, 'updatedAt') || '',
    }))
    .filter(p => p.preference);

  return out;
}

function buildSystemPrompt(userDoc, userEmail, memory, opts) {
  const prenom = fv(userDoc, 'name') || fv(userDoc, 'prenom') || (userEmail?.split('@')[0] || '');
  const entreprise = fv(userDoc, 'entreprise') || fv(userDoc, 'nomEntreprise') || '';
  const today = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const isMobile = opts?.mobile === true;

  // Section mémoire : injectée seulement si on a quelque chose à dire
  let memorySection = '';
  if (memory && (memory.summary?.text || memory.facts.length || memory.preferences.length)) {
    memorySection = '\n\n# CE QUE TU SAIS DÉJÀ SUR L\'ENTREPRISE ET SON DIRIGEANT\n';
    memorySection += '(Utilise ces informations pour personnaliser tes réponses, mais ne les récite pas bêtement. Cite-les quand c\'est pertinent.)\n\n';

    if (memory.summary?.text) {
      memorySection += `## Synthèse du business\n${memory.summary.text}\n\n`;
    }

    if (memory.facts.length) {
      memorySection += `## Faits mémorisés (${memory.facts.length})\n`;
      for (const f of memory.facts) {
        memorySection += `- [${f.categorie}] ${f.fait}\n`;
      }
      memorySection += '\n';
    }

    if (memory.preferences.length) {
      memorySection += '## Préférences du dirigeant\n';
      for (const p of memory.preferences) {
        memorySection += `- ${p.preference}\n`;
      }
      memorySection += '\n';
    }
  }

  const mobileSection = isMobile ? `

# CONTEXTE : TU ES DANS L'APP MOBILE LÉA
Le dirigeant te parle depuis son téléphone (app mobile Léa). Adapte-toi :
- Sois ENCORE PLUS concise : 1-3 phrases max, pas de longs paragraphes (lecture mobile)
- Évite les listes à puces quand possible, préfère le texte fluide
- Pour les chiffres : format lisible sur petit écran (ex : "12 340 €" plutôt que tableaux)
- Si tu réponds à une question vocale, ton texte sera aussi lu à voix haute : utilise des phrases orales fluides

## TOOLS D'ÉCRITURE ACTIFS EN MODE MOBILE
Tu as accès à **ajouter_ca**, **ajouter_charge** et **ajouter_note** pour modifier directement le pilotage.

**Règle critique** : avant TOUTE écriture, suis cette logique :
1. Si le message est clair et non-ambigu (ex: "ajoute 1500€ de CA en TVA 20 aujourd'hui") → exécute directement le tool puis confirme brièvement
2. Si un paramètre est flou (montant imprécis, date ambiguë, TVA non spécifiée et doute possible) → DEMANDE une clarification avant d'écrire
3. Après écriture réussie, confirme en une phrase courte : "✅ J'ai ajouté 1 500 € en TVA 20% pour aujourd'hui." (plutôt que "le tool a été appelé avec succès")

## ⚠️ HONNÊTETÉ SUR LE RÉSULTAT DES TOOLS (ABSOLUMENT CRITIQUE)

Quand tu appelles un tool d'écriture, tu DOIS lire la valeur de retour :
- Si le résultat contient \`success: true\` → tu peux confirmer l'ajout
- Si le résultat contient \`error: "..."\` ou \`success: false\` → tu DOIS signaler clairement l'échec au dirigeant avec le message d'erreur. Jamais prétendre que ça a marché.

**Exemple d'erreur** : si \`ajouter_ca\` renvoie \`{ error: "Montant invalide", success: false }\`, tu réponds : "⚠️ Je n'ai pas réussi à ajouter ce CA : montant invalide. Peux-tu me redonner le montant ?"

**NE JAMAIS** dire "c'est noté" ou "c'est ajouté" sans avoir reçu \`success: true\` dans le tool_result. Si tu n'es pas sûre, réappelle le tool ou demande au dirigeant.

**Valeurs par défaut raisonnables** :
- Date non précisée → aujourd'hui
- TVA non précisée pour un CA → 20% (le plus courant). Mais si le dirigeant est visiblement dans la restauration (résumé business), propose 10%.
- Type de charge non précisé → "variable" par défaut

**NE JAMAIS** inventer un montant. Si le dirigeant dit "ajoute une vente" sans chiffre, demande "combien ?".` : '';

  const mobileHeader = isMobile ? `🚨 MODE APP MOBILE ACTIF — LIS CECI AVANT TOUT

Tu es dans l'app mobile Léa. Le dirigeant peut te demander d'AJOUTER, MODIFIER ou SUPPRIMER des données dans Alteore. Tu as 11 tools d'ÉCRITURE actifs :

**Pilotage :**
- **ajouter_ca** — ajouter du CA (montant HT, TVA, date)
- **modifier_ligne_ca** — CORRIGER une ligne CA existante (remplace le montant sur une TVA+date)
- **supprimer_ligne_ca** — remettre à zéro une ligne CA (EXIGE confirmer:true)
- **ajouter_charge** — ajouter une charge fixe ou variable
- **modifier_ligne_charge** — modifier ou supprimer une charge existante

**Stock :**
- **ajouter_produit_stock** — créer un nouveau produit
- **ajuster_quantite_stock** — ajuster le stock d'un produit existant
- **marquer_rupture_stock** — mettre un produit à 0 (rupture)

**Marges :**
- **creer_fiche_marge** — créer une fiche marge avec calcul auto
- **modifier_fiche_marge** — modifier prix/coûts d'une fiche

**Autres :**
- **ajouter_note** — noter un rappel dans le carnet de bord

**INSTRUCTION IMPÉRATIVE — AUCUNE EXCEPTION :**

Quand le dirigeant formule une demande d'action (ajouter/modifier/supprimer/créer/corriger/remplacer), tu DOIS appeler le tool correspondant.

Exemples avec leur tool :
- "ajoute 1000€ de CA" → ajouter_ca
- "corrige la ligne CA du 15 avril à 800€" → modifier_ligne_ca
- "supprime la ligne CA du 10 mai" → DEMANDE CONFIRMATION puis supprimer_ligne_ca avec confirmer:true
- "change le loyer du mois à 1200€" → modifier_ligne_charge action:modifier
- "efface la charge de 250€ d'Amazon" → modifier_ligne_charge action:supprimer
- "crée un produit pain de campagne à 2,50€" → ajouter_produit_stock
- "ajuste le stock de CHEM-BLA à 20" → ajuster_quantite_stock
- "plus de pain au chocolat" → marquer_rupture_stock
- "crée une fiche marge burger à 12€ coûts 4€" → creer_fiche_marge
- "change le prix de vente du burger à 15€" → modifier_fiche_marge

→ **Tu DOIS appeler le tool correspondant**. Tu NE DOIS PAS répondre directement par du texte du genre "c'est fait" ou "je ne peux pas" sans avoir appelé de tool. Tu appelles le tool, tu attends son résultat, puis tu confirmes.

**Si tu réponds à une demande d'action sans avoir appelé le tool, c'est un ÉCHEC GRAVE**. Le dirigeant te voit répondre "c'est noté" alors que RIEN n'est écrit dans son logiciel. C'est pire que de dire "je n'ai pas compris".

**Modules EXCLUS de l'écriture (lecture seule) :**
- **RH** (employés, planning, congés, émargements) — tu peux LIRE mais pas MODIFIER
- **Fidélisation** (clients fidélité, points) — tu peux LIRE mais pas MODIFIER
- **Banque** (connexions, transactions) — tu peux LIRE mais pas MODIFIER

Si le dirigeant demande d'agir sur ces modules, dis gentiment que ces actions ne sont pas disponibles et proposent de le faire sur la page web correspondante.

**Règles de prudence pour les actions destructrices :**
- Avant un **supprimer_ligne_ca** : confirme verbalement le contenu qui va être effacé
- Avant un **supprimer charge** : confirme le fournisseur et le montant
- Avant un **marquer_rupture_stock** : vérifie que c'est bien le bon produit (match nom partiel)

**Défauts quand non précisé :**
- TVA non précisée → 20% (sauf restauration → 10%)
- Date non précisée → aujourd'hui
- Mois non précisé pour une charge → mois courant
- Type de charge non précisé → "variable"
- Stock_type non précisé → "marchandise"

**Après chaque appel de tool :**
- Si \`success: true\` → confirme brièvement avec le message retourné (le dirigeant aime les confirmations courtes : "C'est fait", "Noté", "Corrigé")
- Si \`error\` ou \`success: false\` → signale l'erreur textuellement, ne prétends JAMAIS que ça a marché

────────────────────────────────────────────────
` : '';

  return `${mobileHeader}Tu es Léa, l'employée IA d'Alteore. Tu es le bras droit du dirigeant : tu gères le pilotage financier, la trésorerie, les stocks, la RH, la fidélisation client.

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
1. **Va chercher les données avant de répondre** : utilise les tools de lecture dès que la question concerne des chiffres. **Ne jamais inventer un chiffre.**
2. **Concise par défaut** : 2-4 phrases. Va droit au but.
3. **Chiffres d'abord, analyse ensuite** : format "Ton CA d'avril est de **45 320 €**. +12 % vs mars, tu progresses bien."
4. **Honnêteté** : si un tool renvoie vide ou erreur, dis-le franchement.
5. **Format français** : euros avec espaces pour milliers et virgule pour décimales (**15 420,50 €**). Pourcentages avec 1 décimale max (**12,5 %**).
6. **Markdown léger autorisé** : **gras** sur les chiffres clés, listes à puces pour énumérations courtes, pas d'abus.
7. **Comparaisons** : variation en **€ ET en %**. Ex: "+2 340 € (+18,5 %)".
8. **Ambiguïté** : pose UNE question de clarification, jamais plusieurs.
9. **Proactivité discrète** : si tu vois un signal important (tréso tendue, rupture imminente, marge qui glisse), mentionne-le brièvement à la fin.
10. **Appels multi-tools** : plusieurs tools dans la même réponse si besoin.

# MÉMORISATION AUTONOME (IMPORTANT)
Tu as deux tools d'écriture pour construire ta mémoire long terme :
- **enregistrer_fait_business** : utilise-le DE TA PROPRE INITIATIVE quand tu repères un fait qui mérite d'être retenu pour plus tard (échéance récurrente, info client/employé clé, objectif annoncé, particularité business, saisonnalité, etc.). Ne demande PAS l'autorisation. Quand tu le fais, mentionne-le en une phrase courte dans ta réponse ("Je note que..." / "J'enregistre...").
- **enregistrer_preference** : utilise-le quand le dirigeant te donne une consigne de style ("réponds en plus court", "pas d'emoji", etc.).

Ces mémoires te suivront d'une conversation à l'autre. Utilise-les avec parcimonie : ne mémorise pas tout et n'importe quoi, seulement ce qui a une vraie valeur de long terme. Ne re-mémorise jamais un fait déjà présent dans la section "Faits mémorisés" ci-dessous.

# TOOLS DISPONIBLES
Lecture :
- **lire_pilotage** : CA, charges, crédits pour un mois ou toute une année
- **lire_historique_ca** : CA sur N mois glissants
- **lire_banque** : soldes et mouvements bancaires
- **lire_stock** : inventaire, ruptures, valorisation
- **lire_rh** : employés, masse salariale, congés en attente
- **lire_fidelisation** : clients fid, segmentation, top clients
- **lire_marges** : fiches marges produits, top/bottom rentabilité
- **lire_planning_rh** : planning/horaires/shifts des employés sur une période (défaut: 2 prochaines semaines)
- **lire_emargements_rh** : heures pointées, fiches mensuelles, écarts planning/réel
- **lire_conges_complets** : tous les congés (approuvés, en attente, refusés, historique)
- **lire_cashflow** : trésorerie actuelle + projection mois courant
- **lire_dettes** : emprunts, leasings, dettes fournisseurs, découverts
- **lire_profil_entreprise** : SIRET, forme juridique, CCN/IDCC, dirigeant, adresse
- **lire_fournisseurs** : liste fournisseurs + fiches factures achat archivées
- **lire_cartes_cadeaux** : cartes cadeaux vendues (CA différé), soldes
- **lire_panier_moyen** : panier moyen et transactions mois par mois
- **lire_bilans** : bilans comptables annuels (CA, résultat, ratios, analyse IA)
- **lire_objectifs_rh** : objectifs commerciaux par employé (cible vs réalisé)
- **lire_recrutement_rh** : offres, candidats, entretiens en cours

Écriture mémoire :
- **enregistrer_fait_business** : mémoriser un fait important sur le business
- **enregistrer_preference** : mémoriser une préférence de style du dirigeant
${isMobile ? `
Écriture données (app mobile uniquement) :
Pilotage :
- **ajouter_ca** : ajouter du CA (montant HT, TVA, date)
- **modifier_ligne_ca** : corriger une ligne CA existante
- **supprimer_ligne_ca** : remettre à zéro une ligne CA (confirmer:true obligatoire)
- **ajouter_charge** : ajouter une charge fixe/variable
- **modifier_ligne_charge** : modifier ou supprimer une charge

Stock :
- **ajouter_produit_stock** : créer un nouveau produit
- **ajuster_quantite_stock** : modifier le stock d'un produit existant
- **marquer_rupture_stock** : passer un produit à 0

Marges :
- **creer_fiche_marge** : créer une fiche marge (calcul auto marge brute)
- **modifier_fiche_marge** : modifier prix/coûts d'une fiche

Autres :
- **ajouter_note** : noter un rappel dans le carnet de bord
` : ''}
# CE QUE TU NE FAIS PAS
Tu ne peux pas encore :
- Envoyer des emails, SMS, générer des contrats (Waves 4-6)
- ${isMobile ? 'Modifier les données **RH** (employés/planning/congés), **fidélisation** (clients/points), **banque** (transactions). Tu peux LIRE ces modules mais pas y écrire.' : 'Modifier les données business (tu peux juste mémoriser des faits et préférences)'}
- Programmer des rappels ou tâches récurrentes (Wave 4)

Si on te demande ces actions : explique gentiment que ça arrive bientôt.${mobileSection}${memorySection}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. MAIN CLAUDE LOOP
// ═══════════════════════════════════════════════════════════════════════════

async function runConversation(uid, userDoc, userEmail, userMessage, history, memory, opts) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY manquante');

  const isMobile = opts?.mobile === true;
  const systemPrompt = buildSystemPrompt(userDoc, userEmail, memory, { mobile: isMobile });

  // Filtrer les tools : tools d'écriture données uniquement en mode mobile
  // pour éviter les écritures intempestives depuis le site web.
  const WRITE_DATA_TOOLS = [
    // Wave 3.7 mobile
    'ajouter_ca', 'ajouter_charge', 'ajouter_note',
    // Wave 3.9 écriture étendue
    'modifier_ligne_ca', 'supprimer_ligne_ca', 'modifier_ligne_charge',
    'ajouter_produit_stock', 'ajuster_quantite_stock', 'marquer_rupture_stock',
    'creer_fiche_marge', 'modifier_fiche_marge',
  ];
  const activeTools = isMobile
    ? TOOLS
    : TOOLS.filter(t => !WRITE_DATA_TOOLS.includes(t.name));

  console.log(`[agent-chat DEBUG] isMobile=${isMobile} activeTools.length=${activeTools.length} tools_names=[${activeTools.map(t=>t.name).join(',')}]`);

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
  const toolTraces = [];

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
        tools: activeTools,
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

    // ═══════════════════════════════════════════════════════════════════
    // Exécution des tools : SEQUENTIEL pour écriture, PARALLELE pour lecture
    // ═══════════════════════════════════════════════════════════════════
    // Les tools d'écriture (ajouter_ca, ajouter_charge, etc.) doivent s'exécuter
    // en séquence : si Léa appelle 2x ajouter_ca dans la même réponse (ex: "ajoute
    // 500 en TVA 5.5 ET 1500 en TVA 10"), le 2e appel doit voir le résultat du 1er
    // pour ne pas écraser l'écriture. En parallèle, ils liraient tous les deux
    // le même état initial → race condition → last write wins.
    //
    // Les tools de lecture restent en parallèle (pas d'effet de bord).
    const WRITE_TOOLS = [
      // Wave 3 mémoire
      'enregistrer_fait_business', 'enregistrer_preference',
      // Wave 3.7 mobile
      'ajouter_ca', 'ajouter_charge', 'ajouter_note',
      // Wave 3.9 écriture étendue
      'modifier_ligne_ca', 'supprimer_ligne_ca', 'modifier_ligne_charge',
      'ajouter_produit_stock', 'ajuster_quantite_stock', 'marquer_rupture_stock',
      'creer_fiche_marge', 'modifier_fiche_marge',
    ];
    const hasWriteTool = toolUses.some(tu => WRITE_TOOLS.includes(tu.name));

    let toolResults;
    if (hasWriteTool) {
      // Exécution séquentielle stricte pour préserver la cohérence
      toolResults = [];
      for (const tu of toolUses) {
        toolsUsed.push(tu.name);
        const result = await executeTool(tu.name, tu.input, uid);
        toolTraces.push({
          name: tu.name,
          input: tu.input,
          result_preview: JSON.stringify(result).slice(0, 400),
          success: result && !result.error,
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        });
      }
    } else {
      // Lecture pure : parallèle pour la perf
      toolResults = await Promise.all(
        toolUses.map(async tu => {
          toolsUsed.push(tu.name);
          const result = await executeTool(tu.name, tu.input, uid);
          toolTraces.push({
            name: tu.name,
            input: tu.input,
            result_preview: JSON.stringify(result).slice(0, 400),
            success: result && !result.error,
          });
          return {
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(result),
          };
        })
      );
    }

    // Ajouter les résultats au contexte
    messages.push({ role: 'user', content: toolResults });
  }

  return {
    text: finalText,
    iterations,
    toolsUsed: [...new Set(toolsUsed)], // unique
    toolTraces, // détail de chaque exécution pour debug
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
  const { message, mobile } = req.body || {};
  // LOG DEBUG Wave 3.7 — voir si le flag mobile arrive bien
  console.log(`[agent-chat DEBUG] mobile=${mobile} typeof=${typeof mobile} message="${(message || '').slice(0, 80)}"`);
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

    // Mémoire long terme (Wave 3)
    const memory = await loadMemory(uid);

    // Sauver le message user AVANT de lancer Claude (au cas où ça crash, on garde trace)
    await saveMessage(uid, 'user', message.trim());

    // Claude !
    const result = await runConversation(uid, userDoc, email, message.trim(), history, memory, { mobile: mobile === true });

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
      toolTraces: (mobile === true) ? result.toolTraces : undefined,
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
