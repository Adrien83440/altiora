// api/cron-briefing-daily.js
// ══════════════════════════════════════════════════════════════════
// WAVE 4.3 — Cron quotidien : briefing matinal pour tous les users Léa
//
// Appelé chaque jour à 6h UTC (= 8h Paris heure d'été, 7h Paris hiver)
// par Vercel Cron.
//
// Pour chaque user éligible :
//   1. Appelle /api/generate-briefing avec send:true
//   2. → génère le briefing + envoie l'email en chaîne
//   3. Log succès/erreur par user
//
// User éligible = users où au moins l'un des suivants est vrai :
//   - agentEnabled === true (addon Léa payé)
//   - plan === 'trial' (essai 15 jours)
//   - role === 'admin' (toi)
//   - betaTester === true (beta testeurs)
//
// Pour ne PAS inclure un user :
//   - user.briefings_enabled === false (opt-out explicite)
//   - profile/main.channels.email === false (canal email coupé)
//     → ce second filtre est appliqué par send-briefing lui-même
//
// Rate limit : on traite les users par batch de 3 en parallèle
// pour ne pas exploser la lambda (max 300s sur Vercel Pro).
//
// Sécurité :
//   - Vercel envoie Authorization: Bearer <CRON_SECRET> (config côté dashboard)
//   - On accepte aussi ?secret=<CRON_SECRET> en query string pour tests manuels
// ══════════════════════════════════════════════════════════════════

const FIREBASE_PROJECT = 'altiora-70599';
const FB_KEY = 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

const BATCH_SIZE = 3;              // users traités en parallèle
const PER_USER_TIMEOUT_MS = 45000; // timeout par user
const MAX_USERS_PER_RUN = 500;     // hard cap pour éviter runaway

// ══════════════════════════════════════════════════════════════════
// AUTH HELPERS
// ══════════════════════════════════════════════════════════════════

let _adminToken = null;
let _adminTokenExp = 0;

async function getAdminToken() {
  if (_adminToken && Date.now() < _adminTokenExp - 300000) return _adminToken;
  const fbKey = process.env.FIREBASE_API_KEY || FB_KEY;
  const email = process.env.FIREBASE_API_EMAIL;
  const password = process.env.FIREBASE_API_PASSWORD;
  if (!email || !password) {
    console.error('[cron-briefing] Credentials admin manquants');
    return null;
  }
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${fbKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) }
  );
  const data = await r.json();
  if (data.idToken) {
    _adminToken = data.idToken;
    _adminTokenExp = Date.now() + (parseInt(data.expiresIn || '3600') * 1000);
    return _adminToken;
  }
  console.error('[cron-briefing] Admin login failed:', data.error?.message);
  return null;
}

function authHeaders(token) {
  return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
}

// ══════════════════════════════════════════════════════════════════
// LISTER LES USERS ÉLIGIBLES
// ══════════════════════════════════════════════════════════════════

// On fait 3 requêtes Firestore pour les 3 critères (agentEnabled, plan=trial, betaTester),
// puis on déduplique. Firestore REST ne supporte pas les OR directs.
async function listEligibleUsers(token) {
  const uids = new Set();
  const userData = {};

  async function runQueryFlat(fieldFilter) {
    const url = `${FS_BASE}:runQuery`;
    const body = {
      structuredQuery: {
        from: [{ collectionId: 'users' }],
        where: { fieldFilter },
        limit: MAX_USERS_PER_RUN,
      },
    };
    const res = await fetch(url, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) });
    const results = await res.json();
    if (!Array.isArray(results)) return [];
    return results.filter(r => r.document).map(r => {
      const name = r.document.name;
      const uid = name.split('/').pop();
      const fields = r.document.fields || {};
      const data = {};
      for (const [k, v] of Object.entries(fields)) {
        if ('stringValue' in v) data[k] = v.stringValue;
        else if ('booleanValue' in v) data[k] = v.booleanValue;
        else if ('integerValue' in v) data[k] = parseInt(v.integerValue);
        else if ('doubleValue' in v) data[k] = v.doubleValue;
        else if ('timestampValue' in v) data[k] = v.timestampValue;
        else data[k] = null;
      }
      return { uid, data };
    });
  }

  // 1. users avec agentEnabled === true
  try {
    const r1 = await runQueryFlat({
      field: { fieldPath: 'agentEnabled' },
      op: 'EQUAL',
      value: { booleanValue: true },
    });
    for (const u of r1) { uids.add(u.uid); userData[u.uid] = u.data; }
    console.log(`[cron-briefing] ${r1.length} users avec agentEnabled=true`);
  } catch (e) { console.warn('[cron-briefing] query agentEnabled failed:', e.message); }

  // 2. users avec plan === 'trial'
  try {
    const r2 = await runQueryFlat({
      field: { fieldPath: 'plan' },
      op: 'EQUAL',
      value: { stringValue: 'trial' },
    });
    for (const u of r2) { uids.add(u.uid); userData[u.uid] = u.data; }
    console.log(`[cron-briefing] ${r2.length} users avec plan=trial`);
  } catch (e) { console.warn('[cron-briefing] query plan=trial failed:', e.message); }

  // 3. users avec betaTester === true
  try {
    const r3 = await runQueryFlat({
      field: { fieldPath: 'betaTester' },
      op: 'EQUAL',
      value: { booleanValue: true },
    });
    for (const u of r3) { uids.add(u.uid); userData[u.uid] = u.data; }
    console.log(`[cron-briefing] ${r3.length} users avec betaTester=true`);
  } catch (e) { console.warn('[cron-briefing] query betaTester failed:', e.message); }

  // 4. users avec role === 'admin' (toi)
  try {
    const r4 = await runQueryFlat({
      field: { fieldPath: 'role' },
      op: 'EQUAL',
      value: { stringValue: 'admin' },
    });
    for (const u of r4) { uids.add(u.uid); userData[u.uid] = u.data; }
    console.log(`[cron-briefing] ${r4.length} users avec role=admin`);
  } catch (e) { console.warn('[cron-briefing] query role=admin failed:', e.message); }

  // Filtrer les opt-out (briefings_enabled === false)
  const eligible = [];
  for (const uid of uids) {
    const d = userData[uid] || {};
    if (d.briefings_enabled === false) {
      console.log(`[cron-briefing] skip ${uid} — briefings_enabled=false`);
      continue;
    }
    // Skip si pas d'email
    if (!d.email) {
      console.log(`[cron-briefing] skip ${uid} — pas d'email`);
      continue;
    }
    eligible.push({ uid, email: d.email, name: d.name });
  }

  return eligible;
}

// ══════════════════════════════════════════════════════════════════
// DÉCLENCHE UN BRIEFING POUR UN USER (appel interne à generate-briefing)
// ══════════════════════════════════════════════════════════════════

async function runBriefingForUser(uid, email) {
  const cronSecret = process.env.CRON_SECRET;
  const baseUrl = process.env.APP_URL || 'https://alteore.com';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PER_USER_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/api/generate-briefing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cron-secret': cronSecret || '',
      },
      body: JSON.stringify({ uid, send: true }),
      signal: controller.signal,
    });
    const data = await res.json();
    clearTimeout(timeoutId);

    if (res.ok) {
      return {
        uid, email,
        ok: true,
        score: data.score,
        nombre_alertes: data.nombre_alertes,
        sent: data.send?.sent || false,
        skipped_reason: data.send?.skipped_reason || null,
      };
    } else {
      return { uid, email, ok: false, error: data.error || 'unknown' };
    }
  } catch (e) {
    clearTimeout(timeoutId);
    return { uid, email, ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

// Traite les users par batches de BATCH_SIZE en parallèle
async function processInBatches(users) {
  const results = [];
  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    const batch = users.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(u => runBriefingForUser(u.uid, u.email))
    );
    results.push(...batchResults);
    // Log de progression
    console.log(`[cron-briefing] progress ${Math.min(i + BATCH_SIZE, users.length)}/${users.length}`);
  }
  return results;
}

// ══════════════════════════════════════════════════════════════════
// HANDLER HTTP
// ══════════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  // Auth : soit Authorization Bearer (Vercel Cron l'envoie auto), soit ?secret=
  const authHeader = req.headers.authorization || '';
  const bearerSecret = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const querySecret = req.query?.secret || '';
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret) {
    console.error('[cron-briefing] CRON_SECRET non configuré');
    return res.status(500).json({ error: 'CRON_SECRET missing' });
  }

  if (bearerSecret !== expectedSecret && querySecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startTs = Date.now();
  console.log('[cron-briefing] 🚀 Démarrage');

  try {
    const adminToken = await getAdminToken();
    if (!adminToken) return res.status(500).json({ error: 'Admin token indisponible' });

    const users = await listEligibleUsers(adminToken);
    console.log(`[cron-briefing] ${users.length} users éligibles au total`);

    if (users.length === 0) {
      return res.status(200).json({ ok: true, nb_eligibles: 0, duration_ms: Date.now() - startTs });
    }

    // Garde hard : max MAX_USERS_PER_RUN
    const toProcess = users.slice(0, MAX_USERS_PER_RUN);
    if (users.length > MAX_USERS_PER_RUN) {
      console.warn(`[cron-briefing] ⚠️ ${users.length} users détectés, cap à ${MAX_USERS_PER_RUN}`);
    }

    const results = await processInBatches(toProcess);

    const success = results.filter(r => r.ok).length;
    const sent = results.filter(r => r.ok && r.sent).length;
    const skipped = results.filter(r => r.ok && !r.sent).length;
    const failed = results.filter(r => !r.ok).length;

    console.log(`[cron-briefing] ✅ Terminé : ${success}/${results.length} OK (${sent} envoyés, ${skipped} skipped), ${failed} échecs`);
    if (failed > 0) {
      const erreurs = results.filter(r => !r.ok).slice(0, 10);
      console.warn('[cron-briefing] Échecs :', JSON.stringify(erreurs));
    }

    return res.status(200).json({
      ok: true,
      duration_ms: Date.now() - startTs,
      nb_eligibles: users.length,
      nb_traites: results.length,
      nb_success: success,
      nb_envoyes: sent,
      nb_skipped: skipped,
      nb_failed: failed,
      failed_samples: results.filter(r => !r.ok).slice(0, 5),
    });
  } catch (e) {
    console.error('[cron-briefing] ❌ erreur fatale:', e.message);
    return res.status(500).json({ error: e.message, duration_ms: Date.now() - startTs });
  }
};
