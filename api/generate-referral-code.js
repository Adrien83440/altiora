// api/generate-referral-code.js
// Génère (ou récupère) le code de parrainage unique d'un utilisateur
// Appelé depuis profil.html au chargement de l'onglet parrainage

const FIREBASE_PROJECT = 'altiora-70599';
const FB_KEY_DEFAULT   = 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';

function fbKey() {
  return process.env.FIREBASE_API_KEY || FB_KEY_DEFAULT;
}

async function fsGet(path) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?key=${fbKey()}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Firestore GET failed: ' + await res.text());
  return res.json();
}

async function fsSet(path, fields) {
  const firestoreFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string')       firestoreFields[k] = { stringValue: v };
    else if (typeof v === 'number')  firestoreFields[k] = { integerValue: v };
    else if (typeof v === 'boolean') firestoreFields[k] = { booleanValue: v };
    else if (v === null)             firestoreFields[k] = { nullValue: null };
    else                             firestoreFields[k] = { stringValue: String(v) };
  }
  const updateMask = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?${updateMask}&key=${fbKey()}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: firestoreFields })
  });
  if (!res.ok) throw new Error('Firestore PATCH failed: ' + await res.text());
  return res.json();
}

function fv(doc, field) {
  const f = doc?.fields?.[field];
  return f?.stringValue ?? f?.integerValue ?? f?.booleanValue ?? null;
}

// Génère un code lisible : 4 lettres + tiret + 4 chiffres  ex: ALEX-7K2M
function generateCode(displayName) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans I/O/0/1 pour éviter confusions
  const prefix = displayName
    ? displayName.toUpperCase().replace(/[^A-Z]/g, '').substring(0, 4).padEnd(4, 'X')
    : Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  const suffix = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return prefix + '-' + suffix;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { uid, displayName } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'uid requis' });

  try {
    // 1. Vérifier si l'utilisateur a déjà un code
    const userDoc = await fsGet(`users/${uid}`);
    const existingCode = fv(userDoc, 'referralCode');

    if (existingCode) {
      // Récupérer les stats
      const refDoc = await fsGet(`referrals/${existingCode}`);
      const totalUses   = fv(refDoc, 'totalUses')   || 0;
      const totalRewarded = fv(refDoc, 'totalRewarded') || 0;
      const referralRewards = fv(userDoc, 'referralRewards') || 0;
      return res.status(200).json({
        code: existingCode,
        totalUses,
        totalRewarded,
        referralRewards,
        isNew: false,
      });
    }

    // 2. Générer un code unique (retry si collision)
    let code = null;
    let attempts = 0;
    while (!code && attempts < 10) {
      const candidate = generateCode(displayName);
      const existing = await fsGet(`referrals/${candidate}`);
      if (!existing) code = candidate;
      attempts++;
    }

    if (!code) throw new Error('Impossible de générer un code unique');

    const now = new Date().toISOString();

    // 3. Créer le document referrals/{code}
    await fsSet(`referrals/${code}`, {
      ownerUid:       uid,
      ownerName:      displayName || '',
      createdAt:      now,
      totalUses:      0,
      totalRewarded:  0,
    });

    // 4. Sauvegarder le code sur l'utilisateur
    await fsSet(`users/${uid}`, {
      referralCode:     code,
      referralRewards:  0,
    });

    console.log(`[Referral] Nouveau code généré: ${code} pour uid=${uid}`);

    return res.status(200).json({
      code,
      totalUses: 0,
      totalRewarded: 0,
      referralRewards: 0,
      isNew: true,
    });

  } catch (e) {
    console.error('[generate-referral-code] Erreur:', e);
    return res.status(500).json({ error: e.message });
  }
};
