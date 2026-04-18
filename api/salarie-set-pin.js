// api/salarie-set-pin.js
// Definit ou change le PIN d'un salarie.
//
// DEUX MODES :
// 1. mode='manager' : le manager definit/reset le PIN d'un de ses salaries
//    Input : { publicId, newPin, mode: 'manager', idToken }
//    - Requiert idToken Firebase du manager
//    - Verifie que le manager est bien le proprietaire (uid match rh_employes_public.uid)
//
// 2. mode='self' : le salarie change son propre PIN (il doit connaitre l'ancien)
//    Input : { publicId, newPin, mode: 'self', currentPin }
//    - Requiert le PIN actuel
//    - Applique l'anti-bruteforce sur currentPin (evite de s'en servir comme oracle)
//
// SECURITE :
// - newPin doit etre 4 chiffres
// - En mode manager : verification idToken Firebase + ownership (uid match)
// - En mode self : verification currentPin avec anti-bruteforce (meme que verify-pin)
// - Hash stocke avec salt publicId (meme algo que verify-pin)

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const crypto = require('crypto');

function getApp() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: 'altiora-70599',
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
}
function getDb() { getApp(); return getFirestore(); }
function getAuthAdmin() { getApp(); return getAuth(); }

function hashPin(publicId, pin) {
  const secret = process.env.PIN_SERVER_SECRET || '';
  if (secret.length < 16) throw new Error('PIN_SERVER_SECRET manquant ou trop court');
  const payload = secret + ':' + publicId + ':' + pin;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function computeLockUntil(newAttempts) {
  const now = Date.now();
  if (newAttempts === 5)  return new Date(now +  5 * 60 * 1000).toISOString();
  if (newAttempts === 10) return new Date(now + 60 * 60 * 1000).toISOString();
  if (newAttempts >= 15)  return new Date(now + 24 * 60 * 60 * 1000).toISOString();
  return null;
}

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
    const { publicId, newPin, mode } = req.body || {};

    if (!publicId || typeof publicId !== 'string' || publicId.length < 6) {
      return res.status(400).json({ success: false, error: 'invalid_input' });
    }
    if (!newPin || typeof newPin !== 'string' || !/^[0-9]{4}$/.test(newPin)) {
      return res.status(400).json({ success: false, error: 'invalid_pin_format' });
    }
    if (mode !== 'manager' && mode !== 'self') {
      return res.status(400).json({ success: false, error: 'invalid_mode' });
    }
    if (!process.env.PIN_SERVER_SECRET || process.env.PIN_SERVER_SECRET.length < 16) {
      console.error('[salarie-set-pin] PIN_SERVER_SECRET manquant ou trop court');
      return res.status(500).json({ success: false, error: 'server_config' });
    }

    const db = getDb();

    // Verifier que le salarie existe
    const pubSnap = await db.collection('rh_employes_public').doc(publicId).get();
    if (!pubSnap.exists) {
      return res.status(200).json({ success: false, error: 'invalid_credentials' });
    }
    const pubData = pubSnap.data() || {};
    const ownerUid = pubData.uid;

    // ═══════════════════════════════════════
    // MODE MANAGER : verif idToken + ownership
    // ═══════════════════════════════════════
    if (mode === 'manager') {
      const { idToken } = req.body || {};
      if (!idToken || typeof idToken !== 'string') {
        return res.status(401).json({ success: false, error: 'auth_required' });
      }
      let decoded;
      try {
        decoded = await getAuthAdmin().verifyIdToken(idToken);
      } catch (e) {
        console.warn('[salarie-set-pin] idToken invalide:', e.message);
        return res.status(401).json({ success: false, error: 'invalid_token' });
      }
      const managerUid = decoded.uid;
      if (!managerUid || managerUid !== ownerUid) {
        return res.status(403).json({ success: false, error: 'not_owner' });
      }

      // OK : enregistrer le PIN
      const hash = hashPin(publicId, newPin);
      const now = new Date().toISOString();
      await db.collection('rh_auth_salaries').doc(publicId).set({
        pinHash: hash,
        pinCreatedAt: now,
        pinLastReset: now,
        pinAttempts: 0,
        pinLockedUntil: null,
        pinLength: 4,
        grandfathered: false,
        tempResetCode: null,
        tempResetExpiresAt: null,
        setBy: 'manager',
        setByUid: managerUid,
      }, { merge: true });

      return res.status(200).json({ success: true });
    }

    // ═══════════════════════════════════════
    // MODE SELF : verif currentPin + anti-bruteforce
    // ═══════════════════════════════════════
    if (mode === 'self') {
      const { currentPin } = req.body || {};
      if (!currentPin || typeof currentPin !== 'string' || !/^[0-9]{4}$/.test(currentPin)) {
        return res.status(400).json({ success: false, error: 'invalid_current_pin_format' });
      }

      const authRef = db.collection('rh_auth_salaries').doc(publicId);
      const authSnap = await authRef.get();
      if (!authSnap.exists) {
        return res.status(200).json({ success: false, error: 'no_pin_set' });
      }
      const authData = authSnap.data() || {};
      if (!authData.pinHash) {
        return res.status(200).json({ success: false, error: 'no_pin_set' });
      }

      // Check lock actif
      const now = Date.now();
      if (authData.pinLockedUntil) {
        const lockTs = new Date(authData.pinLockedUntil).getTime();
        if (!isNaN(lockTs) && lockTs > now) {
          return res.status(200).json({
            success: false, error: 'locked',
            attemptsRemaining: 0, lockedUntil: authData.pinLockedUntil,
          });
        }
      }

      // Verifier currentPin avec timing-safe
      const candidateHash = hashPin(publicId, currentPin);
      const match = timingSafeEqualStr(candidateHash, authData.pinHash);

      if (!match) {
        const newAttempts = (parseInt(authData.pinAttempts) || 0) + 1;
        const newLockUntil = computeLockUntil(newAttempts);
        const update = { pinAttempts: newAttempts };
        if (newLockUntil) update.pinLockedUntil = newLockUntil;
        await authRef.set(update, { merge: true });
        return res.status(200).json({
          success: false,
          error: newLockUntil ? 'locked' : 'wrong_current_pin',
          attemptsRemaining: newLockUntil ? 0 : getAttemptsRemaining(newAttempts),
          lockedUntil: newLockUntil,
        });
      }

      // currentPin OK -> enregistrer le nouveau
      const hash = hashPin(publicId, newPin);
      await authRef.set({
        pinHash: hash,
        pinLastReset: new Date(now).toISOString(),
        pinAttempts: 0,
        pinLockedUntil: null,
        grandfathered: false,
        tempResetCode: null,
        tempResetExpiresAt: null,
        setBy: 'self',
      }, { merge: true });

      return res.status(200).json({ success: true });
    }

    // Ne devrait jamais arriver (verifie plus haut)
    return res.status(400).json({ success: false, error: 'invalid_mode' });

  } catch (e) {
    console.error('[salarie-set-pin]', e);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
};
