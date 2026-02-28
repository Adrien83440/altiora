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

    console.log('[rh-planning-salarie] uid:', uid, 'empId:', empId, 'weekKeys:', Object.keys(weekKeys));

    for (const wk of Object.keys(weekKeys)) {
      const collPath = `rh/${uid}/plan_${wk}`;
      const url = `${fsBase}/${collPath}?pageSize=100`;
      console.log('[rh-planning-salarie] listing:', url);

      const listRes = await fetch(url, { headers });
      const listText = await listRes.text();
      console.log('[rh-planning-salarie] response status:', listRes.status, 'body preview:', listText.slice(0, 300));

      if (!listRes.ok) continue;

      let listData;
      try { listData = JSON.parse(listText); } catch(e) { continue; }
      const documents = listData.documents || [];
      console.log('[rh-planning-salarie] wk', wk, '→', documents.length, 'docs');

      for (const doc of documents) {
        const docId = doc.name.split('/').pop();
        const suffix = '_' + empId;
        console.log('[rh-planning-salarie] docId:', docId, 'endsWith', suffix, '?', docId.endsWith(suffix));
        if (!docId.endsWith(suffix)) continue;

        const idx = docId.lastIndexOf(suffix);
        const dateStr = docId.slice(0, idx);
        const items = parseFirestoreArray(doc.fields?.items);
        console.log('[rh-planning-salarie] → dateStr:', dateStr, 'items:', items.length);
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
