// api/cron-agent-memory-refresh.js
//
// ═══════════════════════════════════════════════════════════════════════════
// CRON HEBDO — Régénération des résumés business (Wave 3)
// ═══════════════════════════════════════════════════════════════════════════
//
// Exécution : chaque lundi 3h UTC (= 4h ou 5h Paris selon DST)
// Configuré dans vercel.json : "schedule": "0 3 * * 1"
//
// Scanne tous les users avec accès Léa (agentEnabled OR plan=trial OR
// role=admin OR betaTester) et appelle /api/agent-memory-refresh pour chacun.
//
// Sécurité :
//   - Appel entrant : vérifie Authorization = Bearer CRON_SECRET (Vercel le
//     passe automatiquement pour les crons)
//   - Appels sortants vers /api/agent-memory-refresh avec le même secret
//
// Performance :
//   - Par batch de 5 users en parallèle (évite de saturer l'API Anthropic)
//   - maxDuration 300s → peut traiter ~100-150 users en une exécution
//   - Au-delà, il faudrait paginer (Wave 9+)
//
// Coût estimé : ~0.15€ par user actif par semaine.
//   - 10 clients × 0.15€ × 4 sem = 6€/mois
//   - 100 clients × 0.15€ × 4 sem = 60€/mois
// ═══════════════════════════════════════════════════════════════════════════

const FIREBASE_PROJECT = 'altiora-70599';
const BATCH_SIZE = 5;

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

async function listAllEligibleUsers() {
  // On lit toute la collection users via runQuery (pas de filtre côté Firestore
  // car plusieurs champs à OR logique → plus simple de filtrer côté JS).
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
  const token = await getAdminToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const users = [];
  let pageToken = null;
  let iter = 0;
  // On pagine au cas où (listDocuments supporte pageToken)
  do {
    iter++;
    if (iter > 20) break; // safety
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/users?pageSize=300` + (pageToken ? `&pageToken=${pageToken}` : '') + (token ? '' : '&key=' + fbKey);
    const res = await fetch(url, { headers });
    if (!res.ok) break;
    const data = await res.json();
    const docs = data.documents || [];
    for (const d of docs) {
      const fields = d.fields || {};
      const uid = (d.name || '').split('/').pop();
      const plan       = fields.plan?.stringValue || null;
      const agentOK    = fields.agentEnabled?.booleanValue === true;
      const betaTester = fields.betaTester?.booleanValue === true;
      const role       = fields.role?.stringValue || null;
      const eligible = agentOK || plan === 'trial' || role === 'admin' || betaTester;
      if (eligible) users.push({ uid, plan, role, agentEnabled: agentOK, betaTester });
    }
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return users;
}

async function refreshOne(uid, appUrl, cronSecret) {
  try {
    const resp = await fetch(`${appUrl}/api/agent-memory-refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cronSecret}`,
      },
      body: JSON.stringify({ uid, trigger: 'cron-weekly' }),
    });
    const result = await resp.json();
    if (!resp.ok) {
      console.warn(`[cron-memory-refresh] uid=${uid} FAILED:`, result.error);
      return { uid, ok: false, error: result.error };
    }
    return { uid, ok: true, version: result.version };
  } catch (e) {
    console.warn(`[cron-memory-refresh] uid=${uid} EXCEPTION:`, e.message);
    return { uid, ok: false, error: e.message };
  }
}

module.exports = async (req, res) => {
  // Vercel Cron → Authorization: Bearer <CRON_SECRET> (config auto Vercel)
  const authHeader = req.headers['authorization'] || '';
  const providedSecret = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const cronSecret = process.env.CRON_SECRET || 'internal';
  if (providedSecret !== cronSecret) {
    return res.status(401).json({ error: 'Non autorisé (CRON_SECRET requis)' });
  }

  const startTime = Date.now();
  console.log('[cron-memory-refresh] Démarrage scan users éligibles...');

  try {
    const users = await listAllEligibleUsers();
    console.log(`[cron-memory-refresh] ${users.length} user(s) éligible(s) trouvé(s)`);

    const appUrl = process.env.APP_URL || 'https://alteore.com';
    const results = [];

    // Traitement par batch pour éviter de saturer Anthropic
    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(u => refreshOne(u.uid, appUrl, cronSecret))
      );
      results.push(...batchResults);
    }

    const ok = results.filter(r => r.ok).length;
    const ko = results.filter(r => !r.ok).length;
    const durationS = Math.round((Date.now() - startTime) / 1000);

    console.log(`[cron-memory-refresh] ✅ ${ok} OK, ❌ ${ko} KO, durée ${durationS}s`);

    return res.status(200).json({
      success: true,
      users_eligibles: users.length,
      ok, ko,
      durationSeconds: durationS,
      failures: results.filter(r => !r.ok).slice(0, 20), // échantillon
    });

  } catch (e) {
    console.error('[cron-memory-refresh] Fatal:', e);
    return res.status(500).json({ error: e.message });
  }
};
