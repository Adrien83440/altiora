// api/admin-cleanup-credits.js
// Supprime des lignes de crédit d'un utilisateur sur TOUS les mois
// Usage: /api/admin-cleanup-credits?uid=xxx&match=CREDIT%20MUT&secret=xxx
//
// Paramètres :
//   uid    = UID Firestore de l'utilisateur
//   match  = texte à chercher dans le fournisseur (insensible à la casse)
//   secret = ADMIN_SECRET env var (sécurité)
//   dry    = 1 pour simuler sans modifier (optionnel)

const PROJECT = 'altiora-70599';
const FB_KEY  = 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';

async function fsGet(path) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${path}?key=${FB_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function fsList(collectionPath) {
  let all = [];
  let pageToken = '';
  do {
    const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${collectionPath}?key=${FB_KEY}&pageSize=100${pageToken ? '&pageToken=' + pageToken : ''}`;
    const res = await fetch(url);
    if (!res.ok) break;
    const data = await res.json();
    if (data.documents) all = all.concat(data.documents);
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return all;
}

async function fsPatch(docPath, fields) {
  const masks = Object.keys(fields).map(k => 'updateMask.fieldPaths=' + k).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${docPath}?key=${FB_KEY}&${masks}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!res.ok) throw new Error('PATCH failed: ' + (await res.text()).slice(0, 200));
  return res.json();
}

// Convertir un objet JS en format Firestore
function toFsValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'number') return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFsValue) } };
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) fields[k] = toFsValue(v);
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

// Convertir une valeur Firestore en JS
function fromFsValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ('mapValue' in v) {
    const obj = {};
    for (const [k, fv] of Object.entries(v.mapValue.fields || {})) obj[k] = fromFsValue(fv);
    return obj;
  }
  return null;
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret = process.env.ADMIN_SECRET || 'alteore-admin-2026';
  const { uid, match, dry } = req.query;

  if (req.query.secret !== secret) {
    return res.status(403).json({ error: 'Secret invalide' });
  }
  if (!uid || !match) {
    return res.status(400).json({ error: 'Paramètres manquants: uid et match requis' });
  }

  const isDry = dry === '1';
  const pattern = match.toUpperCase();
  const results = [];
  let totalRemoved = 0;

  try {
    // Lister tous les mois
    const docs = await fsList(`pilotage/${uid}/months`);

    for (const doc of docs) {
      const monthId = doc.name.split('/').pop();
      const creditsField = doc.fields && doc.fields.credits;
      if (!creditsField || !creditsField.arrayValue || !creditsField.arrayValue.values) continue;

      const credits = creditsField.arrayValue.values.map(fromFsValue);
      const before = credits.length;
      const cleaned = credits.filter(c => {
        const nom = ((c && c.fournisseur) || (c && c.nom) || '').toUpperCase();
        return !nom.includes(pattern);
      });

      if (cleaned.length < before) {
        const removed = before - cleaned.length;
        totalRemoved += removed;
        results.push({ month: monthId, removed, remaining: cleaned.length });

        if (!isDry) {
          await fsPatch(`pilotage/${uid}/months/${monthId}`, {
            credits: toFsValue(cleaned)
          });
        }
      }
    }

    return res.status(200).json({
      success: true,
      mode: isDry ? 'DRY RUN (aucune modification)' : 'APPLIED',
      uid,
      pattern: match,
      totalMonths: docs.length,
      totalRemoved,
      details: results
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
