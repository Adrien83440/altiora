// api/rh-planning-salarie.js
// Proxy sécurisé pour lire le planning d'un salarié depuis l'espace public
// Sécurité : vérifie que le publicId existe dans rh_employes_public avant de lire rh/{uid}/plan_*

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { publicId, year, month } = req.body;
    if (!publicId || year === undefined || month === undefined) {
      return res.status(400).json({ error: 'Paramètres manquants : publicId, year, month' });
    }

    const projectId = process.env.FIREBASE_PROJECT_ID || 'altiora-70599';
    const apiKey    = process.env.FIREBASE_API_KEY;
    const email     = process.env.FIREBASE_API_EMAIL;
    const password  = process.env.FIREBASE_API_PASSWORD;

    // ── 1. Obtenir un token admin via email/password ──
    const authRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true })
      }
    );
    const authData = await authRes.json();
    if (!authData.idToken) {
      return res.status(500).json({ error: 'Auth admin échouée' });
    }
    const token = authData.idToken;

    const fsBase = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // ── 2. Vérifier que publicId existe et récupérer uid + empId ──
    const pubRes = await fetch(`${fsBase}/rh_employes_public/${publicId}`, { headers });
    if (!pubRes.ok) {
      return res.status(404).json({ error: 'Salarié introuvable' });
    }
    const pubDoc = await pubRes.json();
    if (!pubDoc.fields) {
      return res.status(404).json({ error: 'Salarié introuvable' });
    }

    const uid   = pubDoc.fields.uid?.stringValue;
    const empId = pubDoc.fields.empId?.stringValue;
    if (!uid || !empId) {
      return res.status(404).json({ error: 'uid ou empId manquant dans rh_employes_public' });
    }

    // ── 3. Calculer les semaines du mois demandé ──
    const y = parseInt(year);
    const m = parseInt(month); // 0-based
    const weekKeys = {};
    const nbDays = new Date(y, m + 1, 0).getDate();
    for (let d = 1; d <= nbDays; d++) {
      const dt  = new Date(y, m, d);
      const mon = new Date(dt);
      const dow = mon.getDay();
      const diff = (dow === 0) ? -6 : 1 - dow;
      mon.setDate(mon.getDate() + diff);
      mon.setHours(0, 0, 0, 0);
      const wk = mon.toISOString().slice(0, 10).replace(/-/g, '');
      weekKeys[wk] = true;
    }

    // ── 4. Lire les documents planning semaine par semaine ──
    // On utilise l'API REST avec runQuery pour lire tous les docs d'une collection
    // dont l'ID se termine par _{empId}
    const planningCache = {};

    for (const wk of Object.keys(weekKeys)) {
      const collPath = `rh/${uid}/plan_${wk}`;

      // Utiliser runQuery avec un filtre sur le champ __name__ n'est pas dispo en REST simple.
      // On liste tous les docs de la collection et on filtre côté serveur.
      // C'est OK car le module admin fait la même chose — et on a le token admin.
      const listRes = await fetch(
        `${fsBase}/${collPath}?pageSize=50`,
        { headers }
      );

      if (!listRes.ok) continue;

      const listData = await listRes.json();
      const documents = listData.documents || [];

      for (const doc of documents) {
        // doc.name = "projects/.../documents/rh/{uid}/plan_{wk}/{docId}"
        const docId = doc.name.split('/').pop();
        const suffix = '_' + empId;
        if (!docId.endsWith(suffix)) continue;

        // dateStr = docId sans le suffixe _empId (lastIndexOf pour éviter collision)
        const idx = docId.lastIndexOf(suffix);
        const dateStr = docId.slice(0, idx);

        // Convertir les fields Firestore → objets JS simples
        const items = parseFirestoreArray(doc.fields?.items);
        planningCache[dateStr] = items;
      }
    }

    return res.status(200).json({ planningCache, uid, empId });

  } catch (e) {
    console.error('[rh-planning-salarie]', e);
    return res.status(500).json({ error: e.message });
  }
}

// ── Helpers de désérialisation Firestore REST ──

function parseFirestoreValue(val) {
  if (!val) return null;
  if (val.stringValue  !== undefined) return val.stringValue;
  if (val.integerValue !== undefined) return parseInt(val.integerValue);
  if (val.doubleValue  !== undefined) return parseFloat(val.doubleValue);
  if (val.booleanValue !== undefined) return val.booleanValue;
  if (val.nullValue    !== undefined) return null;
  if (val.arrayValue)  return (val.arrayValue.values || []).map(parseFirestoreValue);
  if (val.mapValue)    return parseFirestoreMap(val.mapValue.fields || {});
  return null;
}

function parseFirestoreMap(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields)) {
    obj[k] = parseFirestoreValue(v);
  }
  return obj;
}

function parseFirestoreArray(fieldVal) {
  if (!fieldVal?.arrayValue) return [];
  return (fieldVal.arrayValue.values || []).map(parseFirestoreValue);
}
