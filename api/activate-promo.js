// api/activate-promo.js
// ══════════════════════════════════════════════════════════════════
// Activation d'un code promo — offre commerciale
//
// POST { promoCode: 'OFFRE2MOIS' }
// Headers: Authorization: Bearer <Firebase ID Token>
//
// Résultat : plan = 'master', promoEnd = now + durée définie
// ══════════════════════════════════════════════════════════════════

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

// ── Firebase Admin (singleton) ──
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

// ══════════════════════════════════════════════════════════════════
// CODES PROMO VALIDES
// ══════════════════════════════════════════════════════════════════
// Pour ajouter un nouveau code : ajouter une entrée ici.
// durationDays = durée de l'offre en jours
// plan = le plan accordé pendant la durée
// maxUses = 0 = illimité
const PROMO_CODES = {
  'OFFRE2MOIS': {
    plan: 'master',
    durationDays: 60,
    label: 'Offre découverte 2 mois',
    maxUses: 0,       // illimité
    active: true,
  },
};

// ── CORS inliné (pattern Vercel) ──
const ALLOWED_ORIGIN = 'https://alteore.com';
function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  // ── 1. Authentification Firebase ──
  const db = getDb(); // Initialise Firebase Admin AVANT de vérifier le token
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Non authentifié. Connectez-vous d\'abord.' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  let uid;
  try {
    const decoded = await getAuth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (e) {
    return res.status(401).json({ error: 'Token invalide ou expiré.' });
  }

  // ── 2. Valider le code promo ──
  const { promoCode } = req.body || {};
  if (!promoCode || typeof promoCode !== 'string') {
    return res.status(400).json({ error: 'Code promo manquant.' });
  }

  const code = promoCode.trim().toUpperCase();
  const promoDef = PROMO_CODES[code];
  if (!promoDef || !promoDef.active) {
    return res.status(400).json({ error: 'Code promo invalide ou expiré.' });
  }

  // ── 3. Vérifier l'utilisateur ──
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();

  if (!userSnap.exists) {
    return res.status(404).json({ error: 'Compte utilisateur introuvable.' });
  }

  const userData = userSnap.data();

  // Vérifier qu'il n'a pas déjà un abonnement Stripe actif
  if (userData.stripeSubscriptionId && ['active', 'trialing'].includes(userData.subscriptionStatus)) {
    return res.status(400).json({ error: 'Vous avez déjà un abonnement actif. Le code promo n\'est pas nécessaire.' });
  }

  // Vérifier qu'il n'a pas déjà utilisé ce code
  if (userData.promoCode === code && userData.promoEnd) {
    return res.status(400).json({ error: 'Vous avez déjà utilisé ce code promo.' });
  }

  // Vérifier qu'il n'a pas déjà une promo active (autre code)
  if (userData.promoEnd) {
    const promoEnd = new Date(userData.promoEnd);
    if (!isNaN(promoEnd.getTime()) && promoEnd > new Date()) {
      return res.status(400).json({ error: 'Vous bénéficiez déjà d\'une offre en cours.' });
    }
  }

  // ── 4. Activer la promo ──
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + promoDef.durationDays);

  const updateData = {
    plan: promoDef.plan,
    promoCode: code,
    promoLabel: promoDef.label,
    promoActivatedAt: now.toISOString(),
    promoEnd: end.toISOString(),
  };

  // Si l'utilisateur était en trial, on conserve l'info
  if (userData.plan === 'trial' && userData.trialEnd) {
    updateData.previousPlan = 'trial';
    updateData.previousTrialEnd = userData.trialEnd;
  }

  await userRef.update(updateData);

  console.log(`[activate-promo] ✅ ${uid} → ${promoDef.plan} via code ${code} (expire ${end.toISOString()})`);

  return res.status(200).json({
    ok: true,
    plan: promoDef.plan,
    promoEnd: end.toISOString(),
    label: promoDef.label,
    durationDays: promoDef.durationDays,
  });
};
