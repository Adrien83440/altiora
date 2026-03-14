// api/activate-promo.js
// ══════════════════════════════════════════════════════════════════
// Validation d'un code promo — retourne les infos si valide
// L'écriture Firestore se fait côté client (déjà authentifié)
//
// POST { promoCode: 'OFFRE2MOIS' }
// Headers: Authorization: Bearer <Firebase ID Token>
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

// ── Vérifier un token Firebase → uid ──
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

// ── Lecture Firestore REST (avec token user pour passer les rules) ──
async function fsGet(path, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`;
  const res = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + idToken }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Firestore GET failed: ' + await res.text());
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
    // ── 1. Authentification ──
    const authHeader = req.headers['authorization'] || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) {
      return res.status(401).json({ error: 'Non authentifié. Connectez-vous d\'abord.' });
    }

    const uid = await verifyFirebaseToken(idToken);
    if (!uid) {
      return res.status(401).json({ error: 'Token invalide ou expiré.' });
    }

    // ── 2. Valider le code ──
    const { promoCode } = req.body || {};
    if (!promoCode || typeof promoCode !== 'string') {
      return res.status(400).json({ error: 'Code promo manquant.' });
    }

    const code = promoCode.trim().toUpperCase();
    const promoDef = PROMO_CODES[code];
    if (!promoDef || !promoDef.active) {
      return res.status(400).json({ error: 'Code promo invalide ou expiré.' });
    }

    // ── 3. Vérifier l'état du user ──
    const userDoc = await fsGet(`users/${uid}`, idToken);
    if (!userDoc) {
      return res.status(404).json({ error: 'Compte utilisateur introuvable.' });
    }

    const subStatus = fv(userDoc, 'subscriptionStatus');
    const subId = fv(userDoc, 'stripeSubscriptionId');
    if (subId && ['active', 'trialing'].includes(subStatus)) {
      return res.status(400).json({ error: 'Vous avez déjà un abonnement actif.' });
    }

    const existingCode = fv(userDoc, 'promoCode');
    const existingEnd = fv(userDoc, 'promoEnd');
    if (existingCode === code && existingEnd) {
      return res.status(400).json({ error: 'Vous avez déjà utilisé ce code promo.' });
    }

    if (existingEnd) {
      const pe = new Date(existingEnd);
      if (!isNaN(pe.getTime()) && pe > new Date()) {
        return res.status(400).json({ error: 'Vous bénéficiez déjà d\'une offre en cours.' });
      }
    }

    // ── 4. Code valide → retourner les infos ──
    // Le client écrira dans Firestore (il est authentifié)
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + promoDef.durationDays);

    console.log(`[activate-promo] ✅ ${uid} → code ${code} validé (${promoDef.plan}, ${promoDef.durationDays}j)`);

    return res.status(200).json({
      ok: true,
      plan: promoDef.plan,
      promoEnd: end.toISOString(),
      promoActivatedAt: now.toISOString(),
      label: promoDef.label,
      durationDays: promoDef.durationDays,
      code: code,
    });

  } catch (e) {
    console.error('[activate-promo] ❌ Erreur serveur:', e);
    return res.status(500).json({ error: 'Erreur serveur : ' + e.message });
  }
};
