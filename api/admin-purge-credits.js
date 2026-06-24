// api/admin-purge-credits.js
// Deux actions :
//   GET  ?uid=xxx          → liste tous les crédits uniques de pilotage/{uid}/months/*
//   POST {uid, keysToDelete:[]} → supprime les lignes ciblées sur tous les mois
//
// Sécurité : idToken Firebase vérifié, email dans ADMIN_EMAILS obligatoire.
// Écriture via token admin serveur (signInWithPassword) → Firestore REST PATCH.

const PROJECT_ID = 'altiora-70599';
const ADMIN_EMAILS = ['contact@adrienemily.com', 'api@altiora.app'];
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// ── Helpers Firestore REST ──────────────────────────────────────────────────

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

// Liste tous les documents d'une sous-collection (pagination automatique)
async function listMonths(uid, adminToken) {
  const docs = [];
  let pageToken = '';
  let iter = 0;
  do {
    const url = `${FS_BASE}/pilotage/${uid}/months?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + adminToken } });
    if (!r.ok) throw new Error('listMonths ' + r.status + ' : ' + await r.text());
    const d = await r.json();
    if (d.documents) docs.push(...d.documents);
    pageToken = d.nextPageToken || '';
    iter++;
  } while (pageToken && iter < 30);
  return docs;
}

// Decode un document Firestore REST → objet JS plat pour credits[]
function decodeDoc(fsDoc) {
  const fields = fsDoc.fields || {};

  function decodeValue(v) {
    if (!v) return null;
    if (v.stringValue  !== undefined) return v.stringValue;
    if (v.booleanValue !== undefined) return v.booleanValue;
    if (v.integerValue !== undefined) return Number(v.integerValue);
    if (v.doubleValue  !== undefined) return v.doubleValue;
    if (v.arrayValue)  return (v.arrayValue.values || []).map(decodeValue);
    if (v.mapValue)    return decodeMap(v.mapValue.fields || {});
    return null;
  }
  function decodeMap(f) {
    const obj = {};
    for (const k of Object.keys(f)) obj[k] = decodeValue(f[k]);
    return obj;
  }

  const out = decodeMap(fields);
  out.__name = fsDoc.name;
  return out;
}

// Encode un objet JS → champs Firestore REST
function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number')  return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string')  return { stringValue: v };
  if (Array.isArray(v))       return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const k of Object.keys(v)) fields[k] = encodeValue(v[k]);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function encodeDoc(obj) {
  const fields = {};
  for (const k of Object.keys(obj)) {
    if (k === '__name') continue;
    fields[k] = encodeValue(obj[k]);
  }
  return { fields };
}

// ── Logique métier ──────────────────────────────────────────────────────────

const PLACEHOLDER = {
  fournisseur: '', nom: '', ligneType: 'principal',
  montant: '', tvaRate: 20, tvaAuto: false,
  tauxInteret: '', pointe: 'Non',
  dateDebut: '', dateFin: '', amort: 'constant'
};

function creditKey(c, monthKey) {
  const fourn   = (c.fournisseur || '').trim();
  const nom     = (c.nom || '').trim();
  const isEmpty = !fourn && !(parseFloat(c.montant) > 0);
  return isEmpty ? null : `${fourn}||${nom}||${c.ligneType || 'principal'}`;
}

async function scanCredits(uid, adminToken) {
  const docs   = await listMonths(uid, adminToken);
  const credMap = {};  // key → {info, moisList}

  for (const fsDoc of docs) {
    const parts    = fsDoc.name.split('/');
    const monthKey = parts[parts.length - 1];
    const d        = decodeDoc(fsDoc);
    const credits  = Array.isArray(d.credits) ? d.credits : [];

    for (const c of credits) {
      const key = creditKey(c, monthKey);
      if (!key) continue; // skip placeholders — non supprimables via cet outil

      if (!credMap[key]) {
        credMap[key] = {
          key,
          fournisseur:    (c.fournisseur || '').trim(),
          nom:            (c.nom || '').trim(),
          ligneType:      c.ligneType || 'principal',
          montant:        c.montant   || '',
          mensualite:     c.mensualite || c.montant || '',
          taux:           c.tauxInteret || '',
          dateDebut:      c.dateDebut || '',
          dateFin:        c.dateFin   || '',
          amort:          c.amort     || 'constant',
          capitalInitial: c.capitalInitial || '',
          duree:          c.duree     || '',
          moisList:       []
        };
      }
      // Prendre la valeur non nulle la plus complète
      if (parseFloat(c.montant) > 0 && !(parseFloat(credMap[key].montant) > 0)) {
        Object.assign(credMap[key], {
          montant: c.montant, mensualite: c.mensualite || c.montant,
          taux: c.tauxInteret, dateDebut: c.dateDebut,
          dateFin: c.dateFin, capitalInitial: c.capitalInitial, duree: c.duree
        });
      }
      credMap[key].moisList.push(monthKey);
    }
  }

  return { credits: Object.values(credMap), monthCount: docs.length };
}

async function purgeCredits(uid, keysToDelete, adminToken) {
  if (!keysToDelete || keysToDelete.length === 0) return { purged: 0, errors: 0 };

  const keySet = new Set(keysToDelete);
  const docs   = await listMonths(uid, adminToken);
  let purged = 0, errors = 0;

  for (const fsDoc of docs) {
    const parts    = fsDoc.name.split('/');
    const monthKey = parts[parts.length - 1];
    const d        = decodeDoc(fsDoc);
    const credits  = Array.isArray(d.credits) ? d.credits : [];

    // Filtrer les lignes à supprimer
    const newCredits = credits.filter(c => {
      const k = creditKey(c, monthKey);
      return k === null || !keySet.has(k); // garder placeholders + lignes non ciblées
    });

    // Si aucun changement, skip
    if (newCredits.length === credits.length) continue;

    // Toujours au moins un placeholder
    if (newCredits.length === 0 || newCredits.every(c => creditKey(c, monthKey) !== null)) {
      if (!newCredits.some(c => !(c.fournisseur || '').trim() && !(parseFloat(c.montant) > 0))) {
        newCredits.push({ ...PLACEHOLDER });
      }
    }

    d.credits = newCredits;
    const encoded = encodeDoc(d);

    try {
      const url = `${FS_BASE}/pilotage/${uid}/months/${monthKey}`;
      const r   = await fetch(url, {
        method:  'PATCH',
        headers: { Authorization: 'Bearer ' + adminToken, 'Content-Type': 'application/json' },
        body:    JSON.stringify(encoded)
      });
      if (!r.ok) {
        console.error('[purge] PATCH', monthKey, r.status, await r.text());
        errors++;
      } else {
        purged++;
      }
    } catch(e) {
      console.error('[purge] exception', monthKey, e.message);
      errors++;
    }
  }

  return { purged, errors };
}

// ── Handler principal ───────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── Auth ──
    const authHeader = req.headers.authorization || '';
    const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'Non authentifié' });
    await verifyCallerIsAdmin(idToken);

    const adminToken = await getAdminToken();

    // ── GET : scan ──
    if (req.method === 'GET') {
      const uid = req.query && req.query.uid;
      if (!uid) return res.status(400).json({ error: 'uid manquant' });

      const { credits, monthCount } = await scanCredits(uid, adminToken);
      return res.status(200).json({ success: true, credits, monthCount });
    }

    // ── POST : purge ──
    if (req.method === 'POST') {
      const { uid, keysToDelete } = req.body || {};
      if (!uid) return res.status(400).json({ error: 'uid manquant' });
      if (!Array.isArray(keysToDelete) || keysToDelete.length === 0) {
        return res.status(400).json({ error: 'keysToDelete vide' });
      }
      if (keysToDelete.length > 200) {
        return res.status(400).json({ error: 'Trop de clés (max 200 par appel)' });
      }

      const { purged, errors } = await purgeCredits(uid, keysToDelete, adminToken);
      return res.status(200).json({ success: true, purged, errors });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch(e) {
    console.error('[admin-purge-credits] fatal:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
