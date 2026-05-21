// api/admin-sync-billing.js
// ══════════════════════════════════════════════════════════════════
// Endpoint admin de synchronisation `billing` + `stripePriceId`
//
// Sert à RÉPARER les users qui ont un `stripeSubscriptionId` actif
// mais qui n'ont pas (ou plus) les champs `billing` (monthly/yearly)
// et `stripePriceId` correctement renseignés dans Firestore.
//
// Sécurité :
//   • POST avec header Authorization: Bearer <idToken>
//   • L'idToken doit appartenir à contact@adrienemily.com
//     (vérifié via Identity Toolkit)
//
// Flux :
//   1. Lit tous les `users/` (REST API + admin token api@altiora.app)
//   2. Pour chaque user avec stripeSubscriptionId rempli :
//      → fetch GET https://api.stripe.com/v1/subscriptions/{id}
//      → déduit billing (PRICE_TO_BILLING → fallback recurring.interval)
//      → déduit planPriceId
//      → si différent de Firestore → PATCH user
//   3. Renvoie un résumé : synced[], skipped[], errors[]
//
// Idempotent : peut être ré-exécuté sans effet de bord (ne touche
// que les docs où la valeur est manquante/différente).
//
// Body optionnel :
//   { "dryRun": true }   → ne fait aucune écriture, renvoie juste le diff
//
// Test :
//   curl -X POST https://alteore.com/api/admin-sync-billing \
//     -H "Authorization: Bearer <admin_idToken>" \
//     -H "Content-Type: application/json" \
//     -d '{"dryRun":true}'
// ══════════════════════════════════════════════════════════════════

const FIREBASE_PROJECT = 'altiora-70599';
const FB_KEY = 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
const ADMIN_EMAIL = 'contact@adrienemily.com';

// ── Mapping price → billing (synchronisé avec stripe-subscription-webhook.js) ──
const PRICE_TO_BILLING = {
  'price_1TGEKdRZYcAavmfvmuICL8yc': 'monthly',  // Pro mensuel
  'price_1TGEMARZYcAavmfvvRkZnSap': 'yearly',   // Pro annuel
  'price_1TGENeRZYcAavmfvU4Oxr4cZ': 'monthly',  // Max mensuel
  'price_1TGENeRZYcAavmfvm5Mao8Yi': 'yearly',   // Max annuel
  'price_1TGEOERZYcAavmfvY16T0pCS': 'monthly',  // Master mensuel
  'price_1TGEOcRZYcAavmfvrOqqrjQu': 'yearly',   // Master annuel
};

// Price IDs des plans reconnus (pour ignorer les items addon Léa)
const KNOWN_PLAN_PRICES = new Set(Object.keys(PRICE_TO_BILLING));

// ══════════════════════════════════════════════════════════════════
// HELPERS — Firebase REST
// ══════════════════════════════════════════════════════════════════

let _adminToken = null;
let _adminTokenExp = 0;

async function getAdminToken() {
  if (_adminToken && Date.now() < _adminTokenExp - 300000) return _adminToken;
  const fbKey = process.env.FIREBASE_API_KEY || FB_KEY;
  const email = process.env.FIREBASE_API_EMAIL;
  const password = process.env.FIREBASE_API_PASSWORD;
  if (!email || !password) throw new Error('Missing FIREBASE_API_EMAIL/PASSWORD env vars');
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${fbKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) }
  );
  const data = await r.json();
  if (!data.idToken) throw new Error('Admin login failed: ' + (data.error?.message || 'unknown'));
  _adminToken = data.idToken;
  _adminTokenExp = Date.now() + (parseInt(data.expiresIn || '3600') * 1000);
  return _adminToken;
}

function parseFields(fields) {
  if (!fields) return {};
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = parseValue(v);
  return out;
}

function parseValue(v) {
  if (v == null) return null;
  if (v.stringValue !== undefined)    return v.stringValue;
  if (v.integerValue !== undefined)   return parseInt(v.integerValue, 10);
  if (v.doubleValue !== undefined)    return parseFloat(v.doubleValue);
  if (v.booleanValue !== undefined)   return v.booleanValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.nullValue !== undefined)      return null;
  if (v.mapValue !== undefined)       return parseFields(v.mapValue.fields || {});
  if (v.arrayValue !== undefined)     return (v.arrayValue.values || []).map(parseValue);
  return null;
}

async function fsListAll(collectionId, token, pageSize = 300) {
  const all = [];
  let pageToken = '';
  for (let i = 0; i < 50; i++) {
    let url = `${FS_BASE}/${collectionId}?pageSize=${pageSize}`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!res.ok) break;
    const data = await res.json();
    const docs = data.documents || [];
    for (const d of docs) {
      const id = d.name.split('/').pop();
      all.push({ id, data: parseFields(d.fields), _name: d.name });
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return all;
}

// Conversion JS → Firestore value (limité aux types qu'on écrit ici : string)
function toFsValue(v) {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (v === null || v === undefined) return { nullValue: null };
  return { stringValue: String(v) };
}

// PATCH user avec updateMask pour ne toucher que les champs voulus
async function patchUserFields(uid, fields, adminToken) {
  const updateMask = Object.keys(fields).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const url = `${FS_BASE}/users/${uid}?${updateMask}`;
  const body = JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toFsValue(v)])) });
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Authorization': 'Bearer ' + adminToken, 'Content-Type': 'application/json' },
    body
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Firestore PATCH ${res.status}: ${txt.slice(0, 200)}`);
  }
  return await res.json();
}

// ══════════════════════════════════════════════════════════════════
// VÉRIFICATION IDTOKEN ADMIN
// ══════════════════════════════════════════════════════════════════

async function verifyAdminIdToken(idToken) {
  const fbKey = process.env.FIREBASE_API_KEY || FB_KEY;
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${fbKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
  );
  const data = await r.json();
  if (!data.users || !data.users[0]) return null;
  const user = data.users[0];
  if (user.email !== ADMIN_EMAIL) return null;
  return { uid: user.localId, email: user.email };
}

// ══════════════════════════════════════════════════════════════════
// STRIPE — Lire une subscription
// ══════════════════════════════════════════════════════════════════

async function fetchStripeSubscription(subscriptionId, stripeKey) {
  const r = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
    headers: { Authorization: 'Bearer ' + stripeKey }
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Stripe ${r.status}: ${txt.slice(0, 200)}`);
  }
  return await r.json();
}

// Analyse de la subscription pour extraire planPriceId + billing
// (logique identique à `analyzeSubscriptionItems` du webhook, en version locale)
function analyzeSub(subscription) {
  const items = subscription?.items?.data || [];
  let planItem = null;
  for (const item of items) {
    const priceId = item?.price?.id;
    if (!priceId) continue;
    if (KNOWN_PLAN_PRICES.has(priceId)) {
      planItem = item;
      break;
    }
  }
  if (!planItem) return { planPriceId: '', billing: '', status: subscription?.status || '' };

  const planPriceId = planItem.price?.id || '';
  let billing = '';
  if (PRICE_TO_BILLING[planPriceId]) {
    billing = PRICE_TO_BILLING[planPriceId];
  } else {
    const interval = planItem.price?.recurring?.interval;
    if (interval === 'year')       billing = 'yearly';
    else if (interval === 'month') billing = 'monthly';
  }
  return { planPriceId, billing, status: subscription?.status || '' };
}

// ══════════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════════

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ── 1. Auth admin ──
    const authHeader = req.headers.authorization || req.headers.Authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (!m) return res.status(401).json({ error: 'Missing Authorization Bearer token' });
    const verified = await verifyAdminIdToken(m[1].trim());
    if (!verified) return res.status(403).json({ error: 'Forbidden — admin only (' + ADMIN_EMAIL + ')' });

    // ── 2. Body : dryRun ? ──
    let body = {};
    try {
      if (typeof req.body === 'string') body = JSON.parse(req.body || '{}');
      else if (req.body && typeof req.body === 'object') body = req.body;
    } catch (_) {}
    const dryRun = body.dryRun === true;

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return res.status(500).json({ error: 'STRIPE_SECRET_KEY missing' });

    // ── 3. Charger tous les users ──
    const adminToken = await getAdminToken();
    const usersRaw = await fsListAll('users', adminToken);
    const users = usersRaw.map(u => ({ uid: u.id, ...u.data }));

    // ── 4. Pour chaque user avec stripeSubscriptionId, comparer Stripe vs Firestore ──
    const synced = [];   // mis à jour (ou aurait été en dryRun)
    const aligned = [];  // déjà cohérent → rien à faire
    const skipped = [];  // pas d'abo Stripe ou sub introuvable
    const errors = [];   // erreurs Stripe ou Firestore

    for (const u of users) {
      if (!u.stripeSubscriptionId) {
        skipped.push({ uid: u.uid, email: u.email || '?', reason: 'no_subscription' });
        continue;
      }

      let sub;
      try {
        sub = await fetchStripeSubscription(u.stripeSubscriptionId, stripeKey);
      } catch (e) {
        errors.push({ uid: u.uid, email: u.email || '?', step: 'fetch_stripe', error: e.message });
        continue;
      }

      if (!sub || sub.error || !sub.items) {
        skipped.push({
          uid: u.uid, email: u.email || '?',
          reason: 'subscription_not_found',
          stripeId: u.stripeSubscriptionId,
          stripeError: sub?.error?.message || ''
        });
        continue;
      }

      const analysis = analyzeSub(sub);
      if (!analysis.planPriceId) {
        skipped.push({ uid: u.uid, email: u.email || '?', reason: 'no_recognized_plan_item', stripeId: u.stripeSubscriptionId });
        continue;
      }

      // ── Diff Firestore vs Stripe ──
      const fields = {};
      const before = {
        billing: u.billing || '',
        stripePriceId: u.stripePriceId || '',
      };
      const after = {
        billing: analysis.billing || '',
        stripePriceId: analysis.planPriceId || '',
      };

      if (after.billing && after.billing !== before.billing)             fields.billing = after.billing;
      if (after.stripePriceId && after.stripePriceId !== before.stripePriceId) fields.stripePriceId = after.stripePriceId;

      if (Object.keys(fields).length === 0) {
        aligned.push({ uid: u.uid, email: u.email || '?', billing: after.billing });
        continue;
      }

      const entry = {
        uid: u.uid,
        email: u.email || '?',
        name: u.name || '',
        plan: u.plan || '',
        before,
        after,
        stripeStatus: analysis.status
      };

      if (dryRun) {
        synced.push({ ...entry, applied: false });
      } else {
        try {
          await patchUserFields(u.uid, fields, adminToken);
          synced.push({ ...entry, applied: true });
          console.log(`[admin-sync-billing] ✅ uid=${u.uid} billing=${after.billing} priceId=${after.stripePriceId}`);
        } catch (e) {
          errors.push({ uid: u.uid, email: u.email || '?', step: 'patch_firestore', error: e.message });
        }
      }
    }

    return res.status(200).json({
      ok: true,
      dryRun,
      generatedAt: new Date().toISOString(),
      summary: {
        totalUsers: users.length,
        candidatesWithSubscription: users.filter(u => u.stripeSubscriptionId).length,
        synced: synced.length,
        aligned: aligned.length,
        skipped: skipped.length,
        errors: errors.length
      },
      synced,
      aligned,
      skipped,
      errors
    });
  } catch (e) {
    console.error('[admin-sync-billing] ❌', e);
    return res.status(500).json({ error: 'Erreur serveur : ' + (e.message || 'unknown') });
  }
};

module.exports.config = { maxDuration: 60 };
