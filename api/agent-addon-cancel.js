// api/agent-addon-cancel.js
//
// Annule l'addon Léa d'un utilisateur.
// Stratégie Wave 1 : suppression immédiate de l'item avec prorata (crédit
// automatiquement appliqué à la prochaine facture).
//
// Wave 9 pourra upgrade vers un modèle "cancel_at_period_end" via
// subscription_schedule si on veut garder Léa active jusqu'à la fin
// de la période déjà payée. Pour l'instant on fait simple.
//
// Paramètres body : aucun (on identifie l'item depuis Firestore)
//
// Préconditions :
//   - Utilisateur authentifié
//   - agentEnabled === true
//   - agentSubscriptionItemId non vide

const FIREBASE_PROJECT = 'altiora-70599';

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

let _adminToken = null;
let _adminTokenExp = 0;

async function getAdminToken() {
  if (_adminToken && Date.now() < _adminTokenExp - 300000) return _adminToken;
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
  const email = process.env.FIREBASE_API_EMAIL;
  const password = process.env.FIREBASE_API_PASSWORD;
  if (!email || !password) return null;
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${fbKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }
  );
  const data = await r.json();
  if (data.idToken) {
    _adminToken = data.idToken;
    _adminTokenExp = Date.now() + (parseInt(data.expiresIn || '3600') * 1000);
    return _adminToken;
  }
  return null;
}

async function fsGetUser(uid) {
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/users/${uid}`;
  const token = await getAdminToken();
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url + (token ? '' : '?key=' + fbKey), { headers });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.json();
}

function fv(doc, field) {
  const f = doc?.fields?.[field];
  return f?.stringValue ?? f?.integerValue ?? f?.booleanValue ?? null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // ── Auth ──
  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ error: 'Authentification requise' });
  const verified = await verifyFirebaseToken(idToken);
  if (!verified) return res.status(401).json({ error: 'Token invalide' });
  const { uid } = verified;

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: 'Stripe non configuré' });

  try {
    // ── Lire le user ──
    const userDoc = await fsGetUser(uid);
    if (!userDoc) return res.status(400).json({ error: 'Utilisateur introuvable' });

    const agentEnabled = fv(userDoc, 'agentEnabled') === true;
    const itemId = fv(userDoc, 'agentSubscriptionItemId');

    if (!agentEnabled || !itemId) {
      return res.status(400).json({
        error: 'Aucun addon Léa actif à annuler.',
        code: 'NOT_ACTIVE'
      });
    }

    // ── Supprimer l'item Stripe avec prorata (crédit sur prochaine facture) ──
    const delRes = await fetch(`https://api.stripe.com/v1/subscription_items/${itemId}?proration_behavior=create_prorations`, {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer ' + stripeKey,
      },
    });

    const result = await delRes.json();

    if (result.error) {
      console.error('[agent-addon-cancel] Stripe error:', result.error);
      // Si l'item n'existe déjà plus côté Stripe, on nettoie Firestore quand même
      if (result.error.code === 'resource_missing') {
        // (Non bloquant, le webhook subscription.updated suivant remettra Firestore d'aplomb)
        console.warn('[agent-addon-cancel] Item Stripe absent mais Firestore dit qu\'il existe — nettoyage à venir via webhook');
      } else {
        return res.status(400).json({
          error: result.error.message || 'Erreur lors de l\'annulation',
          code: 'STRIPE_ERROR',
        });
      }
    }

    console.log(`[agent-addon-cancel] ✅ Addon annulé uid=${uid} item=${itemId}`);

    // Le webhook customer.subscription.updated va maintenant mettre à jour Firestore
    // (agentEnabled=false, agentAddonStatus='canceled', agentCanceledAt=now)

    return res.status(200).json({
      success: true,
      message: 'Léa est désactivée. Un crédit de prorata sera appliqué sur votre prochaine facture.',
    });

  } catch (e) {
    console.error('[agent-addon-cancel] Exception:', e);
    return res.status(500).json({ error: e.message });
  }
};
