// api/get-my-tickets.js — Retourne les tickets du client connecté
// Authentification : le client envoie son idToken Firebase → on vérifie l'uid
// et on query Firestore avec le token admin pour récupérer ses tickets.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ── 1. Vérifier le token Firebase du client ──
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'Non authentifié' });

    const verifyRes = await fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + process.env.FIREBASE_API_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      }
    );
    const verifyData = await verifyRes.json();
    const uid = verifyData.users && verifyData.users[0] && verifyData.users[0].localId;
    if (!uid) return res.status(401).json({ error: 'Token invalide' });

    // ── 2. Login admin pour lire Firestore ──
    const authRes = await fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + process.env.FIREBASE_API_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: process.env.FIREBASE_API_EMAIL,
          password: process.env.FIREBASE_API_PASSWORD,
          returnSecureToken: true
        })
      }
    );
    const authData = await authRes.json();
    if (!authData.idToken) return res.status(500).json({ error: 'Erreur auth admin' });
    const adminToken = authData.idToken;

    const projectId = process.env.FIREBASE_PROJECT_ID || 'altiora-70599';

    // ── 3. Query Firestore : tickets où uid == clientUid ──
    const queryUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
    const queryBody = {
      structuredQuery: {
        from: [{ collectionId: 'tickets' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'uid' },
            op: 'EQUAL',
            value: { stringValue: uid }
          }
        },
        orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }],
        limit: 20
      }
    };

    const queryRes = await fetch(queryUrl, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + adminToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(queryBody)
    });
    const queryData = await queryRes.json();

    // ── 4. Formater les tickets pour le client ──
    const tickets = [];
    for (const row of queryData) {
      if (!row.document) continue;
      const f = row.document.fields || {};
      const getString = (k) => (f[k] && f[k].stringValue) || '';
      const getBool   = (k) => !!(f[k] && f[k].booleanValue);
      const getArr    = (k) => (f[k] && f[k].arrayValue && f[k].arrayValue.values) || [];

      // Décoder replies[]
      const repliesRaw = getArr('replies');
      const replies = repliesRaw.map(function(rv) {
        const rf = (rv.mapValue && rv.mapValue.fields) || {};
        const getRS = (k) => (rf[k] && rf[k].stringValue) || '';
        return {
          text:   getRS('text'),
          sentAt: getRS('sentAt'),
          from:   getRS('from')
        };
      });

      tickets.push({
        ticketId:    getString('ticketId'),
        sujet:       getString('sujet'),
        description: getString('description'),
        status:      getString('status'),
        createdAt:   getString('createdAt'),
        updatedAt:   getString('updatedAt'),
        clientRead:  getBool('clientRead'),
        replies
      });
    }

    return res.status(200).json({ success: true, tickets });
  } catch (error) {
    console.error('[get-my-tickets] fatal:', error);
    return res.status(500).json({ error: 'Erreur serveur', detail: error.message });
  }
}
