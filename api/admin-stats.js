// api/admin-stats.js
// ══════════════════════════════════════════════════════════════════
// API d'agrégation pour la page admin-reporting.html
//
// Sécurité :
//   • POST avec header Authorization: Bearer <idToken>
//   • L'idToken doit appartenir à contact@adrienemily.com (vérifié via Identity Toolkit)
//
// Lit (avec admin token api@altiora.app) :
//   • users/                   → plan, createdAt, trialEnd, promoEnd, promoCode, stripe*…
//   • users_activity/          → lastLogin, loginCount, lastActivity, modulesUsed, daysActive
//   • bank_connections/        → comptage clients banque actifs
//   • fidelite/{uid}/clients/  → comptage clients fidélisation actifs (présence)
//   • rh/{uid}/employes/       → comptage clients RH actifs (présence)
//   • referrals/               → top parrains
//   • retention_logs/          → résiliations 30 jours
//   • tickets/{uid}/list/      → tickets ouverts (status != closed)
//
// Renvoie un JSON structuré pour le dashboard.
// ══════════════════════════════════════════════════════════════════

const FIREBASE_PROJECT = 'altiora-70599';
const FB_KEY = 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
const ADMIN_EMAIL = 'contact@adrienemily.com';

// Tarifs (utilisés pour le MRR estimé)
const PLAN_PRICING = {
  pro:    { monthly: 69,  yearly: 660  / 12 },
  max:    { monthly: 99,  yearly: 948  / 12 },
  master: { monthly: 169, yearly: 1620 / 12 },
};

// ══════════════════════════════════════════════════════════════════
// HELPERS — Firebase REST
// ══════════════════════════════════════════════════════════════════

let _adminToken = null;
let _adminTokenExp = 0;

async function getAdminToken() {
  if (_adminToken && Date.now() < _adminTokenExp - 300000) return _adminToken;
  const fbKey = process.env.FIREBASE_API_KEY || FB_KEY;
  const email = process.env.FIREBASE_API_EMAIL;
  const password = process.env.FIREBASE_API_PASSWORD;
  if (!email || !password) throw new Error('Missing FIREBASE_API_EMAIL/PASSWORD env vars');
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${fbKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) }
  );
  const data = await r.json();
  if (!data.idToken) throw new Error('Admin login failed: ' + (data.error?.message || 'unknown'));
  _adminToken = data.idToken;
  _adminTokenExp = Date.now() + (parseInt(data.expiresIn || '3600') * 1000);
  return _adminToken;
}

// Parse un fields Firestore (récursif pour gérer mapValue / arrayValue / timestampValue)
function parseFields(fields) {
  if (!fields) return {};
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = parseValue(v);
  }
  return out;
}

function parseValue(v) {
  if (v == null) return null;
  if (v.stringValue !== undefined)    return v.stringValue;
  if (v.integerValue !== undefined)   return parseInt(v.integerValue, 10);
  if (v.doubleValue !== undefined)    return parseFloat(v.doubleValue);
  if (v.booleanValue !== undefined)   return v.booleanValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.nullValue !== undefined)      return null;
  if (v.mapValue !== undefined)       return parseFields(v.mapValue.fields || {});
  if (v.arrayValue !== undefined)     return (v.arrayValue.values || []).map(parseValue);
  return null;
}

async function fsListAll(collectionId, token, pageSize = 300) {
  const all = [];
  let pageToken = '';
  for (let i = 0; i < 50; i++) {
    let url = `${FS_BASE}/${collectionId}?pageSize=${pageSize}`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!res.ok) break;
    const data = await res.json();
    const docs = data.documents || [];
    for (const d of docs) {
      const id = d.name.split('/').pop();
      all.push({ id, data: parseFields(d.fields), _name: d.name });
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return all;
}

// Lister les sous-collections d'un doc (utile pour count rapide)
async function fsCountSubcollection(parentPath, subColl, token) {
  const url = `${FS_BASE}/${parentPath}/${subColl}?pageSize=1`;
  try {
    const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!res.ok) return 0;
    const data = await res.json();
    return (data.documents || []).length > 0 ? 1 : 0; // présence binaire (1 = utilise le module)
  } catch (_) { return 0; }
}

// ══════════════════════════════════════════════════════════════════
// VÉRIFICATION IDTOKEN ADMIN
// ══════════════════════════════════════════════════════════════════

async function verifyAdminIdToken(idToken) {
  const fbKey = process.env.FIREBASE_API_KEY || FB_KEY;
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${fbKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
  );
  const data = await r.json();
  if (!data.users || !data.users[0]) return null;
  const user = data.users[0];
  if (user.email !== ADMIN_EMAIL) return null;
  return { uid: user.localId, email: user.email };
}

// ══════════════════════════════════════════════════════════════════
// AGRÉGATION
// ══════════════════════════════════════════════════════════════════

function dayKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function daysBetween(isoOrTs, now) {
  if (!isoOrTs) return null;
  const t = new Date(isoOrTs).getTime();
  if (isNaN(t)) return null;
  return Math.floor((t - now.getTime()) / (1000 * 60 * 60 * 24));
}

async function aggregateStats(token) {
  const now = new Date();
  const todayKey = dayKey(now);

  // ── 1. Charger tous les users ──
  const usersRaw = await fsListAll('users', token);
  const users = usersRaw.map(u => ({ uid: u.id, ...u.data }));

  // ── 2. Charger tous les users_activity ──
  const activityRaw = await fsListAll('users_activity', token);
  const activityByUid = {};
  for (const a of activityRaw) activityByUid[a.id] = a.data;

  // ── 3. KPI par plan ──
  const byPlan = {};
  for (const u of users) {
    const p = u.plan || 'free';
    byPlan[p] = (byPlan[p] || 0) + 1;
  }

  // ── 4. Inscriptions par jour (30 derniers) ──
  const signupsByDay = {};
  for (let i = 0; i < 30; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    signupsByDay[dayKey(d)] = 0;
  }
  for (const u of users) {
    if (!u.createdAt) continue;
    const k = dayKey(new Date(u.createdAt));
    if (k in signupsByDay) signupsByDay[k]++;
  }

  // ── 5. DAU / WAU / MAU ──
  const today = todayKey;
  const sevenDaysAgo = new Date(now); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const thirtyDaysAgo = new Date(now); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  let dau = 0, wau = 0, mau = 0;
  const dailyActiveByDay = {};
  for (let i = 0; i < 30; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dailyActiveByDay[dayKey(d)] = 0;
  }
  for (const a of Object.values(activityByUid)) {
    const days = a.daysActive || {};
    if (days[today]) dau++;
    let activeIn7 = false, activeIn30 = false;
    for (const k of Object.keys(days)) {
      const dt = new Date(k + 'T12:00:00');
      if (isNaN(dt.getTime())) continue;
      if (dt >= sevenDaysAgo) activeIn7 = true;
      if (dt >= thirtyDaysAgo) activeIn30 = true;
      if (k in dailyActiveByDay) dailyActiveByDay[k]++;
    }
    if (activeIn7) wau++;
    if (activeIn30) mau++;
  }

  // ── 6. Trials qui expirent (J-7 / J-3 / J-1 / J0) ──
  const trialsExpiring = [];
  for (const u of users) {
    if (u.plan !== 'trial' || !u.trialEnd) continue;
    const j = daysBetween(u.trialEnd, now);
    if (j === null) continue;
    if (j >= -1 && j <= 7) {
      trialsExpiring.push({
        uid: u.uid,
        email: u.email || '?',
        name: u.name || '',
        trialEnd: u.trialEnd,
        daysLeft: j,
        pendingPlan: u.pendingPlan || ''
      });
    }
  }
  trialsExpiring.sort((a, b) => a.daysLeft - b.daysLeft);

  // ── 7. Promos OFFRE2MOIS actives ──
  const promosActive = [];
  for (const u of users) {
    if (!u.promoEnd || !u.promoCode) continue;
    const j = daysBetween(u.promoEnd, now);
    if (j === null || j < 0) continue;
    promosActive.push({
      uid: u.uid,
      email: u.email || '?',
      name: u.name || '',
      promoCode: u.promoCode,
      promoEnd: u.promoEnd,
      daysLeft: j,
      plan: u.plan || ''
    });
  }
  promosActive.sort((a, b) => a.daysLeft - b.daysLeft);

  // ── 8. Activité par module (depuis tracking nav.js, 30 derniers jours) ──
  const modulesActivity = {
    pilotage: 0, marges: 0, fidelisation: 0, rh: 0, banque: 0,
    stock: 0, bilan: 0, agent: 0, cashflow: 0
  };
  for (const a of Object.values(activityByUid)) {
    const mu = a.modulesUsed || {};
    for (const m of Object.keys(modulesActivity)) {
      const ts = mu[m];
      if (!ts) continue;
      const dt = new Date(ts);
      if (!isNaN(dt.getTime()) && dt >= thirtyDaysAgo) modulesActivity[m]++;
    }
  }

  // ── 8bis. Présence de données par module (calculable immédiatement, indépendant du tracking) ──
  // Pour chaque user × chaque module, on check si une sous-collection contient au moins 1 doc.
  // → Pour ~32 users × 9 modules = ~288 fetches en parallèle (~1-3s).
  // → Donne une vue "qui a déjà touché ce module ?", complémentaire au tracking 30j.
  const MODULE_PROBES = {
    pilotage:     function (uid) { return `pilotage/${uid}/months`; },
    marges:       function (uid) { return `marges/${uid}/produits`; },
    fidelisation: function (uid) { return `fidelite/${uid}/clients`; },
    rh:           function (uid) { return `rh/${uid}/employes`; },
    banque:       function (uid) { return `bank_connections/${uid}/banks`; },
    stock:        function (uid) { return `stock/${uid}/data`; },
    bilan:        function (uid) { return `bilans/${uid}/years`; },
    agent:        function (uid) { return `agent/${uid}/briefings`; },
    cashflow:     function (uid) { return `cashflow/${uid}/config`; }
  };
  const modulesPresence = {};
  for (const m of Object.keys(MODULE_PROBES)) modulesPresence[m] = 0;

  // Lance toutes les vérifs en parallèle (en aplatissant pour Promise.all)
  const probeJobs = [];
  for (const u of users) {
    for (const [moduleName, pathFn] of Object.entries(MODULE_PROBES)) {
      probeJobs.push({
        moduleName,
        promise: fsListAll(pathFn(u.uid), token, 1).catch(function () { return []; })
      });
    }
  }
  const probeResults = await Promise.all(probeJobs.map(function (j) { return j.promise; }));
  for (let i = 0; i < probeJobs.length; i++) {
    if (probeResults[i] && probeResults[i].length > 0) {
      modulesPresence[probeJobs[i].moduleName]++;
    }
  }

  // ── 9. PAYANTS RÉELS + MRR (uniquement abonnés Stripe actifs, pas les promos) ──
  // Critère "vrai payant" : plan payant + subscriptionStatus actif + stripeSubscriptionId rempli
  // Les master en promo OFFRE2MOIS ont plan='master' mais PAS de stripeSubscriptionId actif
  // → ils sont comptés dans promosActive uniquement, pas dans paying.
  let mrrMonthly = 0, mrrYearly = 0;
  let countMonthly = 0, countYearly = 0;
  let realPaying = 0;
  const realPayingByPlan = { pro: 0, max: 0, master: 0 };
  for (const u of users) {
    const p = u.plan;
    if (!PLAN_PRICING[p]) continue;
    const status = u.subscriptionStatus || '';
    const hasActiveSub = !!u.stripeSubscriptionId && (status === 'active' || status === 'trialing');
    if (!hasActiveSub) continue; // promo ou test ou ancien compte → pas un vrai payant
    realPaying++;
    realPayingByPlan[p] = (realPayingByPlan[p] || 0) + 1;
    // Distinction mensuel/annuel : champ `billing` rempli par le webhook (metadata Stripe)
    // En son absence on considère mensuel (par défaut).
    const billing = (u.billing || u.pendingBilling || '').toLowerCase();
    const isYearly = billing === 'yearly' || billing === 'annual' || billing === 'annuel';
    if (isYearly) {
      mrrYearly += PLAN_PRICING[p].yearly;
      countYearly++;
    } else {
      mrrMonthly += PLAN_PRICING[p].monthly;
      countMonthly++;
    }
  }

  // ── Comptage des master "non-payants" (promos + comptes admin/test/expirés) ──
  // Utile pour qu'Adrien voie clairement la différence avec le donut
  let masterNonPaying = 0;
  for (const u of users) {
    if (u.plan !== 'master') continue;
    const status = u.subscriptionStatus || '';
    const hasActiveSub = !!u.stripeSubscriptionId && (status === 'active' || status === 'trialing');
    if (!hasActiveSub) masterNonPaying++;
  }

  // ── 9bis. Liste détaillée des clients payants (pour la section dédiée) ──
  // On collecte les vrais abonnés Stripe avec leur info de contribution MRR
  const payingCustomers = [];
  for (const u of users) {
    const p = u.plan;
    if (!PLAN_PRICING[p]) continue;
    const status = u.subscriptionStatus || '';
    const hasActiveSub = !!u.stripeSubscriptionId && (status === 'active' || status === 'trialing');
    if (!hasActiveSub) continue;
    const billing = (u.billing || u.pendingBilling || '').toLowerCase();
    const isYearly = billing === 'yearly' || billing === 'annual' || billing === 'annuel';
    const monthlyContribution = isYearly ? PLAN_PRICING[p].yearly : PLAN_PRICING[p].monthly;
    payingCustomers.push({
      uid: u.uid,
      email: u.email || '?',
      name: u.name || '',
      plan: p,
      billing: isYearly ? 'yearly' : 'monthly',
      monthlyContribution: Math.round(monthlyContribution),
      subscriptionStatus: status,
      stripeCustomerId: u.stripeCustomerId || '',
      stripeSubscriptionId: u.stripeSubscriptionId || '',
      createdAt: u.createdAt || '',
      agentEnabled: u.agentEnabled === true
    });
  }
  // Tri : montant décroissant (gros payants en premier)
  payingCustomers.sort(function (a, b) { return b.monthlyContribution - a.monthlyContribution; });

  // ── 10. Tickets support ──
  // Note : pas de collection-group query disponible via REST API + admin token,
  // donc on parcourt par user. Si <= 50 users, on prend tous (pas de sample).
  // Au-delà, on échantillonne 50 pour rester dans le timeout (admin-tickets.html
  // donne le détail complet).
  let openTickets = 0, totalTickets = 0;
  const ticketUsers = users.length <= 50 ? users : users.slice(0, 50);
  const ticketResults = await Promise.all(
    ticketUsers.map(function (u) {
      return fsListAll(`tickets/${u.uid}/list`, token, 50)
        .catch(function (e) {
          console.warn('[admin-stats] tickets fetch failed for uid=' + u.uid + ':', e && e.message);
          return [];
        });
    })
  );
  for (const docs of ticketResults) {
    for (const t of docs) {
      totalTickets++;
      const status = t.data.status || 'open';
      if (status !== 'closed' && status !== 'resolved') openTickets++;
    }
  }

  // ── 11. Parrainage ──
  const referralsRaw = await fsListAll('referrals', token);
  let totalReferralCodes = 0, totalReferralUses = 0, totalReferralRewarded = 0;
  const topParrains = [];
  for (const r of referralsRaw) {
    totalReferralCodes++;
    const uses = parseInt(r.data.totalUses || 0, 10);
    const rewarded = parseInt(r.data.totalRewarded || 0, 10);
    totalReferralUses += uses;
    totalReferralRewarded += rewarded;
    if (rewarded > 0 || uses > 0) {
      topParrains.push({
        code: r.id,
        ownerUid: r.data.ownerUid || '',
        uses,
        rewarded
      });
    }
  }
  topParrains.sort((a, b) => b.rewarded - a.rewarded);

  // ── 12. Résiliations 30 derniers jours ──
  const retentionRaw = await fsListAll('retention_logs', token, 200);
  const retention30d = [];
  for (const r of retentionRaw) {
    const ts = r.data.createdAt || r.data.canceledAt || r.data.timestamp;
    if (!ts) continue;
    const dt = new Date(ts);
    if (isNaN(dt.getTime())) continue;
    if (dt < thirtyDaysAgo) continue;
    retention30d.push({
      id: r.id,
      email: r.data.email || '',
      reason: r.data.reason || r.data.cancelReason || '',
      action: r.data.action || (r.data.acceptedRetention ? 'kept_with_coupon' : 'canceled'),
      createdAt: ts
    });
  }
  retention30d.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // ── 13. Activité récente (derniers inscrits, dernières connexions) ──
  const lastSignups = users
    .filter(u => u.createdAt)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 10)
    .map(u => ({ uid: u.uid, email: u.email || '?', name: u.name || '', plan: u.plan || 'free', createdAt: u.createdAt }));

  const lastLogins = Object.entries(activityByUid)
    .filter(([_, a]) => a.lastLogin)
    .sort((a, b) => new Date(b[1].lastLogin) - new Date(a[1].lastLogin))
    .slice(0, 10)
    .map(([uid, a]) => {
      const u = users.find(x => x.uid === uid) || {};
      return {
        uid,
        email: a.lastEmail || u.email || '?',
        plan: a.plan || u.plan || '',
        lastLogin: a.lastLogin,
        loginCount: a.loginCount || 0,
        lastModule: a.lastModule || ''
      };
    });

  // ── 14. Conversion trial → payant (approx, sur la base des vrais payants) ──
  const totalTrialNow = byPlan.trial || 0;
  const totalTrialExpired = byPlan.trial_expired || 0;
  const trialConversionRate = (realPaying + totalTrialExpired) > 0
    ? Math.round((realPaying / (realPaying + totalTrialExpired)) * 100)
    : 0;

  // ── 14bis. Tracking adoption — combien de users ont au moins 1 connexion enregistrée ──
  // (utile au début quand DAU/WAU/MAU sont à 0 : ça monte dès la 1ère reconnexion)
  let trackedLogins = 0;
  for (const a of Object.values(activityByUid)) {
    if (a.lastLogin || (a.loginCount || 0) > 0) trackedLogins++;
  }

  // ── 15. KPI résumé ──
  const summary = {
    totalUsers: users.length,
    paying: realPaying,             // ⚠️ vrais payants Stripe uniquement (pas les promos)
    payingByPlan: realPayingByPlan, // ex: { pro: 1, max: 0, master: 0 }
    masterNonPaying,                // master en promo / test / sans Stripe
    trial: totalTrialNow,
    promoActive: promosActive.length,
    free: byPlan.free || 0,
    mrrEstimated: Math.round(mrrMonthly + mrrYearly),
    openTickets,
    totalTickets,
    dau, wau, mau,
    trackedLogins,                  // users avec au moins 1 connexion trackée
    trialConversionRate,
    countMonthly, countYearly
  };

  return {
    generatedAt: now.toISOString(),
    summary,
    byPlan,
    signupsByDay,
    dailyActiveByDay,
    payingCustomers,                // ⭐ liste détaillée des vrais clients payants
    trialsExpiring,
    promosActive,
    modulesActivity,    // depuis tracking nav.js (30 derniers jours)
    modulesPresence,    // présence de données dans Firestore (immédiat)
    mrr: {
      monthly: Math.round(mrrMonthly),
      yearly:  Math.round(mrrYearly),
      total:   Math.round(mrrMonthly + mrrYearly),
      countMonthly,
      countYearly
    },
    tickets: {
      open: openTickets,
      total: totalTickets,
      sampledUsers: ticketUsers.length,
      isFullScan: users.length <= 50
    },
    referrals: {
      totalCodes: totalReferralCodes,
      totalUses: totalReferralUses,
      totalRewarded: totalReferralRewarded,
      top: topParrains.slice(0, 10)
    },
    retention: {
      last30Days: retention30d.length,
      logs: retention30d.slice(0, 20)
    },
    lastSignups,
    lastLogins
  };
}

// ══════════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════════

module.exports = async function handler(req, res) {
  // CORS (au cas où, même si servi en same-origin)
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ── 1. Auth : vérifier l'idToken admin ──
    const authHeader = req.headers.authorization || req.headers.Authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (!m) return res.status(401).json({ error: 'Missing Authorization Bearer token' });
    const idToken = m[1].trim();

    const verified = await verifyAdminIdToken(idToken);
    if (!verified) {
      return res.status(403).json({ error: 'Forbidden — admin only (' + ADMIN_EMAIL + ')' });
    }

    // ── 2. Récupérer le token serveur (api@altiora.app) pour lire toutes les collections ──
    const adminToken = await getAdminToken();
    if (!adminToken) return res.status(500).json({ error: 'Could not obtain admin token' });

    // ── 3. Agréger ──
    const stats = await aggregateStats(adminToken);

    return res.status(200).json({ ok: true, stats });
  } catch (e) {
    console.error('[admin-stats] ❌', e);
    return res.status(500).json({ error: 'Erreur serveur : ' + (e.message || 'unknown') });
  }
};

module.exports.config = { maxDuration: 60 };
