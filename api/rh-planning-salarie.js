// api/rh-planning-salarie.js
// Proxy sécurisé — lit le planning d'un salarié via Firebase Admin SDK (bypass règles)
// Sécurité : vérifie que publicId existe dans rh_employes_public avant de lire rh/{uid}/plan_*

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

function getDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: 'altiora-70599',
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
  return getFirestore();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { publicId, year, month } = req.body || {};
    if (!publicId || year === undefined || month === undefined) {
      return res.status(400).json({ error: 'Paramètres manquants : publicId, year, month' });
    }

    const db = getDb();

    // 1. Vérifier publicId et récupérer uid + empId
    const pubSnap = await db.collection('rh_employes_public').doc(publicId).get();
    if (!pubSnap.exists) {
      return res.status(404).json({ error: 'Salarié introuvable' });
    }
    const pubData = pubSnap.data();
    const uid   = pubData.uid;
    const empId = pubData.empId;
    if (!uid || !empId) {
      return res.status(404).json({ error: 'uid ou empId manquant dans rh_employes_public' });
    }

    // 2. Calculer les semaines du mois demandé
    const y = parseInt(year);
    const m = parseInt(month); // 0-based
    const weekKeys = new Set();
    const nbDays = new Date(y, m + 1, 0).getDate();
    for (let d = 1; d <= nbDays; d++) {
      const dt  = new Date(y, m, d);
      const mon = new Date(dt);
      const dow = mon.getDay();
      const diff = (dow === 0) ? -6 : 1 - dow;
      mon.setDate(mon.getDate() + diff);
      mon.setHours(0, 0, 0, 0);
      const wk = mon.toISOString().slice(0, 10).replace(/-/g, '');
      weekKeys.add(wk);
    }

    // 3. Lire les documents planning via Admin SDK (bypass règles Firestore)
    const planningCache = {};
    const suffix = '_' + empId;

    for (const wk of weekKeys) {
      try {
        const collRef = db.collection('rh').doc(uid).collection('plan_' + wk);
        const snap = await collRef.get();
        snap.forEach(docSnap => {
          const docId = docSnap.id;
          if (!docId.endsWith(suffix)) return;
          const idx = docId.lastIndexOf(suffix);
          const dateStr = docId.slice(0, idx);
          planningCache[dateStr] = docSnap.data().items || [];
        });
      } catch(e) {
        console.warn('[rh-planning-salarie] wk=' + wk, e.message);
      }
    }

    console.log('[rh-planning-salarie] OK uid:', uid, 'empId:', empId, 'jours:', Object.keys(planningCache).length);
    return res.status(200).json({ planningCache, uid, empId });

  } catch(e) {
    console.error('[rh-planning-salarie]', e);
    return res.status(500).json({ error: e.message });
  }
};
