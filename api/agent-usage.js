// api/agent-usage.js
//
// Retourne les quotas Léa du mois en cours :
//   - chatMessages : X / 100
//   - smsUsed      : X / 31
//   - briefingsGenerated (info)
//   - actionsValidated (info)
//
// Utilisé par agent.html pour afficher la barre de quotas, et par
// agent-chat.js avant chaque appel pour bloquer si dépassement.
//
// Wave 1 livre le endpoint ; les compteurs sont incrémentés par les
// APIs consommatrices (agent-chat, agent-send-brief-sms...) en Wave 2+.

const FIREBASE_PROJECT = 'altiora-70599';

const QUOTA_CHAT_MESSAGES = 100;
const QUOTA_SMS = 31;

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
  return { uid: user.localId };
}

let _adminToken = null;
let _adminTokenExp = 0;

async function getAdminToken() {
  if (_adminToken && Date.now() < _adminTokenExp - 300000) return _adminToken;
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
  const email = process.env.FIREBASE_API_EMAIL;
  const password = process.env.FIREBASE_API_PASSWORD;
  if (!email || !password) return null;
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
  return null;
}

async function fsGet(path) {
  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`;
  const token = await getAdminToken();
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url + (token ? '' : '?key=' + fbKey), { headers });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.json();
}

function fv(doc, field) {
  const f = doc?.fields?.[field];
  if (!f) return null;
  if (f.stringValue !== undefined) return f.stringValue;
  if (f.integerValue !== undefined) return parseInt(f.integerValue);
  if (f.doubleValue !== undefined) return parseFloat(f.doubleValue);
  if (f.booleanValue !== undefined) return f.booleanValue;
  return null;
}

function currentYearMonth() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  // ── Auth ──
  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ error: 'Authentification requise' });
  const verified = await verifyFirebaseToken(idToken);
  if (!verified) return res.status(401).json({ error: 'Token invalide' });
  const { uid } = verified;

  try {
    const ym = currentYearMonth();
    const usageDoc = await fsGet(`agent/${uid}/usage/${ym}`);

    const chatMessages        = parseInt(fv(usageDoc, 'chatMessages')        || 0);
    const smsUsed             = parseInt(fv(usageDoc, 'smsUsed')             || 0);
    const briefingsGenerated  = parseInt(fv(usageDoc, 'briefingsGenerated')  || 0);
    const actionsValidated    = parseInt(fv(usageDoc, 'actionsValidated')    || 0);
    const totalInputTokens    = parseInt(fv(usageDoc, 'totalInputTokens')    || 0);
    const totalOutputTokens   = parseInt(fv(usageDoc, 'totalOutputTokens')   || 0);

    return res.status(200).json({
      period: ym,
      chat: {
        used: chatMessages,
        limit: QUOTA_CHAT_MESSAGES,
        remaining: Math.max(0, QUOTA_CHAT_MESSAGES - chatMessages),
        exceeded: chatMessages >= QUOTA_CHAT_MESSAGES,
      },
      sms: {
        used: smsUsed,
        limit: QUOTA_SMS,
        remaining: Math.max(0, QUOTA_SMS - smsUsed),
        exceeded: smsUsed >= QUOTA_SMS,
      },
      stats: {
        briefingsGenerated,
        actionsValidated,
        totalInputTokens,
        totalOutputTokens,
      },
    });
  } catch (e) {
    console.error('[agent-usage] Exception:', e);
    return res.status(500).json({ error: e.message });
  }
};
