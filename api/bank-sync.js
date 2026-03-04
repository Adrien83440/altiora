// api/bank-sync.js
// Proxy GoCardless uniquement — récupère les transactions et les renvoie au client
// Le client écrit ensuite dans Firestore avec son propre token Firebase

const GC_BASE = 'https://bankaccountdata.gocardless.com/api/v2';

async function getAccessToken() {
  const res = await fetch(`${GC_BASE}/token/new/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({
      secret_id: process.env.GC_BANK_SECRET_ID,
      secret_key: process.env.GC_BANK_SECRET_KEY
    })
  });
  const data = await res.json();
  if (!data.access) throw new Error('Token GoCardless invalide: ' + JSON.stringify(data));
  return data.access;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { requisition_id } = req.body;
    if (!requisition_id) return res.status(400).json({ error: 'requisition_id requis' });

    const token = await getAccessToken();

    // 1. Récupérer les comptes du requisition
    const reqRes = await fetch(`${GC_BASE}/requisitions/${requisition_id}/`, {
      headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
    });
    const requisition = await reqRes.json();

    if (!requisition.accounts || requisition.accounts.length === 0) {
      return res.status(400).json({ error: 'Aucun compte trouvé. La connexion bancaire est peut-être expirée.' });
    }

    const accounts = [];

    for (const accountId of requisition.accounts) {
      // 2. Détails du compte
      let details = {};
      try {
        const dRes = await fetch(`${GC_BASE}/accounts/${accountId}/details/`, {
          headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
        });
        details = await dRes.json();
      } catch(e) {}

      // 3. Solde
      let balance = null;
      try {
        const bRes = await fetch(`${GC_BASE}/accounts/${accountId}/balances/`, {
          headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
        });
        const bData = await bRes.json();
        const b = bData.balances?.find(b => b.balanceType === 'interimAvailable') || bData.balances?.[0];
        if (b) balance = `${parseFloat(b.balanceAmount?.amount||0).toLocaleString('fr-FR',{minimumFractionDigits:2})} ${b.balanceAmount?.currency||'€'}`;
      } catch(e) {}

      // 4. Transactions
      let transactions = [];
      try {
        const tRes = await fetch(`${GC_BASE}/accounts/${accountId}/transactions/`, {
          headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
        });
        const tData = await tRes.json();
        transactions = [
          ...(tData.transactions?.booked || []),
          ...(tData.transactions?.pending || [])
        ];
      } catch(e) {}

      // 5. Formater les transactions pour Firestore
      const formatted = [];
      for (const tx of transactions) {
        const dateStr = tx.bookingDate || tx.valueDate || tx.transactionDate;
        if (!dateStr) continue;
        const date = new Date(dateStr);
        const amount = parseFloat(tx.transactionAmount?.amount || 0);
        if (isNaN(amount) || amount === 0) continue;

        const label = (
          tx.remittanceInformationUnstructured ||
          tx.creditorName || tx.debtorName ||
          tx.remittanceInformationStructured ||
          'Transaction bancaire'
        ).substring(0, 80);

        const monthKey = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;

        formatted.push({
          date: `${date.getDate()}/${date.getMonth()+1}/${date.getFullYear()}`,
          monthKey,
          label,
          montant: Math.abs(amount).toFixed(2),
          type: amount > 0 ? 'credit' : 'debit',
          source: 'bank_sync',
          bankTxId: tx.transactionId || tx.internalTransactionId || `${accountId}_${dateStr}_${amount}`
        });
      }

      accounts.push({
        accountId,
        iban: details.account?.iban || '',
        name: details.account?.name || details.account?.ownerName || 'Compte bancaire',
        balance,
        transactions: formatted
      });
    }

    return res.status(200).json({ success: true, accounts });

  } catch(e) {
    console.error('bank-sync error:', e);
    return res.status(500).json({ error: e.message });
  }
}
