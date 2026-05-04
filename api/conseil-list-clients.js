// api/conseil-list-clients.js
// ════════════════════════════════════════════════════════════════════
// ALTEORE CONSEIL — Liste des clients d'un conseiller
// GET (auth via Bearer token)
//
// Appelé depuis conseil/dashboard.html pour afficher la liste des
// comptes auxquels le conseiller a accès.
//
// Retourne aussi le statut "expiré" calculé côté serveur, pour ne pas
// afficher des accès qui n'existent plus.
// ════════════════════════════════════════════════════════════════════

const FIREBASE_PROJECT = 'altiora-70599';

function setCors(req, res) {
  var origin = req.headers.origin || '';
  var allowed = ['https://alteore.com', 'https://www.alteore.com', 'https://conseil.alteore.com', 'http://localhost:3000'];
  res.setHeader('Access-Control-Allow-Origin', allowed.indexOf(origin) !== -1 ? origin : 'https://alteore.com');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
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

async function fsList(collectionPath, token) {
  const all = [];
  let pageToken = '';
  do {
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${collectionPath}?pageSize=100${pageToken ? '&pageToken=' + pageToken : ''}`;
    const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!res.ok) break;
    const data = await res.json();
    if (data.documents) all.push(...data.documents);
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return all;
}

async function fsGet(path, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`;
  const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
  if (!res.ok) return null;
  return res.json();
}

function fv(doc, field) {
  const f = doc?.fields?.[field];
  if (!f) return null;
  return f.stringValue ?? f.integerValue ?? f.booleanValue ?? f.timestampValue ?? null;
}

function pathToId(name) {
  // documents/conseillers/UID/clients/CLIENT_UID  →  CLIENT_UID
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

    // Vérifier que c'est bien un conseiller
    const conseillerDoc = await fsGet(`conseillers/${auth.uid}`, adminToken);
    if (!conseillerDoc) {
      return res.status(403).json({ error: 'Compte conseiller introuvable' });
    }

    // Lister les clients via l'index inverse
    const clientsRaw = await fsList(`conseillers/${auth.uid}/clients`, adminToken);
    const now = new Date();

    const clients = [];
    for (const cd of clientsRaw) {
      const clientUid    = pathToId(cd.name);
      if (!clientUid) continue;
      const clientName   = fv(cd, 'clientName')  || 'Client';
      const clientEmail  = fv(cd, 'clientEmail') || '';
      const duration     = fv(cd, 'duration')    || '30d';
      const expiresAt    = fv(cd, 'expiresAt');

      // Vérifier le statut réel via le grant (source de vérité)
      const grantDoc = await fsGet(`client_access/${clientUid}/grants/${auth.uid}`, adminToken);
      let status = 'unknown';
      let lastAccessAt = null;
      let firstAccessAt = null;
      if (grantDoc) {
        status = fv(grantDoc, 'status') || 'unknown';
        lastAccessAt  = fv(grantDoc, 'lastAccessAt');
        firstAccessAt = fv(grantDoc, 'firstAccessAt');
        // Recalcul d'expiration côté serveur
        const grantExp = fv(grantDoc, 'expiresAt');
        if (status === 'active' && grantExp) {
          const expDate = new Date(grantExp);
          if (!isNaN(expDate.getTime()) && expDate < now) {
            status = 'expired';
          }
        }
      }

      // On filtre les accès non actifs sauf si on veut les afficher pour info
      if (status !== 'active') continue;

      // Récupérer le plan client (utile pour info au conseiller)
      const userDoc = await fsGet(`users/${clientUid}`, adminToken);
      const plan = userDoc ? (fv(userDoc, 'plan') || 'free') : 'free';

      // Récupérer le nom d'entreprise depuis profil
      let companyName = clientName;
      try {
        const profilDoc = await fsGet(`profil/${clientUid}/data/profil`, adminToken);
        if (profilDoc) {
          const cn = fv(profilDoc, 'nomEntreprise') || fv(profilDoc, 'enseigne');
          if (cn) companyName = cn;
        }
      } catch (e) {}

      clients.push({
        clientUid: clientUid,
        clientName: companyName,
        clientEmail: clientEmail,
        duration: duration,
        expiresAt: expiresAt,
        plan: plan,
        firstAccessAt: firstAccessAt,
        lastAccessAt: lastAccessAt,
        status: status
      });
    }

    return res.status(200).json({
      ok: true,
      conseiller: {
        uid: auth.uid,
        email: auth.email,
        displayName: fv(conseillerDoc, 'displayName') || '',
        cabinet:     fv(conseillerDoc, 'cabinet')     || '',
        type:        fv(conseillerDoc, 'type')        || 'autre'
      },
      clients: clients,
      total: clients.length
    });

  } catch (err) {
    console.error('[conseil-list-clients]', err);
    return res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
};
