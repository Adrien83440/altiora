// api/get-invoices.js
// Retourne les factures Stripe d'un utilisateur via son stripeCustomerId stocké dans Firebase

const FIREBASE_PROJECT = 'alteore-dev';

async function getStripeCustomerId(uid) {
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyA2jBMDhmMwd5KROvutxhsmM4SMOEqdLF4';
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/users/${uid}?key=${fbKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const doc = await res.json();
  return doc?.fields?.stripeCustomerId?.stringValue || null;
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid manquant' });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: 'Stripe non configuré' });

  // Récupérer le stripeCustomerId depuis Firebase
  const customerId = await getStripeCustomerId(uid);
  if (!customerId) {
    // Pas de customer Stripe = plan gratuit, aucune facture
    return res.status(200).json({ invoices: [] });
  }

  // Récupérer les factures Stripe
  const stripeRes = await fetch(
    `https://api.stripe.com/v1/invoices?customer=${customerId}&limit=100&expand[]=data.charge`,
    { headers: { Authorization: 'Bearer ' + stripeKey } }
  );

  if (!stripeRes.ok) {
    const err = await stripeRes.text();
    return res.status(500).json({ error: 'Erreur Stripe: ' + err });
  }

  const stripeData = await stripeRes.json();

  // Formater les factures pour le front
  const invoices = stripeData.data.map(inv => ({
    num:    inv.number || inv.id,
    date:   new Date(inv.created * 1000).toISOString().split('T')[0],
    desc:   inv.lines?.data?.[0]?.description || inv.description || 'Abonnement Altiora',
    ht:     (inv.subtotal || 0) / 100,
    tva:    (inv.tax || 0) / 100,
    ttc:    (inv.total || 0) / 100,
    statut: inv.status === 'paid' ? 'payee' : inv.status === 'open' ? 'attente' : 'retard',
    pdf:    inv.invoice_pdf || null,
  }));

  return res.status(200).json({ invoices });
};
