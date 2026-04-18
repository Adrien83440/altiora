// api/salarie-reset-request.js
// Appele par un salarie qui a oublie son PIN.
// Genere un code temporaire qui sera affiche au manager dans rh-employes.
// Le manager peut alors "Approuver" pour generer un nouveau PIN (via salarie-reset-approve).
//
// Input:  { publicId: string }
// Output: { success: true, message } ou { success: false, error }
//
// Rate-limiting basique : si un tempResetCode existe deja et n'est pas expire, on le regenere pas
// (evite spam de demandes).

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const crypto = require('crypto');

function getDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: 'altiora-70599',
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
  return getFirestore();
}

// Genere un code temporaire 6 caracteres alphanumerique (sans ambigus : 0/O, 1/I exclus)
function genTempCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return code;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { publicId } = req.body || {};
    if (!publicId || typeof publicId !== 'string' || publicId.length < 6) {
      return res.status(400).json({ success: false, error: 'invalid_input' });
    }

    const db = getDb();

    // Verifier que le salarie existe
    const pubSnap = await db.collection('rh_employes_public').doc(publicId).get();
    if (!pubSnap.exists) {
      // Reponse neutre pour eviter l'enumeration
      return res.status(200).json({ success: true, message: 'Votre demande a ete transmise.' });
    }

    const authRef = db.collection('rh_auth_salaries').doc(publicId);
    const authSnap = await authRef.get();
    const authData = authSnap.exists ? (authSnap.data() || {}) : {};

    // Si une demande est deja en cours et non expiree, ne pas regenerer
    const now = Date.now();
    if (authData.tempResetCode && authData.tempResetExpiresAt) {
      const expTs = new Date(authData.tempResetExpiresAt).getTime();
      if (!isNaN(expTs) && expTs > now) {
        return res.status(200).json({
          success: true,
          message: 'Votre demande est deja en cours de traitement.',
          alreadyPending: true,
        });
      }
    }

    // Generer nouveau code, valide 24h
    const code = genTempCode();
    const expiresAt = new Date(now + 24 * 3600 * 1000).toISOString();

    await authRef.set({
      tempResetCode: code,
      tempResetExpiresAt: expiresAt,
      tempResetRequestedAt: new Date(now).toISOString(),
    }, { merge: true });

    return res.status(200).json({
      success: true,
      message: 'Votre demande a ete transmise a votre employeur.',
    });

  } catch (e) {
    console.error('[salarie-reset-request]', e);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
};
