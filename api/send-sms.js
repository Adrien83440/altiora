// api/send-sms.js — Twilio
// SÉCURISÉ : vérification token Firebase + lecture crédits côté serveur

// ── Vérification du token Firebase côté serveur ──
async function verifyFirebaseToken(idToken) {
  const fbKey = process.env.FIREBASE_API_KEY;
  if (!fbKey) throw new Error('FIREBASE_API_KEY non configurée');
  const res = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + fbKey,
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

// ── Lecture crédits Firestore via token client (rules: allow read if isOwner) ──
async function readCreditsWithToken(clientToken, uid) {
  const projectId = process.env.FIREBASE_PROJECT_ID || 'altiora-70599';
  const res = await fetch(
    'https://firestore.googleapis.com/v1/projects/' + projectId + '/databases/(default)/documents/sms_credits/' + uid,
    { headers: { 'Authorization': 'Bearer ' + clientToken } }
  );
  if (!res.ok) return 0;
  const doc = await res.json();
  const raw = doc?.fields?.credits;
  if (!raw) return 0;
  return parseInt(raw.integerValue || raw.stringValue || '0') || 0;
}

async function firestorePatchWithToken(clientToken, path, fields) {
  const projectId = process.env.FIREBASE_PROJECT_ID || 'altiora-70599';
  const firestoreFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'number') firestoreFields[key] = { integerValue: value.toString() };
    else firestoreFields[key] = { stringValue: String(value) };
  }
  const fieldPaths = Object.keys(fields).map(k => 'updateMask.fieldPaths=' + k).join('&');
  const res = await fetch(
    'https://firestore.googleapis.com/v1/projects/' + projectId + '/databases/(default)/documents/' + path + '?' + fieldPaths,
    {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + clientToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: firestoreFields }),
    }
  );
  return res.json();
}

async function sendSmsTwilio(recipients, message, sender) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const defaultFrom = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !defaultFrom) {
    throw new Error('Variables Twilio manquantes (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER)');
  }

  let fromNumber = defaultFrom;
  if (sender && sender.trim()) {
    const cleanSender = sender.trim().replace(/[^a-zA-Z0-9]/g, '').slice(0, 11);
    if (cleanSender) fromNumber = cleanSender;
  }
  console.log('Expéditeur utilisé:', fromNumber);

  const credentials = Buffer.from(accountSid + ':' + authToken).toString('base64');
  const results = { sent: 0, failed: 0, errors: [] };

  for (const tel of recipients) {
    let num = tel.replace(/[\s\-\.]/g, '');
    if (num.startsWith('0')) num = '+33' + num.slice(1);
    else if (!num.startsWith('+')) num = '+33' + num;

    const body = new URLSearchParams({ To: num, From: fromNumber, Body: message });

    try {
      const res = await fetch(
        'https://api.twilio.com/2010-04-01/Accounts/' + accountSid + '/Messages.json',
        {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + credentials,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
        }
      );
      const data = await res.json();
      if (data.sid) {
        results.sent++;
        console.log('SMS envoyé à', num, '— SID:', data.sid);
      } else {
        results.failed++;
        results.errors.push(num + ': ' + (data.message || 'erreur inconnue'));
        console.error('Échec', num, data.message);
      }
    } catch (e) {
      results.failed++;
      results.errors.push(num + ': ' + e.message);
    }
  }

  return results;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).end();

  // ── AUTH : vérifier le token Firebase et extraire l'uid ──
  const clientToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!clientToken) {
    return res.status(401).json({ error: 'Token d\'authentification manquant.' });
  }

  let verifiedUid;
  try {
    verifiedUid = await verifyFirebaseToken(clientToken);
  } catch (e) {
    return res.status(401).json({ error: 'Token invalide ou expiré.' });
  }

  const { campagneId, recipients, message, sender } = req.body || {};
  console.log('send-sms — uid vérifié:', verifiedUid, '| destinataires:', recipients && recipients.length);

  if (!recipients || !message) {
    return res.status(400).json({ error: 'Paramètres manquants (recipients, message)' });
  }

  // ── Lecture du solde RÉEL depuis Firestore (pas le client) ──
  const realCredits = await readCreditsWithToken(clientToken, verifiedUid);
  console.log('Solde réel Firestore:', realCredits, '| SMS requis:', recipients.length);

  if (realCredits < recipients.length) {
    return res.status(402).json({ error: 'Solde insuffisant', credits: realCredits, required: recipients.length });
  }

  try {
    // Envoyer les SMS via Twilio
    const results = await sendSmsTwilio(recipients, message, sender || 'ALTEORE');
    console.log('Résultats Twilio:', results);

    if (results.sent > 0) {
      const newCredits = realCredits - results.sent;

      // Débiter le solde via token client Firebase
      try {
        await firestorePatchWithToken(clientToken, 'sms_credits/' + verifiedUid, { credits: newCredits });
        // Historique
        const txId = Date.now().toString();
        await firestorePatchWithToken(clientToken, 'sms_credits/' + verifiedUid + '/history/' + txId, {
          type: 'send',
          campagneId: campagneId || '',
          smsSent: results.sent,
          smsFailed: results.failed,
          date: new Date().toISOString().slice(0, 10),
          message: message.slice(0, 100),
        });
        console.log('✅ Solde débité:', realCredits, '→', newCredits);
      } catch (debitErr) {
        console.warn('⚠️ Débit Firestore échoué (SMS envoyés quand même):', debitErr.message);
      }

      return res.status(200).json({ success: true, sent: results.sent, failed: results.failed, remaining: newCredits, errors: results.errors });
    } else {
      return res.status(500).json({ error: 'Aucun SMS envoyé', details: results.errors });
    }

  } catch (err) {
    console.error('Erreur:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
