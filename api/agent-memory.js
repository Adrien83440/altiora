// api/agent-memory.js
//
// ═══════════════════════════════════════════════════════════════════════════
// MÉMOIRE LONG TERME LÉA — Endpoint CRUD (Wave 3)
// ═══════════════════════════════════════════════════════════════════════════
//
// Permet à l'UI (agent.html section "🧠 Mémoire") de :
//   - GET  /api/agent-memory → lire tout (résumé business + faits + préférences)
//   - POST /api/agent-memory { action: 'delete_fact', factId: '...' }
//   - POST /api/agent-memory { action: 'delete_preference', prefType: '...' }
//   - POST /api/agent-memory { action: 'refresh_summary' } → déclenche régénération manuelle
//
// Sécurité :
//   - Auth Firebase obligatoire
//   - Toutes les opérations scopées sur l'uid du token (pas cross-user)
//   - refresh_summary rate-limité à 1 fois par heure (éviter abuse coûteux)
// ═══════════════════════════════════════════════════════════════════════════

const FIREBASE_PROJECT = 'altiora-70599';
const REFRESH_COOLDOWN_MS = 60 * 60 * 1000; // 1h entre 2 régénérations manuelles

// ── Auth helpers (copiés du pattern standard) ──
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

async function fsDelete(path) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: await _fsHeaders(),
  });
  if (!res.ok && res.status !== 404) throw new Error('fsDelete failed: ' + await res.text());
  return true;
}

// ── Lecture avec le idToken de l'utilisateur (pour son propre user doc) ──
// Les règles Firestore users/{uid} n'autorisent que le propriétaire (isOwner),
// pas le compte serveur. On doit utiliser le token de l'utilisateur lui-même.
async function fsGetAsUser(path, userIdToken) {
  if (!userIdToken) return null;
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`;
  try {
    const res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + userIdToken }
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return res.json();
  } catch (e) {
    return null;
  }
}

function fvRaw(f) {
  if (!f) return null;
  if (f.stringValue !== undefined)    return f.stringValue;
  if (f.integerValue !== undefined)   return parseInt(f.integerValue);
  if (f.doubleValue !== undefined)    return parseFloat(f.doubleValue);
  if (f.booleanValue !== undefined)   return f.booleanValue;
  if (f.timestampValue !== undefined) return f.timestampValue;
  if (f.nullValue !== undefined)      return null;
  return null;
}

function fv(doc, field) { return fvRaw(doc?.fields?.[field]); }

// Validation : un factId ne doit contenir que des caractères alphanumériques + tirets
function validateDocId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
}

// ═══════════════════════════════════════════════════════════════════════════
// Handler
// ═══════════════════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth
  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ error: 'Authentification requise' });
  const verified = await verifyFirebaseToken(idToken);
  if (!verified) return res.status(401).json({ error: 'Token invalide' });
  const { uid } = verified;

  try {
    // Access check : admin / beta / trial / agentEnabled
    // IMPORTANT : on lit users/{uid} avec le idToken utilisateur, pas le token admin,
    // car les règles Firestore n'autorisent que le propriétaire (isOwner).
    const userDoc = await fsGetAsUser(`users/${uid}`, idToken);
    if (!userDoc) return res.status(400).json({ error: 'Utilisateur introuvable' });
    const role       = fv(userDoc, 'role');
    const plan       = fv(userDoc, 'plan');
    const agentOK    = fv(userDoc, 'agentEnabled') === true;
    const betaTester = fv(userDoc, 'betaTester') === true;
    const hasAccess = role === 'admin' || betaTester || agentOK || plan === 'trial' || plan === 'dev';
    if (!hasAccess) return res.status(403).json({ error: 'Accès refusé' });

    // ── GET : lire toute la mémoire ──
    if (req.method === 'GET') {
      // Parallélisation des 3 lectures (summary + facts + preferences)
      // Auparavant séquentiel → risque de timeout 504 avec maxDuration 15s
      const [summaryDoc, factsRes, prefsRes] = await Promise.all([
        fsGet(`agent/${uid}/memory/business-summary`),
        fsList(`agent/${uid}/memory-facts`, 100),
        fsList(`agent/${uid}/memory-preferences`, 20),
      ]);

      // Résumé business
      const summary = summaryDoc ? {
        text: fv(summaryDoc, 'text') || '',
        generatedAt: fv(summaryDoc, 'generatedAt') || null,
        version: parseInt(fv(summaryDoc, 'version') || 0),
        lastRefreshAttempt: fv(summaryDoc, 'lastRefreshAttempt') || null,
      } : null;

      // Faits
      const facts = (factsRes?.documents || [])
        .map(d => ({
          id: (d.name || '').split('/').pop(),
          fait: fv(d, 'fait') || '',
          categorie: fv(d, 'categorie') || 'autre',
          createdAt: fv(d, 'createdAt') || '',
          source: fv(d, 'source') || 'conversation',
        }))
        .filter(f => f.fait)
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

      // Préférences
      const preferences = (prefsRes?.documents || [])
        .map(d => ({
          type: (d.name || '').split('/').pop(),
          preference: fv(d, 'preference') || '',
          updatedAt: fv(d, 'updatedAt') || '',
        }))
        .filter(p => p.preference);

      return res.status(200).json({ summary, facts, preferences });
    }

    // ── POST : actions (delete_fact, delete_preference, refresh_summary) ──
    if (req.method === 'POST') {
      const { action } = req.body || {};

      if (action === 'delete_fact') {
        const factId = req.body.factId;
        if (!validateDocId(factId)) return res.status(400).json({ error: 'factId invalide' });
        await fsDelete(`agent/${uid}/memory-facts/${factId}`);
        return res.status(200).json({ success: true });
      }

      if (action === 'delete_preference') {
        const prefType = req.body.prefType;
        if (!validateDocId(prefType)) return res.status(400).json({ error: 'prefType invalide' });
        await fsDelete(`agent/${uid}/memory-preferences/${prefType}`);
        return res.status(200).json({ success: true });
      }

      if (action === 'refresh_summary') {
        // Rate limit 1h
        const summaryDoc = await fsGet(`agent/${uid}/memory/business-summary`);
        const lastAttempt = fv(summaryDoc, 'lastRefreshAttempt');
        if (lastAttempt) {
          const elapsed = Date.now() - new Date(lastAttempt).getTime();
          if (elapsed < REFRESH_COOLDOWN_MS) {
            const waitMin = Math.ceil((REFRESH_COOLDOWN_MS - elapsed) / 60000);
            return res.status(429).json({
              error: `Tu dois attendre encore ${waitMin} minute(s) avant de relancer une régénération.`,
              code: 'RATE_LIMIT',
            });
          }
        }

        // Déclencher la régénération en "fire-and-forget" : on n'attend PAS la réponse
        // car agent-memory-refresh prend 20-40s et agent-memory timeout à 15s.
        // L'UI informera l'utilisateur de revenir dans ~1 min pour voir le nouveau résumé.
        const appUrl = process.env.APP_URL || 'https://alteore.com';
        const internalSecret = process.env.CRON_SECRET || 'internal';

        // On déclenche sans await → Node continue et répond 202 immédiatement.
        // On ajoute un .catch() pour éviter les unhandled rejection dans les logs Vercel.
        fetch(`${appUrl}/api/agent-memory-refresh`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${internalSecret}`,
          },
          body: JSON.stringify({ uid, trigger: 'manual' }),
        }).catch(e => console.warn('[agent-memory] fire-and-forget refresh failed:', e.message));

        return res.status(202).json({
          success: true,
          queued: true,
          message: "Régénération lancée. Reviens dans ~1 minute pour voir le nouveau résumé.",
        });
      }

      return res.status(400).json({ error: 'Action inconnue. Valeurs acceptées : delete_fact, delete_preference, refresh_summary' });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });

  } catch (e) {
    console.error('[agent-memory] Exception:', e);
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
};
