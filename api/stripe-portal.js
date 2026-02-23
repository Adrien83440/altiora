// api/stripe-portal.js
// Génère un lien vers le portail client Stripe pour gérer l'abonnement

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { uid } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'uid manquant' });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const baseUrl = process.env.APP_URL || 'https://alteore-dev.vercel.app';
  const fbProject = 'alteore-dev';
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyA2jBMDhmMwd5KROvutxhsmM4SMOEqdLF4';

  try {
    // 1. Récupérer le stripeCustomerId depuis Firestore
    const fbRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${fbProject}/databases/(default)/documents/users/${uid}`,
      { headers: { 'x-goog-api-key': fbKey } }
    );
    const fbData = await fbRes.json();
    const customerId = fbData?.fields?.stripeCustomerId?.stringValue;

    if (!customerId) {
      return res.status(404).json({ error: 'Aucun abonnement Stripe trouvé pour cet utilisateur.' });
    }

    // 2. Créer la session portail Stripe
    const portalRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + stripeKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        customer: customerId,
        return_url: baseUrl + '/profil.html',
      }).toString()
    });

    const session = await portalRes.json();
    if (session.url) {
      return res.status(200).json({ url: session.url });
    } else {
      console.error('Stripe portal error:', session);
      return res.status(500).json({ error: session.error?.message || 'Erreur portail Stripe' });
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
