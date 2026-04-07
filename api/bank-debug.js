// api/bank-debug.js
// Récupère les données BRUTES GoCardless pour diagnostic.
// Appelé par diagnostic.html et par le bouton 🔍 Debug de banque.html.

const GC_BASE = 'https://bankaccountdata.gocardless.com/api/v2';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function getGCToken() {
  const res = await fetch(`${GC_BASE}/token/new/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({
      secret_id:  process.env.GC_BANK_SECRET_ID,
      secret_key: process.env.GC_BANK_SECRET_KEY
    })
  });
  const data = await res.json();
  if (!data.access) throw new Error('Token GoCardless invalide: ' + JSON.stringify(data));
  return data.access;
}

async function gcFetch(url, headers) {
  await wait(350); // anti rate-limit GoCardless
  return fetch(url, { headers });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { requisition_id } = req.body || {};
    if (!requisition_id) return res.status(400).json({ error: 'requisition_id manquant' });

    if (!process.env.GC_BANK_SECRET_ID || !process.env.GC_BANK_SECRET_KEY) {
      return res.status(500).json({ error: 'Variables GC_BANK_SECRET_ID / GC_BANK_SECRET_KEY manquantes dans Vercel' });
    }

    const token = await getGCToken();
    const gcH = { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' };

    // 1. Lire la requisition
    const rRes = await gcFetch(`${GC_BASE}/requisitions/${requisition_id}/`, gcH);
    const rData = await rRes.json();

    const out = {
      success: true,
      requisition: {
        id: rData.id || null,
        status: rData.status || 'unknown',
        institution_id: rData.institution_id || null,
        created: rData.created || null,
        agreement: rData.agreement || null,
        link: rData.link || null
      },
      accounts: []
    };

    if (!rData.accounts || rData.accounts.length === 0) {
      out.warning = 'Aucun compte dans la requisition (statut: ' + (rData.status || 'inconnu') + ')';
      return res.status(200).json(out);
    }

    // 2. Pour chaque compte, lire détails / soldes / transactions brutes
    for (const accountId of rData.accounts) {
      const accountInfo = { accountId };

      // Détails
      try {
        const detRes = await gcFetch(`${GC_BASE}/accounts/${accountId}/details/`, gcH);
        accountInfo.details_status = detRes.status;
        accountInfo.details_raw = await detRes.json();
      } catch(e) {
        accountInfo.details_error = e.message;
      }

      // Soldes
      try {
        const bRes = await gcFetch(`${GC_BASE}/accounts/${accountId}/balances/`, gcH);
        accountInfo.balances_status = bRes.status;
        accountInfo.balances_raw = await bRes.json();
      } catch(e) {
        accountInfo.balances_error = e.message;
      }

      // Transactions
      try {
        const txRes = await gcFetch(`${GC_BASE}/accounts/${accountId}/transactions/`, gcH);
        accountInfo.transactions_status = txRes.status;
        const txData = await txRes.json();
        const booked  = (txData.transactions && txData.transactions.booked)  || [];
        const pending = (txData.transactions && txData.transactions.pending) || [];
        accountInfo.transactions_count = { booked: booked.length, pending: pending.length };
        // Échantillon : 5 premières booked + 1 pending pour voir tous les champs disponibles
        accountInfo.transactions_sample_booked  = booked.slice(0, 5);
        accountInfo.transactions_sample_pending = pending.slice(0, 1);
        // Liste des champs DISTINCTS rencontrés (utile pour diagnostiquer un champ libellé manquant)
        const fieldsSet = new Set();
        booked.forEach(function(t){
          if (t && typeof t === 'object') Object.keys(t).forEach(function(k){ fieldsSet.add(k); });
        });
        accountInfo.transactions_raw_keys = Array.from(fieldsSet).sort();
      } catch(e) {
        accountInfo.transactions_error = e.message;
      }

      out.accounts.push(accountInfo);
    }

    return res.status(200).json(out);

  } catch(e) {
    console.error('bank-debug error:', e);
    return res.status(500).json({ error: e.message || 'Erreur interne' });
  }
}
