// api/admin-purge-dettes.js
// Deux actions :
//   GET  ?uid=xxx             → lit dettes/{uid}/data/all, retourne la liste avec détection des doublons
//   POST {uid, toDelete:[id]} → supprime les dettes dont l'id est dans toDelete
//
// Sécurité : idToken Firebase vérifié, email dans ADMIN_EMAILS obligatoire.
// Écriture via token admin serveur (signInWithPassword) → Firestore REST PATCH.

const PROJECT_ID = 'altiora-70599';
const ADMIN_EMAILS = ['contact@adrienemily.com', 'api@altiora.app'];
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

async function getAdminToken() {
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${process.env.FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: process.env.FIREBASE_API_EMAIL,
        password: process.env.FIREBASE_API_PASSWORD,
        returnSecureToken: true
      })
    }
  );
  const d = await r.json();
  if (!d.idToken) throw new Error('Admin login failed');
  return d.idToken;
}

async function verifyCallerIsAdmin(idToken) {
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${process.env.FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    }
  );
  const d = await r.json();
  const email = (d.users && d.users[0] && d.users[0].email || '').toLowerCase();
  if (!ADMIN_EMAILS.includes(email)) throw new Error('Accès refusé : ' + email);
  return email;
}

function decodeValue(v) {
  if (!v) return null;
  if (v.stringValue    !== undefined) return v.stringValue;
  if (v.booleanValue   !== undefined) return v.booleanValue;
  if (v.integerValue   !== undefined) return Number(v.integerValue);
  if (v.doubleValue    !== undefined) return v.doubleValue;
  if (v.timestampValue !== undefined) return v.timestampValue; // garder comme string ISO
  if (v.nullValue      !== undefined) return null;
  if (v.arrayValue)  return (v.arrayValue.values || []).map(decodeValue);
  if (v.mapValue) {
    const obj = {};
    for (const k of Object.keys(v.mapValue.fields || {})) obj[k] = decodeValue(v.mapValue.fields[k]);
    return obj;
  }
  return null;
}

function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number')  return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') {
    // Détecter les strings ISO datetime → encoder comme timestamp Firestore
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) return { timestampValue: v };
    return { stringValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const k of Object.keys(v)) fields[k] = encodeValue(v[k]);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function encodeDoc(obj) {
  const fields = {};
  for (const k of Object.keys(obj)) fields[k] = encodeValue(obj[k]);
  return { fields };
}

// Clé de déduplication : nom normalisé + type
function detteKey(d) {
  return ((d.nom || '').trim().toLowerCase()) + '||' + (d.type || '');
}

async function scanDettes(uid, adminToken) {
  const url = `${FS_BASE}/dettes/${uid}/data/all`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + adminToken } });

  if (r.status === 404) return { dettes: [], doublons: [] };
  if (!r.ok) throw new Error('Firestore GET dettes ' + r.status + ' : ' + await r.text());

  const fsDoc = await r.json();
  const fields = fsDoc.fields || {};
  const listField = fields.list;
  const rawList = listField ? decodeValue(listField) : [];
  const list = Array.isArray(rawList) ? rawList : [];

  // Détecter les doublons : même nom (insensible casse) + même type
  const seenKeys = {};
  const doublons = []; // ids des doublons (à supprimer = les suivants)

  list.forEach(function(d, idx) {
    if (!d || !d.nom) return;
    const k = detteKey(d);
    if (seenKeys[k] === undefined) {
      seenKeys[k] = d.id || String(idx);
    } else {
      doublons.push({
        id:         d.id || String(idx),
        idx:        idx,
        nom:        d.nom,
        type:       d.type,
        montant:    d.montant,
        debut:      d.debut,
        duplicOf:   seenKeys[k]
      });
    }
  });

  return { dettes: list, doublons };
}

async function purgeDettes(uid, toDelete, adminToken) {
  if (!toDelete || toDelete.length === 0) return { ok: true };

  const deleteSet = new Set(toDelete);

  // Lire l'état courant
  const url = `${FS_BASE}/dettes/${uid}/data/all`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + adminToken } });
  if (r.status === 404) return { ok: true, purged: 0 };
  if (!r.ok) throw new Error('Firestore GET ' + r.status);

  const fsDoc = await r.json();
  const fields = fsDoc.fields || {};
  const rawList = fields.list ? decodeValue(fields.list) : [];
  const list = Array.isArray(rawList) ? rawList : [];

  // Filtrer : garder ce qui n'est PAS dans toDelete
  const newList = list.filter(function(d, idx) {
    const id = d && (d.id || String(idx));
    return !deleteSet.has(id);
  });

  // Réécrire le doc complet (on ne touche qu'au champ list)
  const body = encodeDoc({ list: newList });

  const rPatch = await fetch(url, {
    method:  'PATCH',
    headers: { Authorization: 'Bearer ' + adminToken, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body)
  });
  if (!rPatch.ok) throw new Error('Firestore PATCH ' + rPatch.status + ' : ' + await rPatch.text());

  return { ok: true, purged: list.length - newList.length };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const authHeader = req.headers.authorization || '';
    const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'Non authentifié' });
    await verifyCallerIsAdmin(idToken);
    const adminToken = await getAdminToken();

    if (req.method === 'GET') {
      const uid = req.query && req.query.uid;
      if (!uid) return res.status(400).json({ error: 'uid manquant' });
      const { dettes, doublons } = await scanDettes(uid, adminToken);
      return res.status(200).json({ success: true, dettes, doublons });
    }

    if (req.method === 'POST') {
      const { uid, toDelete } = req.body || {};
      if (!uid)    return res.status(400).json({ error: 'uid manquant' });
      if (!Array.isArray(toDelete) || toDelete.length === 0)
        return res.status(400).json({ error: 'toDelete vide' });
      if (toDelete.length > 50)
        return res.status(400).json({ error: 'Trop d\'entrées (max 50)' });
      const result = await purgeDettes(uid, toDelete, adminToken);
      return res.status(200).json({ success: true, ...result });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch(e) {
    console.error('[admin-purge-dettes] fatal:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
