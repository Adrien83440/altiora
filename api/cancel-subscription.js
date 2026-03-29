// api/cancel-subscription.js
// Résilie l'abonnement Stripe d'un utilisateur et met à jour Firestore
// POST { uid, reason?, detail? }

const FIREBASE_PROJECT = 'altiora-70599';

async function getAdminToken() {
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
  return data.idToken || null;
}

async function fsGet(path, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`;
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url + (token ? '' : '?key=' + (process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4')), { headers });
  if (!res.ok) return null;
  return res.json();
}

async function fsSet(path, fields, token) {
  const ff = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string')      ff[k] = { stringValue: v };
    else if (typeof v === 'number') ff[k] = { integerValue: String(v) };
    else if (typeof v === 'boolean') ff[k] = { booleanValue: v };
    else if (v === null)            ff[k] = { nullValue: null };
    else                            ff[k] = { stringValue: String(v) };
  }
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?${mask}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ fields: ff }) });
  if (!res.ok) throw new Error('Firestore PATCH failed: ' + await res.text());
  return res.json();
}

function fv(doc, field) {
  const f = doc?.fields?.[field];
  return f?.stringValue ?? f?.integerValue ?? f?.booleanValue ?? null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: 'Config serveur manquante' });

  const { uid, reason, detail } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'uid requis' });

  try {
    const adminToken = await getAdminToken();

    // 1. Lire les infos utilisateur
    const userDoc = await fsGet(`users/${uid}`, adminToken);
    if (!userDoc) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const subscriptionId = fv(userDoc, 'stripeSubscriptionId');
    const customerId = fv(userDoc, 'stripeCustomerId');
    const currentPlan = fv(userDoc, 'plan');

    // 2. Annuler l'abonnement Stripe si présent
    if (subscriptionId) {
      const cancelRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + stripeKey }
      });
      const cancelled = await cancelRes.json();
      if (cancelled.error) {
        console.error('[cancel-subscription] Stripe error:', cancelled.error);
        // Ne pas bloquer si l'abonnement est déjà annulé
        if (cancelled.error.code !== 'resource_missing') {
          return res.status(500).json({ error: 'Erreur Stripe: ' + cancelled.error.message });
        }
      }
      console.log(`[cancel-subscription] Abonnement ${subscriptionId} annulé`);
    }

    // 3. Mettre à jour Firestore
    const now = new Date().toISOString();
    const deleteDate = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];

    await fsSet(`users/${uid}`, {
      plan: 'free',
      subscriptionStatus: 'cancelled',
      cancelledAt: now,
      cancelReason: reason || '',
      cancelDetail: detail || '',
      scheduledDeleteAt: deleteDate,
      previousPlan: currentPlan || '',
    }, adminToken);

    // 4. Logger dans retention_logs
    try {
      const logId = uid + '_' + Date.now();
      await fsSet(`retention_logs/${logId}`, {
        uid,
        action: 'cancelled',
        previousPlan: currentPlan || '',
        reason: reason || '',
        detail: detail || '',
        cancelledAt: now,
        scheduledDeleteAt: deleteDate,
      }, adminToken);
    } catch(logErr) {
      console.warn('[cancel-subscription] Log failed:', logErr.message);
    }

    console.log(`[cancel-subscription] ✅ uid=${uid} plan=${currentPlan}→free reason=${reason}`);
    return res.status(200).json({ ok: true, deleteDate });

  } catch (e) {
    console.error('[cancel-subscription] ❌', e.message);
    return res.status(500).json({ error: e.message });
  }
};
