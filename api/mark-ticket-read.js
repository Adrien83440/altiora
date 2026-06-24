// api/mark-ticket-read.js — Marque clientRead=true sur un ticket
// Appelé par aide.html quand le client ouvre un ticket avec une nouvelle réponse.
// Sécurité : l'uid du client est vérifié contre le champ uid du ticket.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ── 1. Vérifier le token client ──
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
    const callerUid = verifyData.users && verifyData.users[0] && verifyData.users[0].localId;
    if (!callerUid) return res.status(401).json({ error: 'Token invalide' });

    const { ticketId } = req.body || {};
    if (!ticketId) return res.status(400).json({ error: 'ticketId manquant' });

    // ── 2. Login admin ──
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

    // ── 3. Vérifier que le ticket appartient bien au client ──
    const getUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/tickets/${ticketId}`;
    const getRes = await fetch(getUrl, { headers: { Authorization: 'Bearer ' + adminToken } });
    const ticketData = await getRes.json();
    const ticketUid = ticketData.fields && ticketData.fields.uid && ticketData.fields.uid.stringValue;
    if (ticketUid !== callerUid) return res.status(403).json({ error: 'Accès refusé' });

    // ── 4. PATCH clientRead=true ──
    const patchUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/tickets/${ticketId}?updateMask.fieldPaths=clientRead`;
    await fetch(patchUrl, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + adminToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { clientRead: { booleanValue: true } } })
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[mark-ticket-read] fatal:', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
