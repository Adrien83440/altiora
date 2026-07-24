// api/create-subscription-checkout.js
//
// Auth : optionnelle (Bearer token Firebase)
//   - Si token présent → vérifie et utilise l'uid vérifié dans les metadata Stripe
//   - Si pas de token  → pas d'uid dans les metadata (le webhook identifiera via customer email)

// ── Whitelist des priceId Stripe autorisés ──
const VALID_PRICES = [
  'price_1TGEKdRZYcAavmfvmuICL8yc',  // Pro mensuel 69€
  'price_1TGEMARZYcAavmfvvRkZnSap',  // Pro annuel 55€/mois
  'price_1TGENeRZYcAavmfvU4Oxr4cZ',  // Max mensuel 99€
  'price_1TGENeRZYcAavmfvm5Mao8Yi',  // Max annuel 79€/mois
  'price_1TGEOERZYcAavmfvY16T0pCS',  // Master mensuel 169€
  'price_1TGEOcRZYcAavmfvrOqqrjQu',  // Master annuel 135€/mois
];

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

// ══════════════════════════════════════════════════════════════════
// ÉLIGIBILITÉ ESSAI GRATUIT — décision SERVEUR (strict, anti-abus)
//
// Le flag `skipTrial` envoyé par le client ne peut que REFUSER l'essai,
// jamais l'accorder. L'octroi des 15 jours est décidé ici, à partir de
// l'historique réel du compte (Firebase + Stripe).
//
// On REFUSE l'essai si le compte a déjà bénéficié d'une période gratuite :
//   - promoCode / promoActivatedAt / promoEnd → promo interne déjà utilisée (ex OFFRE2MOIS)
//   - trialStart                              → essai Stripe déjà démarré par le passé
//   - stripeSubscriptionId                    → abonnement Stripe déjà lié
//   - trialEnd dans le passé                  → essai gratuit d'inscription déjà consommé
//   - (strict) le customer Stripe possède déjà ≥1 subscription (status=all)
//
// NB : login.html pose `trialEnd` SANS `trialStart` à l'inscription. Un
//      nouveau compte en cours d'essai gratuit (trialEnd futur, aucun autre
//      signal) reste éligible — on ne casse pas le parcours légitime.
//
// Fail-closed : doc illisible ou identité non vérifiée → REFUS.
// ══════════════════════════════════════════════════════════════════
const FIREBASE_PROJECT = 'altiora-70599';

// Lecture Firestore REST avec le token de l'utilisateur (rules : owner lit son users/{uid}).
async function fsGet(path, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + idToken } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('Firestore GET failed: ' + (await r.text()));
  return r.json();
}

// Extraction d'un champ Firestore REST.
function fv(doc, field) {
  const f = doc?.fields?.[field];
  if (!f) return null;
  return f.stringValue ?? f.integerValue ?? f.booleanValue ?? f.timestampValue ?? null;
}

// Id customer Stripe à partir de l'email.
async function findStripeCustomerId(stripeKey, email) {
  try {
    const r = await fetch(
      'https://api.stripe.com/v1/customers?limit=1&email=' + encodeURIComponent(email),
      { headers: { Authorization: 'Bearer ' + stripeKey } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    return d.data?.[0]?.id || null;
  } catch (e) {
    console.warn('[Checkout] findStripeCustomerId error:', e.message);
    return null;
  }
}

// True si le customer Stripe a déjà au moins une subscription (tous statuts).
async function stripeCustomerHasSubscription(stripeKey, customerId) {
  try {
    const r = await fetch(
      'https://api.stripe.com/v1/subscriptions?limit=1&status=all&customer=' + encodeURIComponent(customerId),
      { headers: { Authorization: 'Bearer ' + stripeKey } }
    );
    if (!r.ok) return false;
    const d = await r.json();
    return Array.isArray(d.data) && d.data.length > 0;
  } catch (e) {
    console.warn('[Checkout] stripeCustomerHasSubscription error:', e.message);
    return false;
  }
}

// Décision d'éligibilité (strict, fail-closed).
async function isTrialEligible(stripeKey, idToken, uid, email) {
  if (!idToken || !uid) return false; // identité non vérifiable → refus

  let userDoc;
  try {
    userDoc = await fsGet(`users/${uid}`, idToken);
  } catch (e) {
    console.warn('[Checkout] isTrialEligible: lecture user échouée → refus:', e.message);
    return false;
  }
  if (!userDoc) return false;

  const trialStart       = fv(userDoc, 'trialStart');
  const promoCode        = fv(userDoc, 'promoCode');
  const promoActivatedAt = fv(userDoc, 'promoActivatedAt');
  const promoEnd         = fv(userDoc, 'promoEnd');
  const subId            = fv(userDoc, 'stripeSubscriptionId');
  const trialEnd         = fv(userDoc, 'trialEnd');
  const custId           = fv(userDoc, 'stripeCustomerId');

  let trialExpired = false;
  if (trialEnd) {
    const te = new Date(trialEnd);
    trialExpired = !isNaN(te.getTime()) && te < new Date();
  }

  const firebaseClean =
    !trialStart && !promoCode && !promoActivatedAt && !promoEnd && !subId && !trialExpired;
  if (!firebaseClean) return false;

  // Strict : vérification croisée Stripe.
  const resolvedCust = custId || (email ? await findStripeCustomerId(stripeKey, email) : null);
  if (resolvedCust && (await stripeCustomerHasSubscription(stripeKey, resolvedCust))) {
    return false;
  }

  return true;
}

// ── Coupon filleul parrainage : -50% sur le 1er mois ──
// Utilise un coupon Stripe fixe (id = PARRAINAGE_FILLEUL_50), le crée s'il n'existe pas
const FILLEUL_COUPON_ID = 'PARRAINAGE_FILLEUL_50';

async function getOrCreateFilleulCoupon(stripeKey) {
  try {
    // 1. Vérifier si le coupon existe déjà
    const checkRes = await fetch(`https://api.stripe.com/v1/coupons/${FILLEUL_COUPON_ID}`, {
      headers: { Authorization: 'Bearer ' + stripeKey }
    });
    if (checkRes.ok) {
      const existing = await checkRes.json();
      if (!existing.deleted) return existing.id;
    }

    // 2. Le créer s'il n'existe pas
    const createRes = await fetch('https://api.stripe.com/v1/coupons', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + stripeKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        id: FILLEUL_COUPON_ID,
        percent_off: '50',
        duration: 'once',
        name: 'Parrainage filleul -50%',
        'metadata[type]': 'parrainage_filleul',
      }).toString()
    });
    const coupon = await createRes.json();
    if (coupon.id) return coupon.id;

    console.error('[Checkout] Erreur création coupon filleul:', coupon);
    return null;
  } catch (e) {
    console.error('[Checkout] getOrCreateFilleulCoupon error:', e);
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { priceId, plan, billing, skipTrial, referralCode, promoCode } = req.body || {};
  if (!priceId) return res.status(400).json({ error: 'priceId manquant' });

  // ── Vérification whitelist ──
  if (!VALID_PRICES.includes(priceId)) {
    return res.status(400).json({ error: 'Prix non autorisé' });
  }

  // ── Auth optionnelle : vérifier le token Firebase si présent ──
  let verifiedUid = null;
  let verifiedEmail = null;
  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (idToken) {
    const verified = await verifyFirebaseToken(idToken);
    if (verified) {
      verifiedUid = verified.uid;
      verifiedEmail = verified.email;
    }
  }

  // Fallback : utiliser uid/email du body uniquement si pas de token (rétrocompatibilité)
  const uid   = verifiedUid   || req.body?.uid   || null;
  const email = verifiedEmail || req.body?.email || null;

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const baseUrl = process.env.APP_URL || 'https://alteore.com';

  try {
    // ── Décision SERVEUR d'éligibilité à l'essai gratuit ──
    // skipTrial (client) ne peut que refuser ; l'octroi est tranché ici.
    let grantTrial = false;
    if (skipTrial !== true) {
      grantTrial = await isTrialEligible(stripeKey, idToken, uid, email);
      if (!grantTrial) {
        console.log(`[Checkout] Essai refusé (compte non éligible) uid=${uid || '?'} email=${email || '?'}`);
      }
    }

    // ── Si un code promo est fourni, le résoudre en promotion_code ID Stripe ──
    let promoId = null;
    if (promoCode) {
      const promoRes = await fetch(
        'https://api.stripe.com/v1/promotion_codes?code=' + encodeURIComponent(promoCode.trim().toUpperCase()) + '&active=true&limit=1',
        { headers: { Authorization: 'Bearer ' + stripeKey } }
      );
      const promoData = await promoRes.json();
      if (promoData.data && promoData.data.length > 0) {
        promoId = promoData.data[0].id;
      }
      // Si code invalide, on continue sans — le client pourra le retaper sur Stripe
    }

    // ── Code promo valide appliqué → on saute l'essai 15j ──
    // Le code fournit déjà la période gratuite (ex ELITE12 = 12 mois offerts).
    // Inutile d'empiler un essai Stripe par-dessus : ça afficherait « Essai »
    // au lieu du vrai plan et créerait de la confusion (cas vécu). En sautant
    // l'essai, la sub démarre en `active` (1ère facture 0€ couverte par le
    // coupon) → le webhook passe Firestore directement en max/master.
    if (promoId && grantTrial) {
      grantTrial = false;
      console.log('[Checkout] Essai 15j sauté : code promo appliqué (' + promoCode.trim().toUpperCase() + ')');
    }

    // ── Si un code parrainage est fourni, préparer le coupon filleul -50% ──
    let filleulCouponId = null;
    if (referralCode) {
      filleulCouponId = await getOrCreateFilleulCoupon(stripeKey);
      if (filleulCouponId) {
        console.log(`[Checkout] Coupon filleul ${filleulCouponId} appliqué pour parrainage ${referralCode}`);
      }
    }

    // ── Construire les discounts selon le cas ──
    //  - parrainage + promo → discounts[0]=coupon filleul, discounts[1]=promo
    //  - parrainage seul   → discounts[0]=coupon filleul
    //  - promo seul        → discounts[0]=promo
    //  - rien              → allow_promotion_codes libre
    const discountParams = {};
    if (filleulCouponId && promoId) {
      discountParams['discounts[0][coupon]'] = filleulCouponId;
      discountParams['discounts[1][promotion_code]'] = promoId;
    } else if (filleulCouponId) {
      discountParams['discounts[0][coupon]'] = filleulCouponId;
    } else if (promoId) {
      discountParams['discounts[0][promotion_code]'] = promoId;
    } else if (!grantTrial) {
      // Champ « code promo » de la page Stripe : uniquement HORS essai.
      // Le parcours site force déjà le skip de l'essai quand un code est
      // appliqué (voir plus haut) ; taper un code directement sur la page
      // Stripe pendant un essai contournait cette règle et permettait de
      // cumuler essai 15 jours + mois offerts du coupon.
      discountParams['allow_promotion_codes'] = 'true';
    }

    const params = {
      mode: 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'automatic_tax[enabled]': 'true',
      ...(grantTrial ? { 'subscription_data[trial_period_days]': '15' } : {}),
      // ── CB TOUJOURS collectée (fix 24/07/2026) ──
      // 'if_required' laissait Stripe SAUTER la saisie de carte dès que le dû
      // du jour était 0 € (essai 15 jours, code promo 100%) → subscriptions
      // sans aucun moyen de paiement, impossibles à facturer en fin d'essai
      // (constaté en prod : clients en trial Master/Pro sans carte).
      // 'always' = la carte est enregistrée via SetupIntent même à 0 € dû ;
      // Stripe affiche « 0,00 € dû aujourd'hui » puis débite automatiquement
      // à la fin de l'essai (ou à la 1re facture non couverte par un coupon).
      'payment_method_collection': 'always',
      ...discountParams,
      success_url: baseUrl + '/dashboard.html?subscription=success&plan=' + plan,
      cancel_url: baseUrl + '/pricing.html?cancelled=1',
      'metadata[plan]': plan,
      'metadata[billing]': billing || 'monthly',
      ...(uid ? { 'metadata[uid]': uid } : {}),
      ...(email ? { customer_email: email } : {}),
      ...(referralCode ? { 'metadata[referralCode]': referralCode.toUpperCase().trim() } : {}),
      // Copier les metadata sur la subscription (accessibles dans invoice.payment_succeeded)
      ...(uid ? { 'subscription_data[metadata][uid]': uid } : {}),
      'subscription_data[metadata][plan]': plan,
      'subscription_data[metadata][billing]': billing || 'monthly',
      ...(referralCode ? { 'subscription_data[metadata][referralCode]': referralCode.toUpperCase().trim() } : {}),
    };

    const res2 = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + stripeKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString()
    });

    const session = await res2.json();
    if (session.url) {
      return res.status(200).json({ url: session.url });
    } else {
      console.error('Stripe error:', session);
      return res.status(500).json({ error: session.error?.message || 'Erreur Stripe' });
    }
  } catch(e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
