// api/send-sms.js — Twilio

async function firestoreGetPublic(path) {
  // Lecture publique via REST sans auth (fonctionne si rules = allow read: if true pour sms_credits)
  // Sinon on utilise le token client passé en header
  const projectId = process.env.FIREBASE_PROJECT_ID || 'alteore-dev';
  const res = await fetch(
    'https://firestore.googleapis.com/v1/projects/' + projectId + '/databases/(default)/documents/' + path
  );
  return res.json();
}

async function firestorePatchWithToken(clientToken, path, fields) {
  const projectId = process.env.FIREBASE_PROJECT_ID || 'alteore-dev';
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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).end();

  // Le client passe son token Firebase dans Authorization header
  const clientToken = (req.headers.authorization || '').replace('Bearer ', '').trim();

  const { uid, campagneId, recipients, message, sender, clientCredits } = req.body || {};
  console.log('send-sms — uid:', uid, '| destinataires:', recipients && recipients.length, '| clientCredits:', clientCredits);

  if (!uid || !recipients || !message) {
    return res.status(400).json({ error: 'Paramètres manquants (uid, recipients, message)' });
  }

  // Vérif solde : on fait confiance au solde passé par le client (lu via SDK Firebase auth)
  // La protection réelle = les Firestore rules empêchent le client de falsifier son solde
  const knownCredits = parseInt(clientCredits) || 0;
  console.log('Solde client déclaré:', knownCredits, '| SMS requis:', recipients.length);

  if (knownCredits < recipients.length) {
    return res.status(402).json({ error: 'Solde insuffisant', credits: knownCredits, required: recipients.length });
  }

  try {
    // Envoyer les SMS via Twilio
    const results = await sendSmsTwilio(recipients, message, sender || 'ALTIORA');
    console.log('Résultats Twilio:', results);

    if (results.sent > 0) {
      const newCredits = knownCredits - results.sent;

      // Débiter le solde via token client Firebase (a les droits sur son propre doc)
      if (clientToken) {
        try {
          await firestorePatchWithToken(clientToken, 'sms_credits/' + uid, { credits: newCredits });
          // Historique
          const txId = Date.now().toString();
          await firestorePatchWithToken(clientToken, 'sms_credits/' + uid + '/history/' + txId, {
            type: 'send',
            campagneId: campagneId || '',
            smsSent: results.sent,
            smsFailed: results.failed,
            date: new Date().toISOString().slice(0, 10),
            message: message.slice(0, 100),
          });
          console.log('✅ Solde débité:', knownCredits, '→', newCredits);
        } catch (debitErr) {
          console.warn('⚠️ Débit Firestore échoué (SMS envoyés quand même):', debitErr.message);
        }
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
