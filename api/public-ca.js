// api/public-ca.js
// ─────────────────────────────────────────────────────────────────────────────
// Endpoint public — reçoit le CA journalier depuis n'importe quelle caisse
// Authentification : Bearer token (API key stockée dans users/{uid}.apiKey)
//
// POST /api/public-ca
// Headers : Authorization: Bearer {apiKey}
//           Content-Type: application/json
//
// Body (formats acceptés) :
//   Multi-TVA (recommandé)  : { "date": "2026-03-04", "ht055": 0, "ht10": 150.00, "ht20": 320.50 }
//   Mono-montant            : { "date": "2026-03-04", "montantHT": 470.50, "tvaRate": 20 }
//   Tableau de lignes       : { "lignes": [ { "date": "...", "ht055": 0, ... }, ... ] }
//
// Réponses :
//   200 { ok: true,  updated: [...dates], skipped: [...dates] }
//   400 { ok: false, error: { code, message } }
//   401 { ok: false, error: { code, message } }
//   500 { ok: false, error: { code, message } }
// ─────────────────────────────────────────────────────────────────────────────

const FIREBASE_PROJECT = 'altiora-70599';
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';

// ── CORS ──────────────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function errResp(res, status, code, message) {
  return res.status(status).json({ ok: false, error: { code, message } });
}

// ── FIRESTORE REST ────────────────────────────────────────────────────────────

// Lit un document Firestore, retourne null si absent
async function fsGet(path) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?key=${FIREBASE_API_KEY}`;
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('fsGet failed ' + r.status + ' ' + path);
  const doc = await r.json();
  return doc.fields ? fsDocToObj(doc.fields) : null;
}

// Écrase un document Firestore (merge: false → set complet)
async function fsSet(path, obj) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?key=${FIREBASE_API_KEY}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: objToFsFields(obj) })
  });
  if (!r.ok) throw new Error('fsSet failed ' + r.status + ' ' + path);
  return r.json();
}

// Cherche un document par champ (retourne uid ou null)
async function fsQuery(collection, field, value) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents:runQuery?key=${FIREBASE_API_KEY}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: collection }],
        where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: value } } },
        limit: 1
      }
    })
  });
  const results = await r.json();
  const doc = results?.[0]?.document;
  if (!doc) return null;
  return doc.name.split('/').pop(); // uid = dernière partie du path
}

// Convertit un objet JS → format Firestore
function objToFsFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined)  out[k] = { nullValue: null };
    else if (typeof v === 'boolean')    out[k] = { booleanValue: v };
    else if (typeof v === 'number')     out[k] = { doubleValue: v };
    else if (typeof v === 'string')     out[k] = { stringValue: v };
    else if (Array.isArray(v))          out[k] = { arrayValue: { values: v.map(i => fieldValue(i)) } };
    else if (typeof v === 'object')     out[k] = { mapValue: { fields: objToFsFields(v) } };
  }
  return out;
}

function fieldValue(v) {
  if (typeof v === 'string')  return { stringValue: v };
  if (typeof v === 'number')  return { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (Array.isArray(v))       return { arrayValue: { values: v.map(i => fieldValue(i)) } };
  if (typeof v === 'object' && v !== null) return { mapValue: { fields: objToFsFields(v) } };
  return { nullValue: null };
}

// Convertit les fields Firestore → objet JS
function fsDocToObj(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = fsValToJs(v);
  }
  return out;
}

function fsValToJs(v) {
  if ('stringValue'  in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue);
  if ('doubleValue'  in v) return parseFloat(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue'    in v) return null;
  if ('arrayValue'   in v) return (v.arrayValue.values || []).map(i => fsValToJs(i));
  if ('mapValue'     in v) return fsDocToObj(v.mapValue.fields || {});
  return null;
}

// ── PARSING DATE ──────────────────────────────────────────────────────────────

// Retourne { alteoreDate: "D/M/YYYY", monthKey: "YYYY-MM" } ou null
function parseDate(raw) {
  if (!raw) return null;
  let d;

  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    // ISO : 2026-03-04
    d = new Date(raw + 'T00:00:00Z');
  } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw)) {
    // FR : 4/3/2026 ou 04/03/2026
    const [day, month, year] = raw.split('/');
    d = new Date(`${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}T00:00:00Z`);
  } else if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(raw)) {
    // 04-03-2026
    const [day, month, year] = raw.split('-');
    d = new Date(`${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}T00:00:00Z`);
  } else {
    d = new Date(raw);
  }

  if (isNaN(d)) return null;

  const day   = d.getUTCDate();
  const month = d.getUTCMonth() + 1;
  const year  = d.getUTCFullYear();

  return {
    alteoreDate: `${day}/${month}/${year}`,                         // "4/3/2026"
    monthKey:    `${year}-${String(month).padStart(2,'0')}`,        // "2026-03"
    dayIndex:    day - 1                                            // index 0-based dans le tableau ca[]
  };
}

// ── NORMALISATION CA ─────────────────────────────────────────────────────────

// Convertit n'importe quel format d'entrée en { ht055, ht10, ht20, ht0?, ht21?, ht85? } (nombres)
function normaliseCa(raw) {
  const p = v => Math.max(0, parseFloat((v || '').toString().replace(',', '.')) || 0);
  // Custom TVA fields (pass-through)
  const custFields = {};
  if (raw.ht0  !== undefined) custFields.ht0  = p(raw.ht0);
  if (raw.ht21 !== undefined) custFields.ht21 = p(raw.ht21);
  if (raw.ht85 !== undefined) custFields.ht85 = p(raw.ht85);

  // Format multi-TVA direct
  if (raw.ht055 !== undefined || raw.ht10 !== undefined || raw.ht20 !== undefined) {
    return { ht055: p(raw.ht055), ht10: p(raw.ht10), ht20: p(raw.ht20), ...custFields };
  }

  // Format mono-montant + taux
  if (raw.montantHT !== undefined) {
    const rate = parseFloat(raw.tvaRate) || 20;
    if (rate === 0)    return { ht055: 0, ht10: 0, ht20: 0, ht0: p(raw.montantHT), ...custFields };
    if (rate === 2.1)  return { ht055: 0, ht10: 0, ht20: 0, ht21: p(raw.montantHT), ...custFields };
    if (rate === 5.5)  return { ht055: p(raw.montantHT), ht10: 0, ht20: 0, ...custFields };
    if (rate === 8.5)  return { ht055: 0, ht10: 0, ht20: 0, ht85: p(raw.montantHT), ...custFields };
    if (rate === 10)   return { ht055: 0, ht10: p(raw.montantHT), ht20: 0, ...custFields };
    return               { ht055: 0, ht10: 0, ht20: p(raw.montantHT), ...custFields };
  }

  // Format montant brut sans taux → 20%
  if (raw.montant !== undefined) {
    return { ht055: 0, ht10: 0, ht20: p(raw.montant), ...custFields };
  }

  return null;
}

// ── LOGIQUE PRINCIPALE ───────────────────────────────────────────────────────

async function processLignes(uid, lignes) {
  const updated = [];
  const skipped = [];
  const errors  = [];

  // Grouper les lignes par mois pour minimiser les lectures/écritures Firestore
  const byMonth = {};
  for (const ligne of lignes) {
    const parsed = parseDate(ligne.date);
    if (!parsed) { errors.push({ date: ligne.date, reason: 'date invalide' }); continue; }
    const ca = normaliseCa(ligne);
    if (!ca) { errors.push({ date: ligne.date, reason: 'montant manquant' }); continue; }
    if (!byMonth[parsed.monthKey]) byMonth[parsed.monthKey] = [];
    byMonth[parsed.monthKey].push({ ...parsed, ca, mode: ligne.mode || 'replace' });
  }

  for (const [monthKey, items] of Object.entries(byMonth)) {
    // Charger le doc du mois
    const path = `pilotage/${uid}/months/${monthKey}`;
    let monthDoc = await fsGet(path);

    if (!monthDoc) {
      // Créer un mois vide si n'existe pas encore
      const [year, monthNum] = monthKey.split('-').map(Number);
      const daysInMonth = new Date(year, monthNum, 0).getDate();
      monthDoc = {
        ca: Array.from({ length: daysInMonth }, (_, i) => ({
          date: `${i+1}/${monthNum}/${year}`,
          ht055: '', ht10: '', ht20: ''
        })),
        chargesFixe:  [],
        chargesVar:   [],
        rentreesSupp: [],
        credits:      [],
        leasing:      [],
        previsionCA:  [],
        facturesPro:  []
      };
    }

    // S'assurer que ca[] est un tableau
    if (!Array.isArray(monthDoc.ca)) monthDoc.ca = [];

    for (const item of items) {
      const idx = item.dayIndex;

      // Étendre le tableau si nécessaire
      while (monthDoc.ca.length <= idx) {
        const d = monthDoc.ca.length + 1;
        const [year, m] = monthKey.split('-');
        monthDoc.ca.push({ date: `${d}/${parseInt(m)}/${year}`, ht055: '', ht10: '', ht20: '' });
      }

      const existing = monthDoc.ca[idx];

      if (item.mode === 'add') {
        // Additionner au CA existant
        const p = v => parseFloat((v || '').toString().replace(',', '.')) || 0;
        const merged = {
          date:  existing.date || item.alteoreDate,
          ht055: String(Math.round((p(existing.ht055) + item.ca.ht055) * 100) / 100),
          ht10:  String(Math.round((p(existing.ht10)  + item.ca.ht10)  * 100) / 100),
          ht20:  String(Math.round((p(existing.ht20)  + item.ca.ht20)  * 100) / 100),
        };
        ['ht0','ht21','ht85'].forEach(f => {
          if (item.ca[f] !== undefined) merged[f] = String(Math.round((p(existing[f]) + item.ca[f]) * 100) / 100);
          else if (existing[f]) merged[f] = existing[f];
        });
        monthDoc.ca[idx] = merged;
      } else {
        // Remplacer (default)
        const replaced = {
          date:  existing.date || item.alteoreDate,
          ht055: item.ca.ht055 > 0 ? String(item.ca.ht055) : (existing.ht055 || ''),
          ht10:  item.ca.ht10  > 0 ? String(item.ca.ht10)  : (existing.ht10  || ''),
          ht20:  item.ca.ht20  > 0 ? String(item.ca.ht20)  : (existing.ht20  || ''),
        };
        ['ht0','ht21','ht85'].forEach(f => {
          if (item.ca[f] !== undefined && item.ca[f] > 0) replaced[f] = String(item.ca[f]);
          else if (existing[f]) replaced[f] = existing[f];
        });
        monthDoc.ca[idx] = replaced;
      }

      updated.push(item.alteoreDate);
    }

    // Sauvegarder le mois mis à jour
    await fsSet(path, monthDoc);
  }

  return { updated, skipped, errors };
}

// ── HANDLER VERCEL ────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return errResp(res, 405, 'METHOD_NOT_ALLOWED', 'POST uniquement');

  try {
    // ── 1. Authentification ──
    const auth = req.headers['authorization'] || '';
    if (!auth.startsWith('Bearer ')) {
      return errResp(res, 401, 'MISSING_TOKEN', 'Authorization: Bearer {apiKey} manquant');
    }
    const apiKey = auth.slice(7).trim();
    if (!apiKey || apiKey.length < 20) {
      return errResp(res, 401, 'INVALID_TOKEN', 'Token invalide');
    }

    // ── 2. Retrouver l'uid depuis l'API key ──
    const uid = await fsQuery('users', 'apiKey', apiKey);
    if (!uid) {
      return errResp(res, 401, 'UNKNOWN_KEY', 'Clé API inconnue ou révoquée');
    }

    // ── 3. Vérifier que le plan est actif ──
    const user = await fsGet(`users/${uid}`);
    if (!user) {
      return errResp(res, 401, 'USER_NOT_FOUND', 'Utilisateur introuvable');
    }
    const allowedPlans = ['trial', 'pro', 'max', 'master'];
    if (!allowedPlans.includes(user.plan)) {
      return errResp(res, 403, 'PLAN_RESTRICTED', `Plan "${user.plan}" ne donne pas accès à l'API`);
    }

    // ── 4. Parser le body ──
    const body = req.body;
    if (!body) {
      return errResp(res, 400, 'EMPTY_BODY', 'Body JSON manquant');
    }

    let lignes = [];

    if (Array.isArray(body.lignes)) {
      // Format tableau : { lignes: [ {...}, {...} ] }
      lignes = body.lignes;
    } else if (body.date) {
      // Format ligne unique : { date, ht055, ht10, ht20 }
      lignes = [body];
    } else {
      return errResp(res, 400, 'BAD_FORMAT', 'Body doit contenir "date" ou "lignes": [...]');
    }

    if (lignes.length === 0) {
      return errResp(res, 400, 'EMPTY_LIGNES', 'Aucune ligne à traiter');
    }
    if (lignes.length > 100) {
      return errResp(res, 400, 'TOO_MANY_LIGNES', 'Maximum 100 lignes par appel');
    }

    // ── 5. Traitement ──
    const result = await processLignes(uid, lignes);

    // ── 6. Logger l'appel (optionnel, dans users/{uid}.apiLastCall) ──
    try {
      await fsSet(`users/${uid}`, {
        ...user,
        apiLastCall:   new Date().toISOString(),
        apiCallsTotal: (parseInt(user.apiCallsTotal) || 0) + 1,
      });
    } catch (_) { /* non bloquant */ }

    return res.status(200).json({
      ok:      true,
      updated: result.updated,
      skipped: result.skipped,
      errors:  result.errors,
      message: `${result.updated.length} jour(s) mis à jour`
    });

  } catch (e) {
    console.error('[public-ca] erreur:', e);
    return errResp(res, 500, 'INTERNAL_ERROR', e.message);
  }
};
