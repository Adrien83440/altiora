// api/admin-purge-credits.js
// Trois actions :
//   GET  ?uid=xxx                    → liste tous les crédits uniques + doublons intra-mois
//   POST {uid, keysToDelete:[]}      → supprime les clés "inter-mois" ciblées sur tous les mois
//   POST {uid, intraDoublons:[{monthKey, indexes:[]}]} → supprime les doublons intra-mois ciblés
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

function creditKey(c) {
  const fourn   = (c.fournisseur || '').trim();
  const isEmpty = !fourn && !(parseFloat(c.montant) > 0);
  if (isEmpty) return null;
  // Normaliser dateDebut au format YYYY-MM (ignorer le jour si présent)
  let normDate = '';
  if (c.dateDebut) {
    const parts = String(c.dateDebut).split('-');
    if (parts.length >= 2) normDate = parts[0] + '-' + parts[1];
  }
  return `${fourn}||${(c.nom || '').trim()}||${c.ligneType || 'principal'}||${normDate}`;
}

// ── Clé de déduplication intra-mois (basée sur le nom, insensible à la casse)
// Deux lignes dans le même mois avec le même nom (fournisseur ou nom) sont des doublons.
function intraKey(c) {
  const fourn = (c.fournisseur || '').trim().toLowerCase();
  if (!fourn && !(parseFloat(c.montant) > 0)) return null; // placeholder
  return fourn || (c.nom || '').trim().toLowerCase();
}

async function scanCredits(uid, adminToken) {
  const docs    = await listMonths(uid, adminToken);
  const credMap = {};  // key → {info, moisList}
  const intraDoublons = []; // liste des doublons intra-mois détectés

  for (const fsDoc of docs) {
    const parts    = fsDoc.name.split('/');
    const monthKey = parts[parts.length - 1];
    const d        = decodeDoc(fsDoc);
    const credits  = Array.isArray(d.credits) ? d.credits : [];

    // ── Détecter les doublons INTRA-MOIS ──
    // Un doublon = deux lignes dans le même mois avec le même nom de fournisseur
    const seenInMonth = {}; // intraKey → premier index réel
    const dubIndexes  = []; // indexes des lignes en doublon (à supprimer = les suivantes)

    credits.forEach((c, idx) => {
      const ik = intraKey(c);
      if (!ik) return; // placeholder, skip
      if (seenInMonth[ik] === undefined) {
        seenInMonth[ik] = idx; // premier = original, on garde
      } else {
        dubIndexes.push(idx); // doublon = on propose la suppression
      }
    });

    if (dubIndexes.length > 0) {
      // Construire les détails pour l'affichage côté UI
      const dubDetails = dubIndexes.map(idx => {
        const c = credits[idx];
        return {
          index: idx,
          fournisseur: (c.fournisseur || '').trim(),
          nom: (c.nom || '').trim(),
          montant: c.montant || '',
          mensualite: c.mensualite || c.montant || '',
          dateDebut: c.dateDebut || '',
          dateFin: c.dateFin || ''
        };
      });
      intraDoublons.push({ monthKey, dubIndexes, dubDetails });
    }

    // ── Agrégation inter-mois (comportement existant) ──
    for (const c of credits) {
      const key = creditKey(c);
      if (!key) continue;

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

  return { credits: Object.values(credMap), monthCount: docs.length, intraDoublons };
}

// ── Purge inter-mois (comportement existant) ──
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

    const newCredits = credits.filter(c => {
      const k = creditKey(c);
      return k === null || !keySet.has(k);
    });

    if (newCredits.length === credits.length) continue;

    if (newCredits.length === 0 || newCredits.every(c => creditKey(c) !== null)) {
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
      if (!r.ok) { console.error('[purge] PATCH', monthKey, r.status, await r.text()); errors++; }
      else        { purged++; }
    } catch(e) {
      console.error('[purge] exception', monthKey, e.message);
      errors++;
    }
  }

  return { purged, errors };
}

// ── Purge intra-mois (NOUVEAU) ──
// intraToDelete = [{ monthKey: 'YYYY-MM', indexes: [2, 5, ...] }]
// On supprime les lignes aux index indiqués dans chaque mois.
// Sécurité : on charge chaque mois frais depuis Firestore avant de modifier.
async function purgeIntraDoublons(uid, intraToDelete, adminToken) {
  if (!intraToDelete || intraToDelete.length === 0) return { purged: 0, errors: 0 };

  let purged = 0, errors = 0;

  for (const { monthKey, indexes } of intraToDelete) {
    if (!monthKey || !Array.isArray(indexes) || indexes.length === 0) continue;
    const indexSet = new Set(indexes.map(Number));

    try {
      // Recharger le mois frais (évite les race conditions)
      const url = `${FS_BASE}/pilotage/${uid}/months/${monthKey}`;
      const r   = await fetch(url, { headers: { Authorization: 'Bearer ' + adminToken } });
      if (!r.ok) { console.error('[purge-intra] GET', monthKey, r.status); errors++; continue; }

      const fsDoc  = await r.json();
      const d      = decodeDoc(fsDoc);
      const credits = Array.isArray(d.credits) ? d.credits : [];

      // Filtrer en gardant les lignes dont l'index N'EST PAS dans indexSet
      const newCredits = credits.filter((_, idx) => !indexSet.has(idx));

      // Toujours au moins un placeholder
      const hasReal = newCredits.some(c => (c.fournisseur || '').trim() || parseFloat(c.montant) > 0);
      if (!hasReal) newCredits.push({ ...PLACEHOLDER });

      d.credits = newCredits;
      const encoded = encodeDoc(d);

      const rPatch = await fetch(url, {
        method:  'PATCH',
        headers: { Authorization: 'Bearer ' + adminToken, 'Content-Type': 'application/json' },
        body:    JSON.stringify(encoded)
      });
      if (!rPatch.ok) { console.error('[purge-intra] PATCH', monthKey, rPatch.status, await rPatch.text()); errors++; }
      else             { purged++; }
    } catch(e) {
      console.error('[purge-intra] exception', monthKey, e.message);
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
    const authHeader = req.headers.authorization || '';
    const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'Non authentifié' });
    await verifyCallerIsAdmin(idToken);

    const adminToken = await getAdminToken();

    // ── GET : scan ──
    if (req.method === 'GET') {
      const uid = req.query && req.query.uid;
      if (!uid) return res.status(400).json({ error: 'uid manquant' });

      const { credits, monthCount, intraDoublons } = await scanCredits(uid, adminToken);
      return res.status(200).json({ success: true, credits, monthCount, intraDoublons });
    }

    // ── POST : purge inter-mois OU intra-mois ──
    if (req.method === 'POST') {
      const body = req.body || {};
      const uid  = body.uid;
      if (!uid) return res.status(400).json({ error: 'uid manquant' });

      // Purge intra-mois (doublons au sein d'un même mois)
      if (Array.isArray(body.intraDoublons) && body.intraDoublons.length > 0) {
        if (body.intraDoublons.length > 100) {
          return res.status(400).json({ error: 'Trop d\'entrées intraDoublons (max 100)' });
        }
        const { purged, errors } = await purgeIntraDoublons(uid, body.intraDoublons, adminToken);
        return res.status(200).json({ success: true, purged, errors });
      }

      // Purge inter-mois (comportement existant)
      const { keysToDelete } = body;
      if (!Array.isArray(keysToDelete) || keysToDelete.length === 0) {
        return res.status(400).json({ error: 'keysToDelete vide (et intraDoublons absent)' });
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
