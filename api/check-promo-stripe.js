// api/check-promo-stripe.js
// Vérifie si un code promotionnel Stripe existe et est actif
// Retourne { valid, label }

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { code } = req.body || {};
  if (!code) return res.status(400).json({ valid: false });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ valid: false });

  try {
    const r = await fetch(
      'https://api.stripe.com/v1/promotion_codes?code=' + encodeURIComponent(code.trim().toUpperCase()) + '&active=true&limit=1',
      { headers: { Authorization: 'Bearer ' + stripeKey } }
    );
    const data = await r.json();

    if (data.data && data.data.length > 0) {
      const coupon = data.data[0].coupon;
      let label = '';
      if (coupon.percent_off) label = '-' + coupon.percent_off + '%';
      else if (coupon.amount_off) label = '-' + (coupon.amount_off / 100).toFixed(0) + '€';
      if (coupon.duration === 'repeating' && coupon.duration_in_months) label += ' pendant ' + coupon.duration_in_months + ' mois';
      else if (coupon.duration === 'once') label += ' (1ère facture)';
      else if (coupon.duration === 'forever') label += ' à vie';
      return res.status(200).json({ valid: true, label: label || 'Réduction appliquée' });
    }
    return res.status(200).json({ valid: false });
  } catch(e) {
    return res.status(200).json({ valid: false });
  }
};
