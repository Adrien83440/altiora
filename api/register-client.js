// api/register-client.js
// Inscription autonome : le client s'inscrit sans auth
// L'API vérifie que le commerçant a un plan fid valide avant d'écrire

async function firestoreGet(path) {
  const projectId = process.env.FIREBASE_PROJECT_ID || 'alteore-dev';
  const apiKey = process.env.FIREBASE_API_KEY || 'AIzaSyA2jBMDhmMwd5KROvutxhsmM4SMOEqdLF4';
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}?key=${apiKey}`
  );
  return res.json();
}

async function firestoreSet(path, fields, token) {
  const projectId = process.env.FIREBASE_PROJECT_ID || 'alteore-dev';
  const firestoreFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'number') firestoreFields[k] = { integerValue: String(v) };
    else if (typeof v === 'boolean') firestoreFields[k] = { booleanValue: v };
    else if (Array.isArray(v)) firestoreFields[k] = { arrayValue: { values: v.map(i => ({ stringValue: String(i) })) } };
    else firestoreFields[k] = { stringValue: String(v) };
  }

  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const fieldPaths = Object.keys(firestoreFields).map(k => 'updateMask.fieldPaths=' + k).join('&');
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}?${fieldPaths}`,
    { method: 'PATCH', headers, body: JSON.stringify({ fields: firestoreFields }) }
  );
  return res.json();
}

async function getFirebaseToken() {
  const email = process.env.FIREBASE_API_EMAIL;
  const password = process.env.FIREBASE_API_PASSWORD;
  const apiKey = process.env.FIREBASE_API_KEY || 'AIzaSyA2jBMDhmMwd5KROvutxhsmM4SMOEqdLF4';
  if (!email || !password) return null;
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }) }
    );
    const d = await res.json();
    return d.idToken || null;
  } catch { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { merchantUid, prenom, nom, tel, email, birthday, clientId } = req.body || {};

  if (!merchantUid || !prenom || !nom || !tel || !clientId) {
    return res.status(400).json({ error: 'Champs manquants (merchantUid, prenom, nom, tel, clientId)' });
  }

  try {
    // 1. Vérifier que le commerçant a un plan fid (max/master/trial)
    const cfgSnap = await firestoreGet(`fidelite_public_cfg/${merchantUid}`);
    if (!cfgSnap.fields) {
      return res.status(403).json({ error: 'Programme fidélité introuvable pour ce commerçant' });
    }

    // Vérifier le plan via users/{merchantUid}
    const userSnap = await firestoreGet(`users/${merchantUid}`);
    const plan = userSnap.fields?.plan?.stringValue || '';
    const validPlans = ['max', 'master', 'trial'];
    if (!validPlans.includes(plan)) {
      return res.status(403).json({ error: 'Ce commerçant n\'a pas accès au module fidélité' });
    }

    // 2. Vérifier si le client existe déjà (même numéro)
    const telNorm = tel.replace(/[\s\-\.]/g, '');
    const existSnap = await firestoreGet(`fidelite/${merchantUid}/clients/${clientId}`);
    // Cherche par tel n'est pas possible via REST sans index, on laisse passer

    // 3. Obtenir token pour écrire
    const token = await getFirebaseToken();

    const today = new Date().toISOString().split('T')[0];
    const clientData = {
      id: clientId, prenom, nom,
      tel: telNorm, email: email || '',
      birthday: birthday || '',
      points: 0, tampons: 0,
      lastVisit: today, createdAt: today,
      source: 'inscription-autonome',
      uid: merchantUid
    };

    // Écrire dans fidelite/{merchantUid}/clients/{clientId}
    await firestoreSet(`fidelite/${merchantUid}/clients/${clientId}`, clientData, token);

    // Écrire dans fidelite_public/{clientId}
    const pubData = {
      id: clientId, prenom, nom,
      points: 0, tampons: 0,
      lastVisit: today, createdAt: today,
      birthday: birthday || '',
      uid: merchantUid
    };
    await firestoreSet(`fidelite_public/${clientId}`, pubData, token);

    console.log(`✅ Client inscrit: ${prenom} ${nom} → merchant: ${merchantUid}`);
    return res.status(200).json({ success: true, clientId });

  } catch (err) {
    console.error('register-client error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
