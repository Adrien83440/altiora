// api/create-checkout.js
// Crée une session Stripe Checkout pour acheter des packs SMS

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Définition des packs SMS
const PACKS = {
  pack_50:  { name: '50 SMS',  sms: 50,  price: 500  }, // 5€ en centimes
  pack_200: { name: '200 SMS', sms: 200, price: 1500 }, // 15€
  pack_500: { name: '500 SMS', sms: 500, price: 3000 }, // 30€
};

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const { packId, uid, successUrl, cancelUrl } = req.body;

  if (!packId || !uid) {
    return res.status(400).json({ error: 'packId et uid requis' });
  }

  const pack = PACKS[packId];
  if (!pack) {
    return res.status(400).json({ error: 'Pack inconnu' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `ALTIORA — Pack ${pack.name}`,
            description: `${pack.sms} SMS pour vos campagnes de fidélisation`,
          },
          unit_amount: pack.price,
        },
        quantity: 1,
      }],
      mode: 'payment',
      // On passe l'uid et le packId dans les metadata pour les récupérer dans le webhook
      metadata: {
        uid,
        packId,
        smsCount: pack.sms.toString(),
      },
      success_url: successUrl || 'https://altiora-theta.vercel.app/fidelisation.html?sms=success',
      cancel_url: cancelUrl || 'https://altiora-theta.vercel.app/fidelisation.html?sms=cancel',
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    return res.status(500).json({ error: err.message });
  }
};
