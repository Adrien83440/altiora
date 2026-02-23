// api/create-checkout.js — sans dépendance npm, fetch pur

const PACKS = {
  pack_50:  { name: '50 SMS',  sms: 50,  price: 500  },
  pack_200: { name: '200 SMS', sms: 200, price: 2000 },
  pack_500: { name: '500 SMS', sms: 500, price: 4000 },
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const { packId, uid, successUrl, cancelUrl } = req.body;
  if (!packId || !uid) return res.status(400).json({ error: 'packId et uid requis' });

  const pack = PACKS[packId];
  if (!pack) return res.status(400).json({ error: 'Pack inconnu' });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const baseUrl = 'https://alteore-dev.vercel.app';

  const params = new URLSearchParams({
    'payment_method_types[0]':                      'card',
    'line_items[0][price_data][currency]':           'eur',
    'line_items[0][price_data][product_data][name]': 'ALTIORA — Pack ' + pack.name,
    'line_items[0][price_data][unit_amount]':        pack.price.toString(),
    'line_items[0][quantity]':                       '1',
    'mode':                                          'payment',
    'metadata[uid]':                                 uid,
    'metadata[packId]':                              packId,
    'metadata[smsCount]':                            pack.sms.toString(),
    'success_url':  successUrl || (baseUrl + '/fidelisation.html?sms=success'),
    'cancel_url':   cancelUrl  || (baseUrl + '/fidelisation.html?sms=cancel'),
  });

  try {
    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + stripeKey,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const session = await stripeRes.json();
    if (session.error) return res.status(400).json({ error: session.error.message });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    return res.status(500).json({ error: err.message });
  }
};
