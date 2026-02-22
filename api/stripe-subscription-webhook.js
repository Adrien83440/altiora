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
  'price_1T3gqlGSYbSgNdWwlr6RX92r': 'pro',     // Pro mensuel
  'price_1T3gveGSYbSgNdWwot2e5YpG': 'pro',     // Pro annuel
  'price_1T3gtkGSYbSgNdWw81ff10tt': 'max',     // Max mensuel
  'price_1T3gwGGSYbSgNdWw1ptpHTDB': 'max',     // Max annuel
  'price_1T3guhGSYbSgNdWwtKX6EFuy': 'master',  // Master mensuel
  'price_1T3gwsGSYbSgNdWwezlggjJR': 'master',  // Master annuel
};

function getPlanFromSubscription(subscription) {
  const priceId = subscription?.items?.data?.[0]?.price?.id;
  return PRICE_TO_PLAN[priceId] || null;
}

// ── Mise à jour Firestore via REST API ──
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

  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': fbKey },
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
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents:runQuery?key=${fbKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
        // Récupérer les détails de la subscription pour la date de fin de trial
        let trialEnd = null;
        if (subscriptionId && stripeKey) {
          const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
            headers: { Authorization: 'Bearer ' + stripeKey }
          });
          const sub = await subRes.json();
          if (sub.trial_end) trialEnd = new Date(sub.trial_end * 1000).toISOString().split('T')[0];
        }

        await updateFirestore(uid, {
          plan:                 'trial',
          stripeCustomerId:     customerId,
          stripeSubscriptionId: subscriptionId || '',
          trialStart:           new Date().toISOString().split('T')[0],
          ...(trialEnd ? { trialEnd } : {}),
          pendingPlan:          plan,  // plan qui s'activera après le trial
        });

        console.log(`[Webhook] Trial démarré pour uid=${uid} plan=${plan}`);
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

      const plan = getPlanFromSubscription(sub);
      if (!plan) { console.warn('[Webhook] plan non reconnu pour sub:', sub.id); return res.status(200).end(); }

      let newPlan = plan;
      // Si le trial vient de se terminer → activer le vrai plan
      if (sub.status === 'active' && !sub.trial_end) newPlan = plan;
      else if (sub.status === 'trialing')             newPlan = 'trial';
      else if (sub.status === 'past_due')             newPlan = 'past_due';
      else if (sub.status === 'canceled')             newPlan = 'free';
      else if (sub.status === 'active')               newPlan = plan;

      await updateFirestore(uid, {
        plan:                 newPlan,
        stripeSubscriptionId: sub.id,
        subscriptionStatus:   sub.status,
        ...(plan !== 'trial' ? { pendingPlan: '' } : {}),
      });

      console.log(`[Webhook] Subscription updated uid=${uid} plan=${newPlan} status=${sub.status}`);
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
      });

      console.log(`[Webhook] Subscription annulée uid=${uid}`);
    }

    // ════════════════════════════════════════════
    // 4. invoice.payment_succeeded
    //    → Paiement OK → activer le plan
    // ════════════════════════════════════════════
    else if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;
      // Ignorer les invoices de trial (montant = 0)
      if (invoice.amount_paid === 0) return res.status(200).end();

      const uid = await getUidFromCustomer(invoice.customer);
      if (!uid) return res.status(200).end();

      // Récupérer la subscription pour connaître le plan
      let plan = null;
      if (invoice.subscription && stripeKey) {
        const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${invoice.subscription}`, {
          headers: { Authorization: 'Bearer ' + stripeKey }
        });
        const sub = await subRes.json();
        plan = getPlanFromSubscription(sub);
      }

      if (plan) {
        await updateFirestore(uid, {
          plan:               plan,
          subscriptionStatus: 'active',
          lastPayment:        new Date().toISOString().split('T')[0],
          pendingPlan:        '',
        });
        console.log(`[Webhook] Paiement OK uid=${uid} plan=${plan}`);
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

      await updateFirestore(uid, {
        plan:               'past_due',
        subscriptionStatus: 'past_due',
      });

      console.log(`[Webhook] Paiement échoué uid=${uid}`);
    }

    return res.status(200).json({ received: true });

  } catch (e) {
    console.error('[Webhook] Erreur:', e);
    return res.status(500).json({ error: e.message });
  }
};
