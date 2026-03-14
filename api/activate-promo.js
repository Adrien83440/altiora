// api/activate-promo.js
// ══════════════════════════════════════════════════════════════════
// Activation d'un code promo — offre commerciale
//
// POST { promoCode: 'OFFRE2MOIS' }
// Headers: Authorization: Bearer <Firebase ID Token>
//
// Résultat : plan = 'master', promoEnd = now + durée définie
//
// Utilise l'API REST Firestore (pas Admin SDK) — même pattern que
// apply-referral.js et stripe-subscription-webhook.js
// ══════════════════════════════════════════════════════════════════

const FIREBASE_PROJECT = 'altiora-70599';
const FB_KEY_DEFAULT   = 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';

function fbKey() {
  return process.env.FIREBASE_API_KEY || FB_KEY_DEFAULT;
}

// ══════════════════════════════════════════════════════════════════
// CODES PROMO VALIDES
// ══════════════════════════════════════════════════════════════════
const PROMO_CODES = {
  'OFFRE2MOIS': {
    plan: 'master',
    durationDays: 60,
    label: 'Offre découverte 2 mois',
    maxUses: 0,
    active: true,
  },
};

// ── Vérifier un token Firebase et retourner l'uid ──
async function verifyFirebaseToken(idToken) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${fbKey()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.users?.[0]?.localId || null;
}

// ── Lecture d'un document Firestore via REST ──
async function fsGet(path) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?key=${fbKey()}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Firestore GET failed: ' + await res.text());
  return res.json();
}

// ── Écriture (merge) d'un document Firestore via REST ──
async function fsSet(path, fields) {
  const firestoreFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string')       firestoreFields[k] = { stringValue: v };
    else if (typeof v === 'number')  firestoreFields[k] = { integerValue: String(v) };
    else if (typeof v === 'boolean') firestoreFields[k] = { booleanValue: v };
    else if (v === null)             firestoreFields[k] = { nullValue: null };
    else                             firestoreFields[k] = { stringValue: String(v) };
  }
  const updateMask = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?${updateMask}&key=${fbKey()}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: firestoreFields })
  });
  if (!res.ok) throw new Error('Firestore PATCH failed: ' + await res.text());
  return res.json();
}

// ── Extraire une valeur d'un champ Firestore REST ──
function fv(doc, field) {
  const f = doc?.fields?.[field];
  return f?.stringValue ?? f?.integerValue ?? f?.booleanValue ?? null;
}

// ── CORS ──
const ALLOWED_ORIGIN = 'https://alteore.com';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    // ── 1. Authentification Firebase ──
    const authHeader = req.headers['authorization'] || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) {
      return res.status(401).json({ error: 'Non authentifié. Connectez-vous d\'abord.' });
    }

    const uid = await verifyFirebaseToken(idToken);
    if (!uid) {
      return res.status(401).json({ error: 'Token invalide ou expiré.' });
    }

    // ── 2. Valider le code promo ──
    const { promoCode } = req.body || {};
    if (!promoCode || typeof promoCode !== 'string') {
      return res.status(400).json({ error: 'Code promo manquant.' });
    }

    const code = promoCode.trim().toUpperCase();
    const promoDef = PROMO_CODES[code];
    if (!promoDef || !promoDef.active) {
      return res.status(400).json({ error: 'Code promo invalide ou expiré.' });
    }

    // ── 3. Vérifier l'utilisateur ──
    const userDoc = await fsGet(`users/${uid}`);
    if (!userDoc) {
      return res.status(404).json({ error: 'Compte utilisateur introuvable.' });
    }

    // Vérifier qu'il n'a pas déjà un abonnement Stripe actif
    const subStatus = fv(userDoc, 'subscriptionStatus');
    const subId = fv(userDoc, 'stripeSubscriptionId');
    if (subId && ['active', 'trialing'].includes(subStatus)) {
      return res.status(400).json({ error: 'Vous avez déjà un abonnement actif. Le code promo n\'est pas nécessaire.' });
    }

    // Vérifier qu'il n'a pas déjà utilisé ce code
    const existingCode = fv(userDoc, 'promoCode');
    const existingEnd = fv(userDoc, 'promoEnd');
    if (existingCode === code && existingEnd) {
      return res.status(400).json({ error: 'Vous avez déjà utilisé ce code promo.' });
    }

    // Vérifier qu'il n'a pas déjà une promo active (autre code)
    if (existingEnd) {
      const promoEnd = new Date(existingEnd);
      if (!isNaN(promoEnd.getTime()) && promoEnd > new Date()) {
        return res.status(400).json({ error: 'Vous bénéficiez déjà d\'une offre en cours.' });
      }
    }

    // ── 4. Activer la promo ──
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + promoDef.durationDays);

    const updateData = {
      plan: promoDef.plan,
      promoCode: code,
      promoLabel: promoDef.label,
      promoActivatedAt: now.toISOString(),
      promoEnd: end.toISOString(),
    };

    // Si l'utilisateur était en trial, on conserve l'info
    const currentPlan = fv(userDoc, 'plan');
    const trialEnd = fv(userDoc, 'trialEnd');
    if (currentPlan === 'trial' && trialEnd) {
      updateData.previousPlan = 'trial';
      updateData.previousTrialEnd = trialEnd;
    }

    await fsSet(`users/${uid}`, updateData);

    console.log(`[activate-promo] ✅ ${uid} → ${promoDef.plan} via code ${code} (expire ${end.toISOString()})`);

    return res.status(200).json({
      ok: true,
      plan: promoDef.plan,
      promoEnd: end.toISOString(),
      label: promoDef.label,
      durationDays: promoDef.durationDays,
    });

  } catch (e) {
    console.error('[activate-promo] ❌ Erreur serveur:', e);
    return res.status(500).json({ error: 'Erreur serveur : ' + e.message });
  }
};
