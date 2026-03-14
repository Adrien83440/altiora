// api/create-subscription-checkout.js
//
// Auth : optionnelle (Bearer token Firebase)
//   - Si token présent → vérifie et utilise l'uid vérifié dans les metadata Stripe
//   - Si pas de token  → pas d'uid dans les metadata (le webhook identifiera via customer email)

// ── Whitelist des priceId Stripe autorisés ──
const VALID_PRICES = [
  'price_1T3gqlGSYbSgNdWwlr6RX92r',  // Pro mensuel 69€
  'price_1T3gveGSYbSgNdWwot2e5YpG',  // Pro annuel 55€/mois
  'price_1T3gtkGSYbSgNdWw81ff10tt',  // Max mensuel 99€
  'price_1T3gwGGSYbSgNdWw1ptpHTDB',  // Max annuel 79€/mois
  'price_1T3guhGSYbSgNdWwtKX6EFuy',  // Master mensuel 169€
  'price_1T3gwsGSYbSgNdWwezlggjJR',  // Master annuel 135€/mois
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

  const { priceId, plan, billing, skipTrial, referralCode } = req.body || {};
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
    const res2 = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + stripeKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        mode: 'subscription',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        ...(!skipTrial ? { 'subscription_data[trial_period_days]': '15' } : {}),
        'payment_method_collection': 'if_required',
        'allow_promotion_codes': 'true',
        success_url: baseUrl + '/dashboard.html?subscription=success&plan=' + plan,
        cancel_url: baseUrl + '/pricing.html?cancelled=1',
        'metadata[plan]': plan,
        'metadata[billing]': billing || 'monthly',
        ...(uid ? { 'metadata[uid]': uid } : {}),
        ...(email ? { customer_email: email } : {}),
        ...(referralCode ? { 'metadata[referralCode]': referralCode.toUpperCase().trim() } : {}),
      }).toString()
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
