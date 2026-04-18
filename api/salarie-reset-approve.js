// api/salarie-reset-approve.js
// Appele par le manager pour approuver une demande de reset (ou forcer un reset).
// Genere un nouveau PIN 4 chiffres aleatoire, l'enregistre, et le renvoie + envoie email au manager.
//
// Input:  { publicId: string, idToken: string (manager) }
// Output: { success: true, newPin: string, emailSent: boolean }
//         { success: false, error }
//
// SECURITE :
// - idToken verifie cote serveur via firebase-admin
// - Ownership : le manager doit etre le uid proprietaire du salarie
// - newPin genere cote serveur avec crypto.randomInt (non-biased)
// - Le PIN est renvoye UNE SEULE fois (pas stocke en clair en base)
// - Email au manager via Resend (redondance : si l'UI se ferme, le manager a quand meme le PIN par mail)

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const crypto = require('crypto');

function getApp() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: 'altiora-70599',
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
}
function getDb() { getApp(); return getFirestore(); }
function getAuthAdmin() { getApp(); return getAuth(); }

function hashPin(publicId, pin) {
  const secret = process.env.PIN_SERVER_SECRET || '';
  if (secret.length < 16) throw new Error('PIN_SERVER_SECRET manquant ou trop court');
  const payload = secret + ':' + publicId + ':' + pin;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// Genere un PIN 4 chiffres aleatoire cryptographiquement sur
function genRandomPin() {
  // crypto.randomInt(0, 10000) retourne un entier uniforme dans [0, 10000[
  const n = crypto.randomInt(0, 10000);
  return String(n).padStart(4, '0');
}

// Envoi email via Resend (meme pattern que les autres APIs)
async function sendEmailToManager(managerEmail, salarieName, newPin) {
  const resendKey = process.env.RESEND_API_KEY;
  const resendFrom = process.env.RESEND_FROM || 'ALTEORE <noreply@alteore.com>';
  if (!resendKey) {
    console.warn('[salarie-reset-approve] RESEND_API_KEY manquant, email non envoye');
    return false;
  }
  if (!managerEmail) {
    console.warn('[salarie-reset-approve] managerEmail manquant, email non envoye');
    return false;
  }

  const subject = 'Nouveau code d\'acces pour ' + (salarieName || 'votre salarie');
  const html = ''
    + '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f9fafb">'
    + '<div style="background:white;border-radius:12px;padding:24px;border:1px solid #e5e7eb">'
    +   '<h2 style="margin:0 0 16px;color:#059669;font-size:20px">🔑 Nouveau code d\'acces genere</h2>'
    +   '<p style="margin:0 0 12px;color:#374151;font-size:14px">Un nouveau code a ete genere pour '
    +     '<b>' + (salarieName || 'votre salarie') + '</b> suite a une demande de reinitialisation.</p>'
    +   '<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:20px;margin:16px 0;text-align:center">'
    +     '<div style="font-size:11px;color:#065f46;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Code PIN temporaire</div>'
    +     '<div style="font-size:36px;font-weight:800;color:#047857;letter-spacing:8px;font-family:monospace">' + newPin + '</div>'
    +   '</div>'
    +   '<p style="margin:16px 0 0;color:#6b7280;font-size:12px;line-height:1.5">'
    +     '<b>A faire :</b> transmettez ce code au salarie (oral, papier, SMS, ...). '
    +     'Il pourra le modifier lui-meme apres sa premiere connexion.'
    +   '</p>'
    +   '<p style="margin:12px 0 0;color:#9ca3af;font-size:11px">'
    +     '⚠️ Ne transferez pas cet email. Pour des raisons de securite, ce code ne sera plus visible apres fermeture.'
    +   '</p>'
    + '</div>'
    + '<div style="text-align:center;color:#9ca3af;font-size:11px;margin-top:16px">'
    +   'ALTEORE &middot; Espace salarie'
    + '</div>'
    + '</div>';

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + resendKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: resendFrom, to: managerEmail, subject, html }),
    });
    if (!r.ok) {
      console.warn('[salarie-reset-approve] Resend KO:', r.status, await r.text());
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[salarie-reset-approve] Resend error:', e.message);
    return false;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { publicId, idToken } = req.body || {};
    if (!publicId || typeof publicId !== 'string' || publicId.length < 6) {
      return res.status(400).json({ success: false, error: 'invalid_input' });
    }
    if (!idToken || typeof idToken !== 'string') {
      return res.status(401).json({ success: false, error: 'auth_required' });
    }
    if (!process.env.PIN_SERVER_SECRET || process.env.PIN_SERVER_SECRET.length < 16) {
      console.error('[salarie-reset-approve] PIN_SERVER_SECRET manquant ou trop court');
      return res.status(500).json({ success: false, error: 'server_config' });
    }

    // Verifier idToken
    let decoded;
    try {
      decoded = await getAuthAdmin().verifyIdToken(idToken);
    } catch (e) {
      console.warn('[salarie-reset-approve] idToken invalide:', e.message);
      return res.status(401).json({ success: false, error: 'invalid_token' });
    }
    const managerUid = decoded.uid;
    const managerEmail = decoded.email || null;

    const db = getDb();

    // Verifier que le salarie existe + ownership
    const pubSnap = await db.collection('rh_employes_public').doc(publicId).get();
    if (!pubSnap.exists) {
      return res.status(404).json({ success: false, error: 'salarie_not_found' });
    }
    const pubData = pubSnap.data() || {};
    if (pubData.uid !== managerUid) {
      return res.status(403).json({ success: false, error: 'not_owner' });
    }

    // Generer nouveau PIN + hash
    const newPin = genRandomPin();
    const hash = hashPin(publicId, newPin);
    const now = new Date().toISOString();

    await db.collection('rh_auth_salaries').doc(publicId).set({
      pinHash: hash,
      pinLastReset: now,
      pinAttempts: 0,
      pinLockedUntil: null,
      pinLength: 4,
      grandfathered: false,
      tempResetCode: null,
      tempResetExpiresAt: null,
      tempResetRequestedAt: null,
      setBy: 'manager_reset',
      setByUid: managerUid,
    }, { merge: true });

    // Envoyer email au manager avec le PIN (redondance UI)
    const salarieName = [pubData.prenom, pubData.nom].filter(Boolean).join(' ').trim() || null;
    const emailSent = await sendEmailToManager(managerEmail, salarieName, newPin);

    return res.status(200).json({
      success: true,
      newPin,  // Renvoye UNE SEULE FOIS, non stocke en clair
      emailSent,
    });

  } catch (e) {
    console.error('[salarie-reset-approve]', e);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
};
