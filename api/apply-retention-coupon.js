// api/apply-retention-coupon.js
// Applique le coupon de rétention -50% pendant 3 mois sur l'abonnement Stripe de l'utilisateur
// + log la tentative de rétention dans Firebase
// SÉCURISÉ : vérification token Firebase avant toute action

const Stripe = require('stripe');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// ── Firebase Admin init (singleton) ─────────────────────────────────────────
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

// ── Vérification du token Firebase côté serveur ─────────────────────────────
async function verifyFirebaseToken(idToken) {
  const fbKey = process.env.FIREBASE_API_KEY;
  if (!fbKey) throw new Error('FIREBASE_API_KEY non configurée');
  const res = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + fbKey,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    }
  );
  if (!res.ok) throw new Error('Token invalide');
  const data = await res.json();
  const uid = data.users?.[0]?.localId;
  if (!uid) throw new Error('Utilisateur introuvable');
  return uid;
}

// ── Coupon ID à créer dans Stripe Dashboard ──────────────────────────────────
const RETENTION_COUPON_ID = process.env.STRIPE_RETENTION_COUPON_ID || 'ALTEORE_RETENTION_50_3M';

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_URL || 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  // ── AUTH : vérifier le token Firebase ──
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    return res.status(401).json({ error: "Token d'authentification manquant." });
  }

  let verifiedUid;
  try {
    verifiedUid = await verifyFirebaseToken(token);
  } catch (e) {
    return res.status(401).json({ error: 'Token invalide : ' + e.message });
  }

  const { reason } = req.body || {};

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const db     = getDb();

  try {
    // 1. Récupérer l'utilisateur dans Firebase (uid vérifié par le token)
    const userRef  = db.collection('users').doc(verifiedUid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.status(404).json({ error: 'Utilisateur introuvable' });
    }

    const userData = userSnap.data();
    const subscriptionId = userData.stripeSubscriptionId;

    if (!subscriptionId) {
      return res.status(400).json({ error: 'Aucun abonnement Stripe actif trouvé' });
    }

    // 2. Vérifier que la remise n'a pas déjà été appliquée
    if (userData.retentionCouponApplied) {
      return res.status(409).json({ error: 'La remise de rétention a déjà été utilisée' });
    }

    // 3. Appliquer le coupon sur l'abonnement Stripe
    const updatedSub = await stripe.subscriptions.update(subscriptionId, {
      coupon: RETENTION_COUPON_ID,
    });

    // 4. Logger dans Firebase
    await userRef.update({
      retentionCouponApplied: true,
      retentionCouponAppliedAt: FieldValue.serverTimestamp(),
      retentionReason: reason || null,
      retentionCouponId: RETENTION_COUPON_ID,
    });

    // 5. Log optionnel dans collection analytics
    await db.collection('retention_logs').add({
      uid: verifiedUid,
      reason: reason || null,
      couponId: RETENTION_COUPON_ID,
      subscriptionId,
      appliedAt: FieldValue.serverTimestamp(),
      planAtTime: userData.plan,
    });

    return res.status(200).json({
      success: true,
      subscriptionId: updatedSub.id,
      couponApplied: RETENTION_COUPON_ID,
    });

  } catch (err) {
    console.error('[apply-retention-coupon] Error:', err);

    // Stripe error spécifique : coupon invalide
    if (err.type === 'StripeInvalidRequestError') {
      return res.status(400).json({
        error: `Coupon Stripe invalide : ${err.message}. Vérifiez que le coupon "${RETENTION_COUPON_ID}" existe dans votre dashboard Stripe.`,
      });
    }

    return res.status(500).json({ error: 'Erreur interne. Veuillez réessayer.' });
  }
};
