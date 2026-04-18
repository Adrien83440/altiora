// api/salarie-check-status.js
// Vérifie le statut d'authentification PIN d'un salarié SANS révéler de données sensibles.
// Appelé par espace-salarie.html au chargement, AVANT d'afficher la modale login.
//
// Input:  { publicId: string }
// Output: { exists, hasPin, grandfathered, locked, lockedUntil, attemptsRemaining, resetPending }
//
// SECURITE : ne renvoie JAMAIS le hash du PIN, l'email, ni les dates précises.
// Les infos renvoyées suffisent pour que le front décide quoi afficher
// (modale PIN, message "verrouillé", bannière "activez votre code", etc.)

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

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

// Calcul tentatives restantes selon paliers anti-bruteforce
// 5 tentatives echouees -> lock 5 min
// 10 tentatives (5 supplementaires apres unlock) -> lock 1h
// 15 tentatives -> lock 24h
function getAttemptsRemaining(pinAttempts) {
  const n = parseInt(pinAttempts) || 0;
  if (n < 5)  return 5  - n;
  if (n < 10) return 10 - n;
  if (n < 15) return 15 - n;
  return 0;
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
      return res.status(400).json({ error: 'publicId manquant ou invalide' });
    }

    const db = getDb();

    // 1. Verifier que le salarie existe (collection publique)
    const pubSnap = await db.collection('rh_employes_public').doc(publicId).get();
    if (!pubSnap.exists) {
      // Reponse neutre pour eviter l'enumeration de publicId
      return res.status(200).json({
        exists: false,
        hasPin: false,
        grandfathered: false,
        locked: false,
        lockedUntil: null,
        attemptsRemaining: 0,
        resetPending: false,
      });
    }

    // 2. Lire l'etat d'authentification (collection privee, bypass via Admin SDK)
    const authSnap = await db.collection('rh_auth_salaries').doc(publicId).get();

    // Cas 1 : pas de document auth -> grandfathered (ancien salarie avant deploiement)
    if (!authSnap.exists) {
      return res.status(200).json({
        exists: true,
        hasPin: false,
        grandfathered: true,
        locked: false,
        lockedUntil: null,
        attemptsRemaining: 5,
        resetPending: false,
      });
    }

    const authData = authSnap.data() || {};
    const hasPin = !!(authData.pinHash && authData.pinHash.length > 0);

    // Cas 2 : document existe mais pinHash vide -> encore grandfathered
    if (!hasPin) {
      return res.status(200).json({
        exists: true,
        hasPin: false,
        grandfathered: true,
        locked: false,
        lockedUntil: null,
        attemptsRemaining: 5,
        resetPending: !!authData.tempResetCode,
      });
    }

    // Cas 3 : PIN defini - verifier lock et tentatives
    const now = Date.now();
    let locked = false;
    let lockedUntil = null;
    if (authData.pinLockedUntil) {
      const lockTs = new Date(authData.pinLockedUntil).getTime();
      if (!isNaN(lockTs) && lockTs > now) {
        locked = true;
        lockedUntil = authData.pinLockedUntil;
      }
    }

    return res.status(200).json({
      exists: true,
      hasPin: true,
      grandfathered: false,
      locked,
      lockedUntil,
      attemptsRemaining: locked ? 0 : getAttemptsRemaining(authData.pinAttempts),
      resetPending: !!(authData.tempResetCode && authData.tempResetExpiresAt &&
                       new Date(authData.tempResetExpiresAt).getTime() > now),
    });

  } catch (e) {
    console.error('[salarie-check-status]', e);
    return res.status(500).json({ error: 'Erreur interne' });
  }
};
