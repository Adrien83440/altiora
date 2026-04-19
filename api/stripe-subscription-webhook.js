// api/stripe-subscription-webhook.js
// Webhook Stripe → met à jour le plan dans Firebase Firestore
//
// Événements gérés :
//   checkout.session.completed        → trial démarré, lier customer ↔ uid
//   customer.subscription.updated     → upgrade / downgrade / reprise
//   customer.subscription.deleted     → annulation → plan = 'free'
//   invoice.payment_succeeded         → paiement ok → confirmer plan actif
//   invoice.payment_failed            → échec paiement → plan = 'past_due'

const FIREBASE_PROJECT = 'altiora-70599';

// ── Déterminer le plan depuis le priceId Stripe ──
const PRICE_TO_PLAN = {
  'price_1TGEKdRZYcAavmfvmuICL8yc': 'pro',     // Pro mensuel
  'price_1TGEMARZYcAavmfvvRkZnSap': 'pro',     // Pro annuel
  'price_1TGENeRZYcAavmfvU4Oxr4cZ': 'max',     // Max mensuel
  'price_1TGENeRZYcAavmfvm5Mao8Yi': 'max',     // Max annuel
  'price_1TGEOERZYcAavmfvY16T0pCS': 'master',  // Master mensuel
  'price_1TGEOcRZYcAavmfvrOqqrjQu': 'master',  // Master annuel
};

// ── Price IDs de l'addon Léa (via env vars pour rester flexibles) ──
// STRIPE_PRICE_ADDON_LEA_MONTHLY = price_1TNpWsRZYcAavmfvtTd2vcqy
// STRIPE_PRICE_ADDON_LEA_YEARLY  = price_1TNpWsRZYcAavmfvbbHtMCFX
function getAgentPriceIds() {
  return [
    process.env.STRIPE_PRICE_ADDON_LEA_MONTHLY,
    process.env.STRIPE_PRICE_ADDON_LEA_YEARLY,
  ].filter(Boolean);
}

// ── Analyser les items d'une subscription (plan principal + addon Léa) ──
// Une sub peut contenir 1 item (plan seul) ou 2 items (plan + addon Léa).
function analyzeSubscriptionItems(subscription) {
  const items = subscription?.items?.data || [];
  const agentPriceIds = getAgentPriceIds();
  let planItem = null;
  let agentItem = null;

  for (const item of items) {
    const priceId = item?.price?.id;
    if (!priceId) continue;
    if (agentPriceIds.includes(priceId)) {
      agentItem = item;
    } else if (PRICE_TO_PLAN[priceId]) {
      planItem = item;
    }
  }

  return {
    plan: planItem ? PRICE_TO_PLAN[planItem.price.id] : null,
    planSubscriptionItemId: planItem?.id || '',
    agentEnabled: !!agentItem,
    agentSubscriptionItemId: agentItem?.id || '',
    agentPriceId: agentItem?.price?.id || '',
  };
}

// Conservé pour rétro-compat (utilisé dans tout le fichier) :
function getPlanFromSubscription(subscription) {
  return analyzeSubscriptionItems(subscription).plan;
}

// ── Cache du token admin Firebase ──
let _adminToken = null;
let _adminTokenExp = 0;

async function getAdminToken() {
  // Réutiliser le token s'il est encore valide (marge de 5 min)
  if (_adminToken && Date.now() < _adminTokenExp - 300000) return _adminToken;

  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
  const email = process.env.FIREBASE_API_EMAIL;
  const password = process.env.FIREBASE_API_PASSWORD;

  if (!email || !password) {
    console.warn('[Webhook] FIREBASE_API_EMAIL ou FIREBASE_API_PASSWORD manquant — fallback API key');
    return null;
  }

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
  console.error('[Webhook] Admin login failed:', data.error?.message);
  return null;
}

// ── Mise à jour Firestore via REST API (authentifié) ──
async function updateFirestore(uid, fields) {
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/users/${uid}?updateMask.fieldPaths=${Object.keys(fields).join('&updateMask.fieldPaths=')}`;

  // Convertir les champs en format Firestore
  const firestoreFields = {};
  for (const [key, val] of Object.entries(fields)) {
    if (typeof val === 'string')       firestoreFields[key] = { stringValue: val };
    else if (typeof val === 'number')  firestoreFields[key] = { integerValue: val };
    else if (typeof val === 'boolean') firestoreFields[key] = { booleanValue: val };
    else if (val === null)             firestoreFields[key] = { nullValue: null };
    else                               firestoreFields[key] = { stringValue: String(val) };
  }

  // Authentification admin
  const token = await getAdminToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  } else {
    headers['x-goog-api-key'] = fbKey;
  }

  const res = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields: firestoreFields })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Firestore PATCH failed: ' + err);
  }
  return res.json();
}

// ── Récupérer uid depuis customerId (via Firestore query) ──
async function getUidFromCustomer(customerId) {
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents:runQuery`;

  const token = await getAdminToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const res = await fetch(url + (token ? '' : '?key=' + fbKey), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'users' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'stripeCustomerId' },
            op: 'EQUAL',
            value: { stringValue: customerId }
          }
        },
        limit: 1
      }
    })
  });

  const results = await res.json();
  const doc = results?.[0]?.document;
  if (!doc) return null;
  // L'uid est la dernière partie du path: projects/.../documents/users/{uid}
  return doc.name.split('/').pop();
}

// ── Lecture Firestore REST ──
async function fsGet(path) {
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`;
  const token = await getAdminToken();
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url + (token ? '' : '?key=' + fbKey), { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Firestore GET: ' + await res.text());
  return res.json();
}

function fv(doc, field) {
  const f = doc?.fields?.[field];
  return f?.stringValue ?? f?.integerValue ?? f?.booleanValue ?? null;
}

// ── Incrémenter un champ numérique dans Firestore (sans transaction SDK) ──
async function fsIncrement(path, field, delta) {
  const doc = await fsGet(path);
  const current = parseInt(fv(doc, field) || 0);
  await updateFirestore(path.replace(`users/`, ''), { [field]: current + delta });
}

// ── Récompenser le parrain : applique un coupon 50% one-time sur son abonnement Stripe ──
async function rewardParrain(parrainUid, filleulUid, referralCode, stripeKey) {
  try {
    // 1. Récupérer le stripeCustomerId du parrain
    const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
    const parrainDoc = await fsGet(`users/${parrainUid}`);
    const customerId = fv(parrainDoc, 'stripeCustomerId');
    const subscriptionId = fv(parrainDoc, 'stripeSubscriptionId');

    if (!customerId || !subscriptionId) {
      console.warn(`[Referral] Parrain ${parrainUid} n'a pas de subscription active — récompense ignorée`);
      return;
    }

    // 2. Créer un coupon Stripe 50% once
    const couponParams = new URLSearchParams({
      percent_off: '50',
      duration: 'once',
      name: `Parrainage ${referralCode}`,
      metadata: JSON.stringify({ type: 'parrainage', parrainUid, filleulUid, referralCode }),
    });
    // Stripe n'accepte pas JSON dans metadata via form-encoded, on l'envoie champ par champ
    const couponBody = new URLSearchParams({
      percent_off: '50',
      duration: 'once',
      name: `Parrainage ${referralCode}`,
      'metadata[type]': 'parrainage',
      'metadata[parrainUid]': parrainUid,
      'metadata[filleulUid]': filleulUid,
      'metadata[referralCode]': referralCode,
    });

    const couponRes = await fetch('https://api.stripe.com/v1/coupons', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + stripeKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: couponBody.toString()
    });
    const coupon = await couponRes.json();
    if (!coupon.id) {
      console.error('[Referral] Erreur création coupon:', coupon);
      return;
    }

    // 3. Appliquer le coupon sur l'abonnement du parrain via discounts (compatible billing_mode=flexible)
    const subUpdateRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + stripeKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ 'discounts[0][coupon]': coupon.id }).toString()
    });
    const updatedSub = await subUpdateRes.json();
    if (updatedSub.error) {
      console.error('[Referral] Erreur application coupon:', updatedSub.error);
      return;
    }

    // 4. Mettre à jour Firestore : statut de l'utilisation + compteurs parrain
    const now = new Date().toISOString();

    // Helper : écriture Firestore authentifiée pour n'importe quel path
    const fsSetAdmin = async (path, fields) => {
      const token = await getAdminToken();
      const firestoreFields = {};
      for (const [k, v] of Object.entries(fields)) {
        if (typeof v === 'string')      firestoreFields[k] = { stringValue: v };
        else if (typeof v === 'number') firestoreFields[k] = { integerValue: String(v) };
        else if (v === null)            firestoreFields[k] = { nullValue: null };
        else                            firestoreFields[k] = { stringValue: String(v) };
      }
      const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join('&');
      const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?${mask}`;
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const r = await fetch(url, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ fields: firestoreFields })
      });
      if (!r.ok) throw new Error('fsSetAdmin failed on ' + path + ': ' + await r.text());
    };

    // Marquer l'utilisation comme récompensée
    await fsSetAdmin(`referrals/${referralCode}/uses/${filleulUid}`, {
      status: 'rewarded',
      rewardedAt: now,
      stripeCouponId: coupon.id,
    });

    // Incrémenter le compteur de récompenses du parrain
    const currentRewards = parseInt(fv(parrainDoc, 'referralRewards') || 0);
    await updateFirestore(parrainUid, {
      referralRewards: currentRewards + 1,
    });

    // Incrémenter totalRewarded sur le document referrals/{code}
    const refDoc = await fsGet(`referrals/${referralCode}`);
    const currentRewarded = parseInt(fv(refDoc, 'totalRewarded') || 0);
    await fsSetAdmin(`referrals/${referralCode}`, {
      totalRewarded: currentRewarded + 1,
    });

    console.log(`[Referral] ✅ Parrain récompensé: uid=${parrainUid} coupon=${coupon.id} (−50% prochaine échéance)`);

  } catch (e) {
    // Non bloquant : logguer l'erreur mais ne pas faire échouer le webhook
    console.error('[Referral] Erreur rewardParrain:', e);
  }
}

// ── Handler principal ──
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET_SUBS;
  const stripeKey     = process.env.STRIPE_SECRET_KEY;

  // Récupérer le body brut pour vérification de signature
  let rawBody = '';
  try {
    rawBody = await new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  } catch (e) {
    return res.status(400).json({ error: 'Cannot read body' });
  }

  // ── Vérification signature Stripe ──
  if (webhookSecret) {
    const sigHeader = req.headers['stripe-signature'];
    if (!sigHeader) return res.status(400).json({ error: 'Signature manquante' });

    try {
      // Vérification manuelle HMAC-SHA256 (sans SDK Stripe)
      const crypto = require('crypto');
      const parts = sigHeader.split(',').reduce((acc, part) => {
        const [k, v] = part.split('=');
        acc[k] = v;
        return acc;
      }, {});

      const timestamp = parts.t;
      const signature = parts.v1;
      const payload   = timestamp + '.' + rawBody;
      const expected  = crypto.createHmac('sha256', webhookSecret).update(payload).digest('hex');

      if (expected !== signature) {
        return res.status(400).json({ error: 'Signature invalide' });
      }

      // Rejeter les événements trop vieux (> 5 min)
      if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) {
        return res.status(400).json({ error: 'Événement trop ancien' });
      }
    } catch (e) {
      return res.status(400).json({ error: 'Erreur vérification signature: ' + e.message });
    }
  }

  // Parser l'événement
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).json({ error: 'JSON invalide' });
  }

  console.log(`[Stripe Webhook] ${event.type}`);

  try {
    // ════════════════════════════════════════════
    // 1. checkout.session.completed
    //    → Trial démarré, on lie customerId ↔ uid
    // ════════════════════════════════════════════
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const uid = session.metadata?.uid;
      const customerId = session.customer;
      const subscriptionId = session.subscription;
      const plan = session.metadata?.plan || 'pro';

      if (uid && customerId) {
        // Récupérer les détails de la subscription
        let trialEnd = null;
        let subStatus = 'trialing';
        let agentFields = {};
        if (subscriptionId && stripeKey) {
          const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
            headers: { Authorization: 'Bearer ' + stripeKey }
          });
          const sub = await subRes.json();
          if (sub.trial_end) trialEnd = new Date(sub.trial_end * 1000).toISOString().split('T')[0];
          subStatus = sub.status || 'trialing';

          // Analyser les items pour détecter l'addon Léa (si paiement direct avec 2 items)
          const analysis = analyzeSubscriptionItems(sub);
          if (analysis.agentEnabled) {
            agentFields = {
              agentEnabled:              true,
              agentAddonStatus:          'active',
              agentSubscriptionItemId:   analysis.agentSubscriptionItemId,
              agentActivatedAt:          new Date().toISOString(),
              agentDegradedMode:         false,
            };
          }
        }

        // Si pas de trial (abonnement direct) → plan actif immédiatement
        const isTrial = subStatus === 'trialing';
        const activePlan = isTrial ? 'trial' : plan;

        await updateFirestore(uid, {
          plan:                 activePlan,
          stripeCustomerId:     customerId,
          stripeSubscriptionId: subscriptionId || '',
          ...(isTrial ? { trialStart: new Date().toISOString().split('T')[0] } : {}),
          ...(isTrial && trialEnd ? { trialEnd } : {}),
          ...(isTrial ? { pendingPlan: plan } : { pendingPlan: '' }),
          subscriptionStatus:   subStatus,
          ...agentFields,
        });

        console.log(`[Webhook] checkout.session.completed uid=${uid} plan=${activePlan} status=${subStatus}`);

        // Envoyer l'email de bienvenue adapté (trial ou payé)
        if (!isTrial) {
          try {
            const appUrl = process.env.APP_URL || 'https://alteore.com';
            await fetch(appUrl + '/api/send-welcome', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                email: session.customer_email || session.customer_details?.email,
                name: session.customer_details?.name || '',
                plan: activePlan,
                billing: session.metadata?.billing || '',
                source: session.metadata?.referralCode ? 'parrainage' : 'direct'
              })
            });
          } catch(emailErr) { console.warn('[Webhook] Email welcome failed:', emailErr.message); }

          // ── PARRAINAGE : récompenser le parrain si paiement immédiat (pas trial) ──
          try {
            const filleulDoc = await fsGet(`users/${uid}`);
            const refCode   = fv(filleulDoc, 'referralCode');
            const parrainId = fv(filleulDoc, 'parrainedBy');
            console.log(`[Referral] checkout: uid=${uid} refCode=${refCode} parrainId=${parrainId}`);

            if (refCode && parrainId) {
              const useDoc = await fsGet(`referrals/${refCode}/uses/${uid}`);
              const useStatus = fv(useDoc, 'status');
              console.log(`[Referral] useDoc status=${useStatus}`);
              if (useStatus === 'pending') {
                await rewardParrain(parrainId, uid, refCode, stripeKey);
                console.log(`[Referral] ✅ Parrain récompensé depuis checkout.session.completed`);
              }
            }
          } catch(refErr) {
            console.error('[Referral] Erreur dans checkout:', refErr.message);
          }
        }
      }
    }

    // ════════════════════════════════════════════
    // 2. customer.subscription.updated
    //    → Upgrade / downgrade / fin de trial / reprise
    // ════════════════════════════════════════════
    else if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const customerId = sub.customer;
      const uid = await getUidFromCustomer(customerId);
      if (!uid) { console.warn('[Webhook] uid non trouvé pour customer:', customerId); return res.status(200).end(); }

      const analysis = analyzeSubscriptionItems(sub);
      const plan = analysis.plan;

      // Si plus aucun plan reconnu (cas théorique : il ne reste que l'item Léa tout seul,
      // ce qui ne devrait jamais arriver vu qu'on force un plan pour avoir Léa), on log et on sort
      if (!plan) { console.warn('[Webhook] plan non reconnu pour sub:', sub.id, 'items=', (sub.items?.data||[]).map(i=>i.price?.id)); return res.status(200).end(); }

      let newPlan = plan;
      if (sub.status === 'trialing')             newPlan = 'trial';
      else if (sub.status === 'active')          newPlan = plan;
      else if (sub.status === 'past_due')        newPlan = 'past_due';
      else if (sub.status === 'canceled')        newPlan = 'free';
      else if (sub.status === 'incomplete')      newPlan = 'trial'; // CB pas encore fournie
      else if (sub.status === 'incomplete_expired') newPlan = 'free'; // jamais fourni la CB

      // ── Gestion addon Léa ──
      // Lire l'état précédent pour détecter transitions (activation / désactivation)
      const prevUserDoc = await fsGet(`users/${uid}`);
      const wasAgentEnabled = fv(prevUserDoc, 'agentEnabled') === true;
      const nowAgentEnabled = analysis.agentEnabled && ['active','trialing','past_due'].includes(sub.status);

      const agentFields = {};
      if (nowAgentEnabled) {
        // Addon présent et sub active → Léa active
        agentFields.agentEnabled            = true;
        agentFields.agentAddonStatus        = sub.status === 'past_due' ? 'past_due' : 'active';
        agentFields.agentSubscriptionItemId = analysis.agentSubscriptionItemId;
        agentFields.agentDegradedMode       = false;
        if (!wasAgentEnabled) {
          agentFields.agentActivatedAt = new Date().toISOString();
        }
      } else if (wasAgentEnabled && !analysis.agentEnabled) {
        // Item Léa retiré de la sub → désactivation
        agentFields.agentEnabled          = false;
        agentFields.agentAddonStatus      = 'canceled';
        agentFields.agentCanceledAt       = new Date().toISOString();
        agentFields.agentSubscriptionItemId = '';
        // Le mode dégradé sera géré par le cron trial-check à J15, pas ici
      } else if (wasAgentEnabled && sub.status === 'canceled') {
        // Sub entière annulée → Léa aussi
        agentFields.agentEnabled          = false;
        agentFields.agentAddonStatus      = 'canceled';
        agentFields.agentCanceledAt       = new Date().toISOString();
      }

      await updateFirestore(uid, {
        plan:                 newPlan,
        stripeSubscriptionId: sub.id,
        subscriptionStatus:   sub.status,
        ...(newPlan !== 'trial' ? { pendingPlan: '' } : {}),
        ...agentFields,
      });

      console.log(`[Webhook] Subscription updated uid=${uid} plan=${newPlan} status=${sub.status} agent=${nowAgentEnabled}`);
    }

    // ════════════════════════════════════════════
    // 3. customer.subscription.deleted
    //    → Annulation → plan = 'free'
    // ════════════════════════════════════════════
    else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const uid = await getUidFromCustomer(sub.customer);
      if (!uid) return res.status(200).end();

      await updateFirestore(uid, {
        plan:               'free',
        subscriptionStatus: 'canceled',
        stripeSubscriptionId: '',
        agentEnabled:       false,
        agentAddonStatus:   'canceled',
        agentCanceledAt:    new Date().toISOString(),
        agentSubscriptionItemId: '',
      });

      console.log(`[Webhook] Subscription annulée uid=${uid} (plan + addon Léa)`);
    }

    // ════════════════════════════════════════════
    // 4. invoice.payment_succeeded
    //    → Paiement OK → activer le plan
    //    Note : amount_paid peut être 0 avec un coupon (2 mois offerts) — on active quand même
    // ════════════════════════════════════════════
    else if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;

      // Compatibilité Stripe API 2026-03-25.dahlia : subscription peut être au 1er niveau ou sous parent.subscription_details
      const invoiceSubscriptionId = invoice.subscription || invoice.parent?.subscription_details?.subscription || null;

      // Ignorer uniquement les invoices de trial pur (sans subscription, montant 0 et billing_reason = subscription_create)
      const isFreeTrialInvoice = invoice.amount_paid === 0
        && invoice.billing_reason === 'subscription_create'
        && !invoice.discount;
      if (isFreeTrialInvoice) {
        console.log('[Webhook] Invoice trial ignorée (pas de coupon, montant 0)');
        return res.status(200).end();
      }

      // Trouver l'uid : d'abord par stripeCustomerId, sinon par metadata de la subscription
      let uid = await getUidFromCustomer(invoice.customer);

      // Fallback : si la query Firestore ne trouve pas encore le customer (race condition avec checkout.session.completed)
      if (!uid && invoiceSubscriptionId && stripeKey) {
        try {
          const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${invoiceSubscriptionId}`, {
            headers: { Authorization: 'Bearer ' + stripeKey }
          });
          const sub = await subRes.json();
          uid = sub.metadata?.uid || null;
          if (uid) console.log(`[Webhook] uid récupéré depuis metadata subscription: ${uid}`);
        } catch(e) {}
      }

      if (!uid) {
        console.warn('[Webhook] invoice.payment_succeeded: uid introuvable pour customer', invoice.customer);
        return res.status(200).end();
      }

      console.log(`[Webhook] invoice.payment_succeeded: uid=${uid} invoiceSubId=${invoiceSubscriptionId} customer=${invoice.customer}`);

      // Récupérer la subscription pour connaître le plan
      let plan = null;
      let agentFields = {};
      if (invoiceSubscriptionId && stripeKey) {
        const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${invoiceSubscriptionId}`, {
          headers: { Authorization: 'Bearer ' + stripeKey }
        });
        const sub = await subRes.json();
        const analysis = analyzeSubscriptionItems(sub);
        plan = analysis.plan;
        if (!plan) console.warn(`[Webhook] getPlanFromSubscription returned null. priceId=${sub?.items?.data?.[0]?.price?.id}, sub.plan=${sub?.plan?.id}`);

        // Gestion addon Léa : on synchronise à chaque paiement
        const prevUserDoc = await fsGet(`users/${uid}`);
        const wasAgentEnabled = fv(prevUserDoc, 'agentEnabled') === true;

        if (analysis.agentEnabled) {
          agentFields = {
            agentEnabled:              true,
            agentAddonStatus:          'active',
            agentSubscriptionItemId:   analysis.agentSubscriptionItemId,
            agentDegradedMode:         false,
          };
          if (!wasAgentEnabled) {
            agentFields.agentActivatedAt = new Date().toISOString();
          }
        }
      } else {
        console.warn(`[Webhook] Skipping subscription fetch: invoiceSubId=${invoiceSubscriptionId} stripeKey=${!!stripeKey}`);
      }

      if (plan) {
        await updateFirestore(uid, {
          plan:               plan,
          subscriptionStatus: 'active',
          lastPayment:        new Date().toISOString().split('T')[0],
          pendingPlan:        '',
          ...agentFields,
        });
        console.log(`[Webhook] Paiement OK uid=${uid} plan=${plan} montant=${invoice.amount_paid} agent=${!!agentFields.agentEnabled}`);

        // ── PARRAINAGE : récompenser le parrain à la 1ère vraie facture du filleul ──
        // On ne récompense que sur billing_reason = 'subscription_create' ou 'subscription_cycle'
        // et seulement si le filleul a un code de parrainage et que le statut est encore 'pending'
        try {
          const filleulDoc = await fsGet(`users/${uid}`);
          const referralCode = fv(filleulDoc, 'referralCode');
          const parrainUid   = fv(filleulDoc, 'parrainedBy');

          if (referralCode && parrainUid) {
            // Vérifier que la récompense n'a pas déjà été donnée
            const useDoc = await fsGet(`referrals/${referralCode}/uses/${uid}`);
            const status = fv(useDoc, 'status');
            if (status === 'pending') {
              await rewardParrain(parrainUid, uid, referralCode, stripeKey);
            }
          }
        } catch (refErr) {
          console.error('[Webhook] Erreur vérification parrainage:', refErr);
          // Non bloquant
        }
      }
    }

    // ════════════════════════════════════════════
    // 5. invoice.payment_failed
    //    → Échec paiement → avertir
    // ════════════════════════════════════════════
    else if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const uid = await getUidFromCustomer(invoice.customer);
      if (!uid) return res.status(200).end();

      // Si un addon Léa est actif, on le passe aussi en past_due (pas de désactivation,
      // Stripe fera ses 3 tentatives avant subscription.deleted)
      const prevUserDoc = await fsGet(`users/${uid}`);
      const hadAgent = fv(prevUserDoc, 'agentEnabled') === true;

      await updateFirestore(uid, {
        plan:               'past_due',
        subscriptionStatus: 'past_due',
        ...(hadAgent ? { agentAddonStatus: 'past_due' } : {}),
      });

      console.log(`[Webhook] Paiement échoué uid=${uid} agentHad=${hadAgent}`);
    }

    return res.status(200).json({ received: true });

  } catch (e) {
    console.error('[Webhook] Erreur:', e);
    return res.status(500).json({ error: e.message });
  }
};

// ── Vercel : désactiver le bodyParser pour lire le rawBody (signature Stripe) ──
module.exports.config = {
  api: { bodyParser: false }
};
