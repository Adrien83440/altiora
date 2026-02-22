// api/send-sms.js — Twilio

async function getFirebaseToken() {
  const res = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + process.env.FIREBASE_API_KEY,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: process.env.FIREBASE_API_EMAIL,
        password: process.env.FIREBASE_API_PASSWORD,
        returnSecureToken: true,
      }),
    }
  );
  const data = await res.json();
  if (!data.idToken) throw new Error('Auth Firebase échouée');
  return data.idToken;
}

async function firestoreGet(token, path) {
  const projectId = process.env.FIREBASE_PROJECT_ID || 'altiora-70599';
  const res = await fetch(
    'https://firestore.googleapis.com/v1/projects/' + projectId + '/databases/(default)/documents/' + path,
    { headers: { Authorization: 'Bearer ' + token } }
  );
  return res.json();
}

async function firestorePatch(token, path, fields) {
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
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
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

  // Si sender fourni et alphanumérique (pas un numéro), on l'utilise — sinon le numéro par défaut
  const isAlphanumeric = defaultFrom && !/^\+?\d+$/.test(defaultFrom);
  let fromNumber;
  if (sender && sender.trim()) {
    // Nettoyer le sender : max 11 chars, alphanumérique uniquement
    const cleanSender = sender.trim().replace(/[^a-zA-Z0-9]/g, '').slice(0, 11);
    fromNumber = cleanSender || defaultFrom;
  } else {
    fromNumber = defaultFrom;
  }
  console.log('Expéditeur utilisé:', fromNumber);

  const credentials = Buffer.from(accountSid + ':' + authToken).toString('base64');
  const results = { sent: 0, failed: 0, errors: [] };

  for (const tel of recipients) {
    let num = tel.replace(/[\s\-\.]/g, '');
    if (num.startsWith('0')) num = '+33' + num.slice(1);
    else if (!num.startsWith('+')) num = '+33' + num;

    const body = new URLSearchParams({
      To: num,
      From: fromNumber,
      Body: message,
    });

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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).end();

  const { uid, campagneId, recipients, message, sender } = req.body || {};
  console.log('send-sms — uid:', uid, '| destinataires:', recipients && recipients.length, '| message:', message && message.slice(0, 30));

  if (!uid || !recipients || !message) {
    return res.status(400).json({ error: 'Paramètres manquants (uid, recipients, message)' });
  }

  try {
    const token = await getFirebaseToken();

    // Vérifier le solde
    const creditsDoc = await firestoreGet(token, 'sms_credits/' + uid);
    const currentCredits = parseInt((creditsDoc.fields && creditsDoc.fields.credits && creditsDoc.fields.credits.integerValue) || '0');
    console.log('Solde actuel:', currentCredits, '| SMS requis:', recipients.length);

    if (currentCredits < recipients.length) {
      return res.status(402).json({ error: 'Solde insuffisant', credits: currentCredits, required: recipients.length });
    }

    // Envoyer les SMS via Twilio
    const results = await sendSmsTwilio(recipients, message, sender || 'ALTIORA');
    console.log('Résultats Twilio:', results);

    // Débiter le solde (uniquement les SMS envoyés)
    if (results.sent > 0) {
      const newCredits = currentCredits - results.sent;
      await firestorePatch(token, 'sms_credits/' + uid, { credits: newCredits });

      // Historique
      const txId = Date.now().toString();
      await firestorePatch(token, 'sms_credits/' + uid + '/history/' + txId, {
        type: 'send',
        campagneId: campagneId || '',
        smsSent: results.sent,
        smsFailed: results.failed,
        date: new Date().toISOString().slice(0, 10),
        message: message.slice(0, 100),
      });

      console.log('✅ SMS envoyés:', results.sent, '| solde restant:', newCredits);
      return res.status(200).json({ success: true, sent: results.sent, failed: results.failed, remaining: newCredits, errors: results.errors });
    } else {
      return res.status(500).json({ error: 'Aucun SMS envoyé', details: results.errors });
    }

  } catch (err) {
    console.error('Erreur:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
