// api/generate-referral-code.js
// Génère (ou récupère) le code de parrainage unique d'un utilisateur
// Requiert un Firebase ID token dans le header Authorization: Bearer <idToken>

const FIREBASE_PROJECT = 'alteore-dev';
const FB_KEY_DEFAULT   = 'AIzaSyA2jBMDhmMwd5KROvutxhsmM4SMOEqdLF4';

function fbKey() {
  return process.env.FIREBASE_API_KEY || FB_KEY_DEFAULT;
}

// ── Vérifie le token Firebase et retourne l'uid ──
async function verifyIdToken(idToken) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${fbKey()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    }
  );
  const data = await res.json();
  if (data.error) throw new Error('Token invalide: ' + data.error.message);
  const user = data.users?.[0];
  if (!user) throw new Error('Utilisateur non trouvé');
  return user.localId;
}

// ── Firestore authentifié avec token Bearer ──
async function fsGet(path, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`;
  const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + idToken } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Firestore GET failed: ' + await res.text());
  return res.json();
}

async function fsSet(path, fields, idToken) {
  const ff = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string')      ff[k] = { stringValue: v };
    else if (typeof v === 'number') ff[k] = { integerValue: v };
    else if (v === null)            ff[k] = { nullValue: null };
    else                            ff[k] = { stringValue: String(v) };
  }
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?${mask}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
    body: JSON.stringify({ fields: ff })
  });
  if (!res.ok) throw new Error('Firestore PATCH failed: ' + await res.text());
  return res.json();
}

// ── Firestore public (lecture referrals) ──
async function fsGetPublic(path) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?key=${fbKey()}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.json();
}

// ── Firestore écriture server-side avec API key (pour referrals/{code}) ──
async function fsSetApiKey(path, fields) {
  const ff = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string')      ff[k] = { stringValue: v };
    else if (typeof v === 'number') ff[k] = { integerValue: v };
    else if (v === null)            ff[k] = { nullValue: null };
    else                            ff[k] = { stringValue: String(v) };
  }
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?${mask}&key=${fbKey()}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: ff })
  });
  if (!res.ok) throw new Error('Firestore PATCH (apikey) failed: ' + await res.text());
  return res.json();
}

function fv(doc, field) {
  const f = doc?.fields?.[field];
  return f?.stringValue ?? f?.integerValue ?? f?.booleanValue ?? null;
}

function generateCode(displayName) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const prefix = displayName
    ? displayName.toUpperCase().replace(/[^A-Z]/g, '').substring(0, 4).padEnd(4, 'X')
    : Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  const suffix = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return prefix + '-' + suffix;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const { displayName } = req.body || {};

  if (!idToken) return res.status(401).json({ error: 'Token Firebase requis' });

  try {
    const uid = await verifyIdToken(idToken);

    const userDoc = await fsGet(`users/${uid}`, idToken);
    const existingCode = fv(userDoc, 'referralCode');

    if (existingCode) {
      const refDoc = await fsGetPublic(`referrals/${existingCode}`);
      return res.status(200).json({
        code:            existingCode,
        totalUses:       parseInt(fv(refDoc, 'totalUses'))      || 0,
        totalRewarded:   parseInt(fv(refDoc, 'totalRewarded'))  || 0,
        referralRewards: parseInt(fv(userDoc, 'referralRewards')) || 0,
        isNew: false,
      });
    }

    // Générer code unique
    let code = null, attempts = 0;
    while (!code && attempts < 10) {
      const candidate = generateCode(displayName);
      const existing = await fsGetPublic(`referrals/${candidate}`);
      if (!existing) code = candidate;
      attempts++;
    }
    if (!code) throw new Error('Impossible de générer un code unique');

    const now = new Date().toISOString();

    // Écrire referrals/{code} avec le token authentifié (rule: create si ownerUid == auth.uid)
    await fsSet(`referrals/${code}`, {
      ownerUid: uid, ownerName: displayName || '',
      createdAt: now, totalUses: 0, totalRewarded: 0,
    }, idToken);

    // Écrire users/{uid} avec le token authentifié
    await fsSet(`users/${uid}`, { referralCode: code, referralRewards: 0 }, idToken);

    console.log(`[Referral] Nouveau code: ${code} pour uid=${uid}`);
    return res.status(200).json({ code, totalUses: 0, totalRewarded: 0, referralRewards: 0, isNew: true });

  } catch (e) {
    console.error('[generate-referral-code]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
