// api/create-subscription-checkout.js

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { priceId, plan, billing, uid, email, skipTrial } = req.body || {};
  if (!priceId) return res.status(400).json({ error: 'priceId manquant' });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const baseUrl = process.env.APP_URL || 'https://altiora-theta.vercel.app';

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
