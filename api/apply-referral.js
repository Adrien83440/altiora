// api/apply-referral.js
// Valide un code de parrainage et enregistre la relation parrain/filleul
// Appelé côté client avant le checkout pour vérifier que le code existe

const FIREBASE_PROJECT = 'alteore-dev';
const FB_KEY_DEFAULT   = 'AIzaSyA2jBMDhmMwd5KROvutxhsmM4SMOEqdLF4';

function fbKey() {
  return process.env.FIREBASE_API_KEY || FB_KEY_DEFAULT;
}

// ── Lecture d'un document Firestore via REST ──
async function fsGet(path) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?key=${fbKey()}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Firestore GET failed: ' + await res.text());
  return res.json();
}

// ── Écriture (merge) d'un document Firestore via REST ──
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

// ── Query Firestore ──
async function fsQuery(collectionId, field, op, value) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents:runQuery?key=${fbKey()}`;
  const valueType = typeof value === 'string' ? { stringValue: value } : { integerValue: value };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: { fieldFilter: { field: { fieldPath: field }, op, value: valueType } },
        limit: 1
      }
    })
  });
  const results = await res.json();
  return results?.[0]?.document || null;
}

// ── Extraire une valeur d'un champ Firestore ──
function fv(doc, field) {
  const f = doc?.fields?.[field];
  return f?.stringValue ?? f?.integerValue ?? f?.booleanValue ?? null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { referralCode, filleulUid, filleulEmail } = req.body || {};

  if (!referralCode || !filleulUid) {
    return res.status(400).json({ error: 'referralCode et filleulUid requis' });
  }

  const code = referralCode.toUpperCase().trim();

  try {
    // 1. Vérifier que le code existe dans Firestore
    const refDoc = await fsGet(`referrals/${code}`);
    if (!refDoc) {
      return res.status(404).json({ error: 'Code de parrainage invalide' });
    }

    const ownerUid = fv(refDoc, 'ownerUid');
    if (!ownerUid) {
      return res.status(404).json({ error: 'Code de parrainage invalide' });
    }

    // 2. Empêcher l'auto-parrainage
    if (ownerUid === filleulUid) {
      return res.status(400).json({ error: 'Vous ne pouvez pas utiliser votre propre code' });
    }

    // 3. Vérifier que ce filleul n'a pas déjà utilisé CE code (ou un autre)
    const existingUse = await fsGet(`referrals/${code}/uses/${filleulUid}`);
    if (existingUse) {
      return res.status(400).json({ error: 'Vous avez déjà utilisé ce code de parrainage' });
    }

    // 4. Vérifier que l'utilisateur n'a pas déjà été parrainé (via un autre code)
    const filleulDoc = await fsGet(`users/${filleulUid}`);
    if (filleulDoc && fv(filleulDoc, 'parrainedBy')) {
      return res.status(400).json({ error: 'Vous avez déjà été parrainé' });
    }

    // 5. Enregistrer la relation parrain/filleul
    const now = new Date().toISOString();
    await fsSet(`referrals/${code}/uses/${filleulUid}`, {
      filleulUid,
      filleulEmail:  filleulEmail || '',
      status:        'pending',    // → 'rewarded' quand 1ère vraie facture payée
      createdAt:     now,
      rewardedAt:    '',
      referralCode:  code,
      ownerUid,
    });

    // 6. Marquer sur le filleul quel code il a utilisé (pour éviter double usage)
    await fsSet(`users/${filleulUid}`, {
      parrainedBy:   ownerUid,
      referralCode:  code,
      parrainedAt:   now,
    });

    console.log(`[Referral] Parrainage enregistré: parrain=${ownerUid} filleul=${filleulUid} code=${code}`);

    return res.status(200).json({
      ok: true,
      message: 'Code de parrainage valide ✓',
      ownerUid,
    });

  } catch (e) {
    console.error('[apply-referral] Erreur:', e);
    return res.status(500).json({ error: e.message });
  }
};
