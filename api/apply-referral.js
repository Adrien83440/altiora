// api/apply-referral.js
// Valide un code de parrainage et enregistre la relation parrain/filleul
// Appelé côté client avant le checkout pour vérifier que le code existe
//
// Auth : optionnelle (Bearer token Firebase)
//   - Si token présent → vérifie et utilise l'uid vérifié (sécurisé)
//   - Si pas de token  → valide le code sans écrire la relation (le binding se fera au checkout)

const FIREBASE_PROJECT = 'altiora-70599';
const FB_KEY_DEFAULT   = 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';

function fbKey() {
  return process.env.FIREBASE_API_KEY || FB_KEY_DEFAULT;
}

// ── Vérifier un token Firebase et retourner l'uid ──
async function verifyFirebaseToken(idToken) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${fbKey()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.users?.[0]?.localId || null;
}

// ── Lecture d'un document Firestore via REST ──
async function fsGet(path, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`;
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url + (token ? '' : '?key=' + fbKey()), { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Firestore GET failed: ' + await res.text());
  return res.json();
}

// ── Écriture (merge) d'un document Firestore via REST ──
async function fsSet(path, fields, token) {
  const firestoreFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string')       firestoreFields[k] = { stringValue: v };
    else if (typeof v === 'number')  firestoreFields[k] = { integerValue: v };
    else if (typeof v === 'boolean') firestoreFields[k] = { booleanValue: v };
    else if (v === null)             firestoreFields[k] = { nullValue: null };
    else                             firestoreFields[k] = { stringValue: String(v) };
  }
  const updateMask = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?${updateMask}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url + (token ? '' : '&key=' + fbKey()), {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields: firestoreFields })
  });
  if (!res.ok) throw new Error('Firestore PATCH failed: ' + await res.text());
  return res.json();
}

// ── Extraire une valeur d'un champ Firestore ──
function fv(doc, field) {
  const f = doc?.fields?.[field];
  return f?.stringValue ?? f?.integerValue ?? f?.booleanValue ?? null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { referralCode, filleulEmail } = req.body || {};

  if (!referralCode) {
    return res.status(400).json({ error: 'referralCode requis' });
  }

  const code = referralCode.toUpperCase().trim();

  // ── Auth optionnelle : vérifier le token Firebase si présent ──
  let verifiedUid = null;
  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (idToken) {
    verifiedUid = await verifyFirebaseToken(idToken);
  }

  try {
    // 1. Vérifier que le code existe dans Firestore
    const refDoc = await fsGet(`referrals/${code}`, idToken);
    if (!refDoc) {
      return res.status(404).json({ error: 'Code de parrainage invalide' });
    }

    const ownerUid = fv(refDoc, 'ownerUid');
    if (!ownerUid) {
      return res.status(404).json({ error: 'Code de parrainage invalide' });
    }

    // ── Si pas authentifié : juste valider que le code existe, ne rien écrire ──
    if (!verifiedUid) {
      return res.status(200).json({
        ok: true,
        message: 'Code de parrainage valide ✓',
        ownerUid,
        bound: false,
      });
    }

    // ── Authentifié : utiliser l'uid vérifié (pas celui du body) ──
    const filleulUid = verifiedUid;

    // 2. Empêcher l'auto-parrainage
    if (ownerUid === filleulUid) {
      return res.status(400).json({ error: 'Vous ne pouvez pas utiliser votre propre code' });
    }

    // 3. Vérifier que ce filleul n'a pas déjà utilisé CE code (ou un autre)
    const existingUse = await fsGet(`referrals/${code}/uses/${filleulUid}`, idToken);
    if (existingUse) {
      return res.status(400).json({ error: 'Vous avez déjà utilisé ce code de parrainage' });
    }

    // 4. Vérifier que l'utilisateur n'a pas déjà été parrainé (via un autre code)
    const filleulDoc = await fsGet(`users/${filleulUid}`, idToken);
    if (filleulDoc && fv(filleulDoc, 'parrainedBy')) {
      return res.status(400).json({ error: 'Vous avez déjà été parrainé' });
    }

    // 5. Enregistrer la relation parrain/filleul
    const now = new Date().toISOString();
    await fsSet(`referrals/${code}/uses/${filleulUid}`, {
      filleulUid,
      filleulEmail:  filleulEmail || '',
      status:        'pending',
      createdAt:     now,
      rewardedAt:    '',
      referralCode:  code,
      ownerUid,
    }, idToken);

    // 6. Marquer sur le filleul quel code il a utilisé
    await fsSet(`users/${filleulUid}`, {
      parrainedBy:   ownerUid,
      referralCode:  code,
      parrainedAt:   now,
    }, idToken);

    console.log(`[Referral] Parrainage enregistré: parrain=${ownerUid} filleul=${filleulUid} code=${code}`);

    return res.status(200).json({
      ok: true,
      message: 'Code de parrainage valide ✓',
      ownerUid,
      bound: true,
    });

  } catch (e) {
    console.error('[apply-referral] Erreur:', e);
    return res.status(500).json({ error: e.message });
  }
};
