// api/apply-retention-coupon.js
// Applique le coupon de rétention -50% pendant 3 mois sur l'abonnement Stripe
// + log la tentative de rétention dans Firebase
// SÉCURISÉ : vérification token Firebase avant toute action
// ✅ REST API only — pas de Firebase Admin SDK ni Stripe SDK

const FIREBASE_PROJECT = 'altiora-70599';
const RETENTION_COUPON_ID = process.env.STRIPE_RETENTION_COUPON_ID || 'ALTEORE_RETENTION_50_3M';

// ── Vérification du token Firebase ──
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
  if (!res.ok) throw new Error('Token invalide');
  const data = await res.json();
  const uid = data.users?.[0]?.localId;
  if (!uid) throw new Error('Utilisateur introuvable');
  return uid;
}

// ── Admin token Firebase (pour écrire dans retention_logs) ──
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

// ── Lecture Firestore REST ──
async function fsGet(path, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`;
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url + (token ? '' : '?key=' + (process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4')), { headers });
  if (!res.ok) return null;
  return res.json();
}

function fv(doc, field) {
  const f = doc?.fields?.[field];
  return f?.stringValue ?? f?.integerValue ?? f?.booleanValue ?? null;
}

// ── Écriture Firestore REST ──
async function fsSet(path, fields, token) {
  const ff = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string')       ff[k] = { stringValue: v };
    else if (typeof v === 'number')  ff[k] = { integerValue: String(v) };
    else if (typeof v === 'boolean') ff[k] = { booleanValue: v };
    else if (v === null)             ff[k] = { nullValue: null };
    else                             ff[k] = { stringValue: String(v) };
  }
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?${mask}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ fields: ff }) });
  if (!res.ok) throw new Error('Firestore PATCH failed: ' + await res.text());
  return res.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: 'Config serveur manquante' });

  // ── AUTH ──
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return res.status(401).json({ error: "Token d'authentification manquant." });

  let verifiedUid;
  try {
    verifiedUid = await verifyFirebaseToken(token);
  } catch (e) {
    return res.status(401).json({ error: 'Token invalide : ' + e.message });
  }

  const { reason } = req.body || {};

  try {
    // 1. Récupérer l'utilisateur
    const userDoc = await fsGet(`users/${verifiedUid}`, token);
    if (!userDoc) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const subscriptionId = fv(userDoc, 'stripeSubscriptionId');
    const currentPlan = fv(userDoc, 'plan');

    if (!subscriptionId) {
      return res.status(400).json({ error: 'Aucun abonnement Stripe actif trouvé' });
    }

    // 2. Vérifier que la remise n'a pas déjà été appliquée
    if (fv(userDoc, 'retentionCouponApplied') === true) {
      return res.status(409).json({ error: 'La remise de rétention a déjà été utilisée' });
    }

    // 3. Appliquer le coupon sur l'abonnement Stripe (via discounts pour billing_mode=flexible)
    const subUpdateRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + stripeKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ 'discounts[0][coupon]': RETENTION_COUPON_ID }).toString()
    });
    const updatedSub = await subUpdateRes.json();
    if (updatedSub.error) {
      console.error('[apply-retention-coupon] Stripe error:', updatedSub.error);
      return res.status(400).json({
        error: `Coupon Stripe invalide : ${updatedSub.error.message}. Vérifiez que le coupon "${RETENTION_COUPON_ID}" existe dans Stripe.`
      });
    }

    // 4. Mettre à jour Firestore (user)
    const now = new Date().toISOString();
    await fsSet(`users/${verifiedUid}`, {
      retentionCouponApplied: true,
      retentionCouponAppliedAt: now,
      retentionReason: reason || '',
      retentionCouponId: RETENTION_COUPON_ID,
    }, token);

    // 5. Log dans retention_logs (via admin token)
    try {
      const adminToken = await getAdminToken();
      const logId = verifiedUid + '_' + Date.now();
      await fsSet(`retention_logs/${logId}`, {
        uid: verifiedUid,
        action: 'retention_coupon_applied',
        reason: reason || '',
        couponId: RETENTION_COUPON_ID,
        subscriptionId,
        appliedAt: now,
        planAtTime: currentPlan || '',
      }, adminToken);
    } catch(logErr) {
      console.warn('[apply-retention-coupon] Log failed:', logErr.message);
    }

    console.log(`[apply-retention-coupon] ✅ uid=${verifiedUid} coupon=${RETENTION_COUPON_ID}`);
    return res.status(200).json({
      success: true,
      subscriptionId: updatedSub.id,
      couponApplied: RETENTION_COUPON_ID,
    });

  } catch (err) {
    console.error('[apply-retention-coupon] Error:', err.message);
    return res.status(500).json({ error: 'Erreur interne. Veuillez réessayer.' });
  }
};
