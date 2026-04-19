// api/agent-addon-checkout.js
//
// Active l'addon Léa sur la subscription existante d'un utilisateur payant.
// - Ajoute un subscription_item à la sub Stripe existante
// - Prorata immédiat (proration_behavior='always_invoice')
// - Le webhook Stripe met ensuite à jour `agentEnabled=true` dans Firestore
//
// Paramètres body :
//   { billing: 'monthly' | 'yearly' }
//
// Préconditions :
//   - Utilisateur authentifié (Bearer token Firebase)
//   - Plan payant actif (pro | max | master), status 'active'
//   - Pas déjà d'addon Léa actif
//
// Retours :
//   200 { success: true, subscriptionItemId, invoiceId }
//   400 { error: "..." } pour les cas non gérés
//   401 si pas authentifié

const FIREBASE_PROJECT = 'altiora-70599';

async function verifyFirebaseToken(idToken) {
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${fbKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const user = data.users?.[0];
  if (!user) return null;
  return { uid: user.localId, email: user.email };
}

// ── Admin token pour lire le doc user ──
let _adminToken = null;
let _adminTokenExp = 0;

async function getAdminToken() {
  if (_adminToken && Date.now() < _adminTokenExp - 300000) return _adminToken;
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
  const email = process.env.FIREBASE_API_EMAIL;
  const password = process.env.FIREBASE_API_PASSWORD;
  if (!email || !password) return null;
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${fbKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }
  );
  const data = await r.json();
  if (data.idToken) {
    _adminToken = data.idToken;
    _adminTokenExp = Date.now() + (parseInt(data.expiresIn || '3600') * 1000);
    return _adminToken;
  }
  return null;
}

async function fsGetUser(uid) {
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/users/${uid}`;
  const token = await getAdminToken();
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url + (token ? '' : '?key=' + fbKey), { headers });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.json();
}

function fv(doc, field) {
  const f = doc?.fields?.[field];
  return f?.stringValue ?? f?.integerValue ?? f?.booleanValue ?? null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // ── Auth obligatoire ──
  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ error: 'Authentification requise' });
  const verified = await verifyFirebaseToken(idToken);
  if (!verified) return res.status(401).json({ error: 'Token invalide' });
  const { uid } = verified;

  // ── Body ──
  const { billing } = req.body || {};
  if (!['monthly', 'yearly'].includes(billing)) {
    return res.status(400).json({ error: "Paramètre 'billing' manquant ou invalide ('monthly' | 'yearly')" });
  }

  const priceId = billing === 'monthly'
    ? process.env.STRIPE_PRICE_ADDON_LEA_MONTHLY
    : process.env.STRIPE_PRICE_ADDON_LEA_YEARLY;

  if (!priceId) {
    console.error('[agent-addon-checkout] Price ID manquant pour billing=' + billing);
    return res.status(500).json({ error: 'Configuration serveur incomplète' });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return res.status(500).json({ error: 'Stripe non configuré' });
  }

  try {
    // ── Lire le user Firestore ──
    const userDoc = await fsGetUser(uid);
    if (!userDoc) return res.status(400).json({ error: 'Utilisateur introuvable' });

    const plan = fv(userDoc, 'plan');
    const subscriptionId = fv(userDoc, 'stripeSubscriptionId');
    const subscriptionStatus = fv(userDoc, 'subscriptionStatus');
    const agentEnabled = fv(userDoc, 'agentEnabled') === true;

    // ── Vérifier les préconditions ──
    if (agentEnabled) {
      return res.status(400).json({ error: 'Léa est déjà active sur votre compte.' });
    }

    if (plan === 'trial') {
      return res.status(400).json({
        error: 'Vous bénéficiez déjà de Léa pendant votre essai. Vous pourrez activer l\'addon à la fin de votre période d\'essai.',
        code: 'TRIAL_ACTIVE'
      });
    }

    if (!['pro', 'max', 'master'].includes(plan)) {
      return res.status(400).json({
        error: 'L\'addon Léa nécessite un plan Pro, Max ou Master actif. Souscrivez d\'abord un plan avant d\'activer Léa.',
        code: 'NO_PLAN'
      });
    }

    if (!subscriptionId) {
      return res.status(400).json({
        error: 'Aucune subscription Stripe active trouvée. Contactez le support.',
        code: 'NO_SUBSCRIPTION'
      });
    }

    if (subscriptionStatus !== 'active') {
      return res.status(400).json({
        error: `Votre abonnement est en statut "${subscriptionStatus}". Régularisez-le avant d'activer Léa.`,
        code: 'SUBSCRIPTION_NOT_ACTIVE'
      });
    }

    // ── Ajouter l'item à la subscription (prorata immédiat) ──
    // proration_behavior='always_invoice' : crée immédiatement une facture de prorata
    // payment_behavior='error_if_incomplete' : si la CB refuse, on reçoit une erreur tout de suite
    const itemRes = await fetch('https://api.stripe.com/v1/subscription_items', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + stripeKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        subscription: subscriptionId,
        price: priceId,
        quantity: '1',
        proration_behavior: 'always_invoice',
        payment_behavior: 'error_if_incomplete',
        'metadata[uid]': uid,
        'metadata[addon]': 'lea',
        'metadata[billing]': billing,
      }).toString()
    });

    const item = await itemRes.json();

    if (item.error) {
      console.error('[agent-addon-checkout] Stripe error:', item.error);
      return res.status(400).json({
        error: item.error.message || 'Erreur lors de l\'activation',
        code: 'STRIPE_ERROR',
        stripeCode: item.error.code,
      });
    }

    console.log(`[agent-addon-checkout] ✅ Addon activé uid=${uid} item=${item.id} billing=${billing}`);

    // ── Le webhook customer.subscription.updated va maintenant mettre à jour Firestore ──
    // On renvoie juste la confirmation au client

    return res.status(200).json({
      success: true,
      subscriptionItemId: item.id,
      priceId,
      billing,
      message: 'Léa est activée ! Vous allez recevoir une facture de prorata pour les jours restants de votre période en cours.',
    });

  } catch (e) {
    console.error('[agent-addon-checkout] Exception:', e);
    return res.status(500).json({ error: e.message });
  }
};
