// api/conseil-list-invitations.js
// ════════════════════════════════════════════════════════════════════
// ALTEORE CONSEIL — Liste des invitations pending d'un client
// GET (auth via Bearer)
//
// Appelé depuis profil.html pour afficher les invitations envoyées
// mais pas encore acceptées.
//
// Pourquoi un endpoint serveur :
//  - La collection conseil_invitations a une lecture publique (le token
//    est le secret pour accept-invite.html)
//  - On ne veut PAS qu'un client puisse lister TOUTES les invitations
//  - Donc on filtre côté serveur par clientUid via admin token
// ════════════════════════════════════════════════════════════════════

const FIREBASE_PROJECT = 'altiora-70599';

function setCors(req, res) {
  var origin = req.headers.origin || '';
  var allowed = ['https://alteore.com', 'https://www.alteore.com', 'https://conseil.alteore.com', 'http://localhost:3000'];
  res.setHeader('Access-Control-Allow-Origin', allowed.indexOf(origin) !== -1 ? origin : 'https://alteore.com');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function getAdminToken() {
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
  return data.idToken || null;
}

async function fsRunQuery(structuredQuery, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents:runQuery`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify({ structuredQuery })
  });
  if (!res.ok) return [];
  return res.json();
}

function fv(doc, field) {
  const f = doc?.fields?.[field];
  if (!f) return null;
  return f.stringValue ?? f.integerValue ?? f.booleanValue ?? f.timestampValue ?? null;
}

function pathToId(name) {
  if (!name) return null;
  const parts = name.split('/');
  return parts[parts.length - 1];
}

async function verifyToken(idToken) {
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
  try {
    const r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${fbKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      }
    );
    const data = await r.json();
    const u = data.users && data.users[0];
    if (!u) return null;
    return { uid: u.localId, email: u.email };
  } catch (e) { return null; }
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  try {
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!idToken) return res.status(401).json({ error: 'Auth requise' });
    const auth = await verifyToken(idToken);
    if (!auth) return res.status(401).json({ error: 'Token invalide' });

    const adminToken = await getAdminToken();
    if (!adminToken) return res.status(500).json({ error: 'Config serveur manquante' });

    // Query : conseil_invitations where clientUid == auth.uid AND status == 'pending'
    const queryResults = await fsRunQuery({
      from: [{ collectionId: 'conseil_invitations' }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: 'clientUid' },
                op: 'EQUAL',
                value: { stringValue: auth.uid }
              }
            },
            {
              fieldFilter: {
                field: { fieldPath: 'status' },
                op: 'EQUAL',
                value: { stringValue: 'pending' }
              }
            }
          ]
        }
      },
      limit: 50
    }, adminToken);

    const now = new Date();
    const invitations = [];

    for (const result of (queryResults || [])) {
      if (!result.document) continue;
      const doc = result.document;
      const token = pathToId(doc.name);
      const conseillerEmail = fv(doc, 'conseillerEmail');
      const conseillerName  = fv(doc, 'conseillerName');
      const duration        = fv(doc, 'duration');
      const inviteExpiresAt = fv(doc, 'inviteExpiresAt');
      const createdAt       = fv(doc, 'createdAt');

      // Filtrer côté serveur les invitations expirées (en complément de la query)
      if (inviteExpiresAt) {
        const exp = new Date(inviteExpiresAt);
        if (!isNaN(exp.getTime()) && exp < now) continue;
      }

      invitations.push({
        token: token,
        conseillerEmail: conseillerEmail,
        conseillerName: conseillerName,
        duration: duration,
        inviteExpiresAt: inviteExpiresAt,
        createdAt: createdAt
      });
    }

    return res.status(200).json({
      ok: true,
      invitations: invitations,
      total: invitations.length
    });

  } catch (err) {
    console.error('[conseil-list-invitations]', err);
    return res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
};
