// api/get-invoices.js
// Retourne les vraies factures Stripe de l'utilisateur connecté
// Sécurisé par token Firebase ID (POST)

const FIREBASE_PROJECT = 'altiora-70599';

// Vérifier le token Firebase et retourner l'uid
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
  const data = await res.json();
  if (!res.ok || !data.users?.[0]?.localId) throw new Error('Token invalide');
  return data.users[0].localId;
}

async function getStripeCustomerId(uid) {
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/users/${uid}?key=${fbKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const doc = await res.json();
  return doc?.fields?.stripeCustomerId?.stringValue || null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { token } = req.body || {};
  if (!token) return res.status(401).json({ error: 'Token manquant' });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: 'Stripe non configuré' });

  try {
    // Vérifier le token et récupérer l'uid
    const uid = await verifyFirebaseToken(token);

    // Récupérer le stripeCustomerId depuis Firestore
    const customerId = await getStripeCustomerId(uid);
    if (!customerId) {
      // Pas de customer Stripe = plan gratuit/offert, aucune facture
      return res.status(200).json({ invoices: [] });
    }

    // Récupérer les factures Stripe
    const stripeRes = await fetch(
      `https://api.stripe.com/v1/invoices?customer=${customerId}&limit=100`,
      { headers: { Authorization: 'Bearer ' + stripeKey } }
    );

    if (!stripeRes.ok) {
      const err = await stripeRes.text();
      return res.status(500).json({ error: 'Erreur Stripe: ' + err });
    }

    const stripeData = await stripeRes.json();

    // Formater les factures pour le front
    const invoices = (stripeData.data || []).map(inv => {
      const ttc  = (inv.total || 0) / 100;
      const tva  = (inv.tax || 0) / 100;
      const ht   = ((inv.subtotal || 0) - (inv.discount_amount || 0)) / 100;

      let statut = 'attente';
      if (inv.status === 'paid') statut = 'payee';
      else if (inv.status === 'open' && inv.due_date && inv.due_date * 1000 < Date.now()) statut = 'retard';
      else if (inv.status === 'open') statut = 'attente';
      else if (inv.status === 'void' || inv.status === 'uncollectible') statut = 'retard';

      return {
        num:    inv.number || ('ALT-' + inv.id.slice(-8).toUpperCase()),
        date:   new Date(inv.created * 1000).toISOString().split('T')[0],
        desc:   inv.lines?.data?.[0]?.description || inv.description || 'Abonnement Alteore',
        ht:     Math.round(ht * 100) / 100,
        tva:    Math.round(tva * 100) / 100,
        ttc:    Math.round(ttc * 100) / 100,
        statut,
        pdf:    inv.invoice_pdf || null,
      };
    });

    return res.status(200).json({ invoices });

  } catch (e) {
    console.error('get-invoices error:', e.message);
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
};
