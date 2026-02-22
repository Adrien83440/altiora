// api/send-sms.js — sans dépendance npm

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

async function sendSmsCapitoleMobile(recipients, message, sender) {
  const username = process.env.CAPITOLE_USERNAME;
  const password = process.env.CAPITOLE_PASSWORD;
  if (!username || !password) throw new Error('Identifiants Capitole Mobile manquants');

  const gsmTags = recipients.map(tel => {
    let num = tel.replace(/[\s\-\.]/g, '');
    if (num.startsWith('0')) num = '33' + num.slice(1);
    if (num.startsWith('+')) num = num.slice(1);
    return '<gsm>' + num + '</gsm>';
  }).join('');

  const senderClean = (sender || 'ALTIORA').slice(0, 11).replace(/[^a-zA-Z0-9]/g, '');

  const xmlString = '<SMS><authentification><username>' + username + '</username><password>' + password + '</password></authentification><message><text>' + message + '</text><sender>' + senderClean + '</sender><route>M</route><long>no</long></message><recipients>' + gsmTags + '</recipients></SMS>';

  const body = 'XML=' + encodeURIComponent(xmlString);

  const res = await fetch('https://sms.capitolemobile.com/api/sendsms/xml_v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text();
  console.log('Réponse Capitole Mobile:', text);
  if (text.includes('<e>') || text.toLowerCase().includes('error')) {
    throw new Error('Capitole Mobile erreur: ' + text);
  }
  return text;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { uid, campagneId, recipients, message, sender } = req.body;

  if (!uid || !recipients || !message)
    return res.status(400).json({ error: 'uid, recipients et message requis' });
  if (!Array.isArray(recipients) || recipients.length === 0)
    return res.status(400).json({ error: 'recipients doit être un tableau non vide' });
  if (message.length > 160)
    return res.status(400).json({ error: 'Message trop long (max 160 caractères)' });

  const smsNeeded = recipients.length;

  try {
    const token = await getFirebaseToken();

    // Vérifier le solde
    const creditsDoc = await firestoreGet(token, 'sms_credits/' + uid);
    const currentCredits = parseInt(creditsDoc?.fields?.credits?.integerValue || '0');

    if (currentCredits < smsNeeded) {
      return res.status(402).json({
        error: 'Solde insuffisant',
        credits: currentCredits,
        needed: smsNeeded,
      });
    }

    // Envoyer les SMS
    await sendSmsCapitoleMobile(recipients, message, sender);

    // Débiter le solde
    const newCredits = currentCredits - smsNeeded;
    await firestorePatch(token, 'sms_credits/' + uid, { credits: newCredits });

    // Historique
    const txId = (campagneId || Date.now()).toString();
    await firestorePatch(token, 'sms_credits/' + uid + '/history/' + txId, {
      type: 'send',
      smsUsed: smsNeeded,
      date: new Date().toISOString().slice(0, 10),
      message: message.slice(0, 100),
      recipientCount: smsNeeded,
    });

    console.log('✅ SMS envoyés:', smsNeeded, '| solde restant:', newCredits);
    return res.status(200).json({ success: true, sent: smsNeeded, remaining: newCredits });
  } catch (err) {
    console.error('Erreur send-sms:', err);
    return res.status(500).json({ error: err.message });
  }
};
