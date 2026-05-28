// api/check-promo-stripe.js
// Vérifie si un code promotionnel Stripe existe et est actif.
// Retourne { valid, label, plan }  (plan = 'pro'|'max'|'master'|null)
//
// FIX (28/05) :
//  1. `expand[]=data.coupon` — sur l'API 2026-03-25.dahlia l'endpoint LISTE
//     ne renvoie pas le sous-objet `coupon` par défaut (il revenait null →
//     `coupon.percent_off` plantait, avalé par le try/catch → faux "valid:false").
//  2. Détection du plan cible : si le coupon est restreint à un produit
//     (applies_to), on retrouve le plan correspondant via ses tarifs.

// ── Tarifs Stripe par plan (mensuel + annuel) ──
const PLAN_PRICES = {
  pro:    ['price_1TGEKdRZYcAavmfvmuICL8yc', 'price_1TGEMARZYcAavmfvvRkZnSap'],
  max:    ['price_1TGENeRZYcAavmfvU4Oxr4cZ', 'price_1TGENeRZYcAavmfvm5Mao8Yi'],
  master: ['price_1TGEOERZYcAavmfvY16T0pCS', 'price_1TGEOcRZYcAavmfvrOqqrjQu'],
};

// ── Détermine le plan ciblé par un coupon restreint à un produit ──
async function detectPlan(coupon, stripeKey) {
  try {
    const products = coupon && coupon.applies_to && coupon.applies_to.products;
    if (!products || !products.length) return null; // coupon non restreint → pas de plan imposé
    const productId = products[0];
    const r = await fetch(
      'https://api.stripe.com/v1/prices?product=' + encodeURIComponent(productId) + '&limit=20',
      { headers: { Authorization: 'Bearer ' + stripeKey } }
    );
    const pr  = await r.json();
    const ids = (pr.data || []).map(function(p){ return p.id; });
    for (const plan of Object.keys(PLAN_PRICES)) {
      if (PLAN_PRICES[plan].some(function(id){ return ids.includes(id); })) return plan;
    }
    return null;
  } catch (e) {
    return null;
  }
}

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
      'https://api.stripe.com/v1/promotion_codes?code=' + encodeURIComponent(code.trim().toUpperCase()) + '&active=true&limit=1&expand[]=data.coupon',
      { headers: { Authorization: 'Bearer ' + stripeKey } }
    );
    const data = await r.json();

    const promo  = data && data.data && data.data[0];
    const coupon = promo && promo.coupon;

    // Garde : pas de promo OU coupon absent/non-expand → invalide proprement
    if (!coupon) {
      return res.status(200).json({ valid: false });
    }

    let label = '';
    if (coupon.percent_off)      label = '-' + coupon.percent_off + '%';
    else if (coupon.amount_off)  label = '-' + (coupon.amount_off / 100).toFixed(0) + '€';

    if (coupon.duration === 'repeating' && coupon.duration_in_months) {
      label += ' pendant ' + coupon.duration_in_months + ' mois';
    } else if (coupon.duration === 'once') {
      label += ' (1ère facture)';
    } else if (coupon.duration === 'forever') {
      label += ' à vie';
    }

    const plan = await detectPlan(coupon, stripeKey);

    return res.status(200).json({ valid: true, label: label || 'Réduction appliquée', plan: plan });
  } catch (e) {
    return res.status(200).json({ valid: false });
  }
};
