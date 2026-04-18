// api/salarie-verify-pin.js
// Verifie le PIN saisi par un salarie et retourne un token de session.
//
// Input:  { publicId: string, pin: string (4 chiffres) }
// Output OK:    { success: true, token: string, expiresAt: ISO }
// Output KO:    { success: false, error, attemptsRemaining, lockedUntil }
//
// SECURITE :
// - Hash SHA-256 avec salt fixe + publicId + PIN (rend arc-en-ciel inutile)
// - Anti-bruteforce progressif : 5 echecs -> 5min, 10 -> 1h, 15 -> 24h
// - Token de session : HMAC-SHA256(publicId + expiresAt, SECRET) en base64
// - Collection privee, bypass rules via Admin SDK
//
// ENV VARS requises :
// - FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY (Service Account deja configure)
// - PIN_SERVER_SECRET : secret long (>32 chars) utilise pour hash PIN + signer token
//   Generer avec : openssl rand -base64 48

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

// Hash du PIN avec salt : rend le hash stocke non reutilisable sur un autre user
// Format : SHA-256(SECRET:publicId:PIN)
// publicId participe au salt -> meme PIN pour 2 salaries = 2 hashes differents
function hashPin(publicId, pin) {
  const secret = process.env.PIN_SERVER_SECRET || '';
  if (secret.length < 16) {
    throw new Error('PIN_SERVER_SECRET manquant ou trop court (>= 16 caracteres requis)');
  }
  const payload = secret + ':' + publicId + ':' + pin;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// Genere un token de session signe HMAC-SHA256
// Format : base64(publicId:expiresAtMs).HMACsignature
function makeSessionToken(publicId, ttlHours) {
  const secret = process.env.PIN_SERVER_SECRET || '';
  const expiresAt = Date.now() + (ttlHours * 3600 * 1000);
  const payload = publicId + ':' + expiresAt;
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return payloadB64 + '.' + sig;
}

// Anti-bruteforce : calcule la duree de lock selon le nombre d'echecs total
// Retourne ISO string ou null si pas de lock a appliquer
function computeLockUntil(newAttempts) {
  const now = Date.now();
  if (newAttempts === 5)  return new Date(now +  5 * 60 * 1000).toISOString();       // 5 min
  if (newAttempts === 10) return new Date(now + 60 * 60 * 1000).toISOString();       // 1h
  if (newAttempts >= 15)  return new Date(now + 24 * 60 * 60 * 1000).toISOString();  // 24h
  return null;
}

function getAttemptsRemaining(pinAttempts) {
  const n = parseInt(pinAttempts) || 0;
  if (n < 5)  return 5  - n;
  if (n < 10) return 10 - n;
  if (n < 15) return 15 - n;
  return 0;
}

// Comparaison timing-safe des hashes (evite les attaques par timing)
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { publicId, pin } = req.body || {};

    // Validation input
    if (!publicId || typeof publicId !== 'string' || publicId.length < 6) {
      return res.status(400).json({ success: false, error: 'invalid_input' });
    }
    if (!pin || typeof pin !== 'string' || !/^[0-9]{4}$/.test(pin)) {
      return res.status(400).json({ success: false, error: 'invalid_pin_format' });
    }

    // Check server secret present
    if (!process.env.PIN_SERVER_SECRET || process.env.PIN_SERVER_SECRET.length < 16) {
      console.error('[salarie-verify-pin] PIN_SERVER_SECRET manquant ou trop court');
      return res.status(500).json({ success: false, error: 'server_config' });
    }

    const db = getDb();

    // 1. Verifier que le salarie existe
    const pubSnap = await db.collection('rh_employes_public').doc(publicId).get();
    if (!pubSnap.exists) {
      // Reponse neutre pour eviter l'enumeration
      return res.status(200).json({
        success: false,
        error: 'invalid_credentials',
        attemptsRemaining: 5,
        lockedUntil: null,
      });
    }

    // 2. Lire l'auth doc
    const authRef = db.collection('rh_auth_salaries').doc(publicId);
    const authSnap = await authRef.get();

    if (!authSnap.exists) {
      // Pas de doc auth -> salarie grandfathered sans PIN defini
      // Ne devrait pas arriver si le front appelle check-status avant
      return res.status(200).json({
        success: false,
        error: 'no_pin_set',
        attemptsRemaining: 5,
        lockedUntil: null,
      });
    }

    const authData = authSnap.data() || {};
    const hasPin = !!(authData.pinHash && authData.pinHash.length > 0);
    if (!hasPin) {
      return res.status(200).json({
        success: false,
        error: 'no_pin_set',
        attemptsRemaining: 5,
        lockedUntil: null,
      });
    }

    // 3. Check lock actif
    const now = Date.now();
    if (authData.pinLockedUntil) {
      const lockTs = new Date(authData.pinLockedUntil).getTime();
      if (!isNaN(lockTs) && lockTs > now) {
        return res.status(200).json({
          success: false,
          error: 'locked',
          attemptsRemaining: 0,
          lockedUntil: authData.pinLockedUntil,
        });
      }
    }

    // 4. Hash du PIN recu et comparaison timing-safe
    const candidateHash = hashPin(publicId, pin);
    const match = timingSafeEqualStr(candidateHash, authData.pinHash);

    if (match) {
      // PIN correct : reset compteur + update lastLogin + genere token
      const token = makeSessionToken(publicId, 8); // TTL 8h
      const expiresAt = new Date(now + 8 * 3600 * 1000).toISOString();

      await authRef.set({
        pinAttempts: 0,
        pinLockedUntil: null,
        lastLoginAt: new Date(now).toISOString(),
      }, { merge: true });

      return res.status(200).json({
        success: true,
        token,
        expiresAt,
      });
    }

    // 5. Mismatch : incrementer compteur et potentiellement lock
    const currentAttempts = parseInt(authData.pinAttempts) || 0;
    const newAttempts = currentAttempts + 1;
    const newLockUntil = computeLockUntil(newAttempts);

    const updatePayload = {
      pinAttempts: newAttempts,
    };
    if (newLockUntil) {
      updatePayload.pinLockedUntil = newLockUntil;
    }
    await authRef.set(updatePayload, { merge: true });

    return res.status(200).json({
      success: false,
      error: newLockUntil ? 'locked' : 'wrong_pin',
      attemptsRemaining: newLockUntil ? 0 : getAttemptsRemaining(newAttempts),
      lockedUntil: newLockUntil,
    });

  } catch (e) {
    console.error('[salarie-verify-pin]', e);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
};
