// api/create-subscription-checkout.js
//
// Auth : optionnelle (Bearer token Firebase)
//   - Si token présent → vérifie et utilise l'uid vérifié dans les metadata Stripe
//   - Si pas de token  → pas d'uid dans les metadata (le webhook identifiera via customer email)

// ── Whitelist des priceId Stripe autorisés ──
const VALID_PRICES = [
  'price_1TGEKdRZYcAavmfvmuICL8yc',  // Pro mensuel 69€
  'price_1TGEMARZYcAavmfvvRkZnSap',  // Pro annuel 55€/mois
  'price_1TGENeRZYcAavmfvU4Oxr4cZ',  // Max mensuel 99€
  'price_1TGENeRZYcAavmfvm5Mao8Yi',  // Max annuel 79€/mois
  'price_1TGEOERZYcAavmfvY16T0pCS',  // Master mensuel 169€
  'price_1TGEOcRZYcAavmfvrOqqrjQu',  // Master annuel 135€/mois
];

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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { priceId, plan, billing, skipTrial, referralCode, promoCode } = req.body || {};
  if (!priceId) return res.status(400).json({ error: 'priceId manquant' });

  // ── Vérification whitelist ──
  if (!VALID_PRICES.includes(priceId)) {
    return res.status(400).json({ error: 'Prix non autorisé' });
  }

  // ── Auth optionnelle : vérifier le token Firebase si présent ──
  let verifiedUid = null;
  let verifiedEmail = null;
  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (idToken) {
    const verified = await verifyFirebaseToken(idToken);
    if (verified) {
      verifiedUid = verified.uid;
      verifiedEmail = verified.email;
    }
  }

  // Fallback : utiliser uid/email du body uniquement si pas de token (rétrocompatibilité)
  const uid   = verifiedUid   || req.body?.uid   || null;
  const email = verifiedEmail || req.body?.email || null;

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const baseUrl = process.env.APP_URL || 'https://alteore.com';

  try {
    // ── Si un code promo est fourni, le résoudre en promotion_code ID Stripe ──
    let promoId = null;
    if (promoCode) {
      const promoRes = await fetch(
        'https://api.stripe.com/v1/promotion_codes?code=' + encodeURIComponent(promoCode.trim().toUpperCase()) + '&active=true&limit=1',
        { headers: { Authorization: 'Bearer ' + stripeKey } }
      );
      const promoData = await promoRes.json();
      if (promoData.data && promoData.data.length > 0) {
        promoId = promoData.data[0].id;
      }
      // Si code invalide, on continue sans — le client pourra le retaper sur Stripe
    }

    const params = {
      mode: 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'automatic_tax[enabled]': 'true',
      ...(!skipTrial ? { 'subscription_data[trial_period_days]': '15' } : {}),
      'payment_method_collection': 'if_required',
      // Si promo pré-appliqué → discounts, sinon → champ libre sur le checkout
      ...(promoId
        ? { 'discounts[0][promotion_code]': promoId }
        : { 'allow_promotion_codes': 'true' }),
      success_url: baseUrl + '/dashboard.html?subscription=success&plan=' + plan,
      cancel_url: baseUrl + '/pricing.html?cancelled=1',
      'metadata[plan]': plan,
      'metadata[billing]': billing || 'monthly',
      ...(uid ? { 'metadata[uid]': uid } : {}),
      ...(email ? { customer_email: email } : {}),
      ...(referralCode ? { 'metadata[referralCode]': referralCode.toUpperCase().trim() } : {}),
    };

    const res2 = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + stripeKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString()
    });

    const session = await res2.json();
    if (session.url) {
      return res.status(200).json({ url: session.url });
    } else {
      console.error('Stripe error:', session);
      return res.status(500).json({ error: session.error?.message || 'Erreur Stripe' });
    }
  } catch(e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
