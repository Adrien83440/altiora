// api/bank-debug.js
// Retourne les données RAW de GoCardless — pour diagnostiquer Qonto

const GC_BASE = 'https://bankaccountdata.gocardless.com/api/v2';

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
  if (!data.access) throw new Error('Token invalide: ' + JSON.stringify(data));
  return data.access;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { requisition_id } = req.body || {};
    if (!requisition_id) return res.status(400).json({ error: 'requisition_id manquant' });

    const token = await getGCToken();
    const gcH = { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' };

    // Requisition
    const rRes  = await fetch(`${GC_BASE}/requisitions/${requisition_id}/`, { headers: gcH });
    const rData = await rRes.json();

    const result = {
      requisition: {
        id: rData.id,
        status: rData.status,
        institution_id: rData.institution_id,
        accounts: rData.accounts,
      },
      accounts: []
    };

    for (const accountId of (rData.accounts || [])) {
      const accData = { accountId };

      // Details RAW
      try {
        const dRes  = await fetch(`${GC_BASE}/accounts/${accountId}/details/`, { headers: gcH });
        accData.details_raw = await dRes.json();
      } catch(e) { accData.details_error = e.message; }

      // Balances RAW
      try {
        const bRes  = await fetch(`${GC_BASE}/accounts/${accountId}/balances/`, { headers: gcH });
        accData.balances_raw = await bRes.json();
      } catch(e) { accData.balances_error = e.message; }

      // Transactions RAW (5 premières seulement)
      try {
        const txRes  = await fetch(`${GC_BASE}/accounts/${accountId}/transactions/`, { headers: gcH });
        const txData = await txRes.json();
        const booked  = txData.transactions?.booked  || [];
        const pending = txData.transactions?.pending || [];
        accData.transactions_count = { booked: booked.length, pending: pending.length };
        // 3 premiers exemples de chaque
        accData.transactions_sample_booked  = booked.slice(0, 3);
        accData.transactions_sample_pending = pending.slice(0, 2);
        accData.transactions_raw_keys = booked[0] ? Object.keys(booked[0]) : [];
      } catch(e) { accData.transactions_error = e.message; }

      result.accounts.push(accData);
    }

    return res.status(200).json(result);

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
