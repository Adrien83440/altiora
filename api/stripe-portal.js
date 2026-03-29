// api/stripe-portal.js
// Génère un lien vers le portail client Stripe pour gérer l'abonnement
// SÉCURISÉ : vérifie le token Firebase avant d'accéder au portail Stripe

async function verifyFirebaseToken(idToken) {
  const fbKey = process.env.FIREBASE_API_KEY;
  if (!fbKey) throw new Error('FIREBASE_API_KEY non configurée');
  const res = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + fbKey,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    }
  );
  if (!res.ok) throw new Error('Token invalide');
  const data = await res.json();
  const uid = data.users?.[0]?.localId;
  if (!uid) throw new Error('Utilisateur introuvable');
  return uid;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // ── AUTH : vérifier le token Firebase ──
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    return res.status(401).json({ error: "Token d'authentification manquant." });
  }

  let verifiedUid;
  try {
    verifiedUid = await verifyFirebaseToken(token);
  } catch (e) {
    return res.status(401).json({ error: 'Token invalide ou expiré.' });
  }

  // ── On utilise l'uid vérifié côté serveur, PAS celui du body ──
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const baseUrl = process.env.APP_URL || 'https://alteore.com';
  const fbProject = 'altiora-70599';
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';

  try {
    // 1. Récupérer le stripeCustomerId depuis Firestore (avec le token de l'utilisateur)
    const fbRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${fbProject}/databases/(default)/documents/users/${verifiedUid}`,
      { headers: { 'Authorization': 'Bearer ' + token } }
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
