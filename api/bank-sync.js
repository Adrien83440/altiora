// api/bank-sync.js
// Récupère les transactions GoCardless et les retourne au client
// L'écriture dans Firestore se fait côté client (bank-validation.html)

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
  if (!data.access) throw new Error('Token GoCardless invalide : ' + JSON.stringify(data));
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
      return res.status(400).json({ error: 'Aucun compte trouvé dans ce requisition' });
    }

    const accounts = [];

    for (const accountId of requisition.accounts) {
      // 2. Détails du compte
      const detailsRes = await fetch(`${GC_BASE}/accounts/${accountId}/details/`, {
        headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
      });
      const details = await detailsRes.json();

      // 3. Solde
      const balanceRes = await fetch(`${GC_BASE}/accounts/${accountId}/balances/`, {
        headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
      });
      const balanceData = await balanceRes.json();
      const balance = balanceData.balances?.find(b => b.balanceType === 'interimAvailable')
        || balanceData.balances?.[0];
      const balanceStr = balance
        ? `${balance.balanceAmount?.amount} ${balance.balanceAmount?.currency}`
        : null;
      const balanceNum = balance ? parseFloat(balance.balanceAmount?.amount || 0) : 0;

      // 4. Transactions (booked + pending)
      const txRes = await fetch(`${GC_BASE}/accounts/${accountId}/transactions/`, {
        headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
      });
      const txData = await txRes.json();
      const rawTxs = [
        ...(txData.transactions?.booked || []),
        ...(txData.transactions?.pending || [])
      ];

      // 5. Formatter chaque transaction
      const transactions = [];
      for (const tx of rawTxs) {
        const dateStr = tx.bookingDate || tx.valueDate || tx.transactionDate;
        if (!dateStr) continue;
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) continue;

        const amount = parseFloat(tx.transactionAmount?.amount || 0);
        if (isNaN(amount) || amount === 0) continue;

        const monthKey = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;

        // Libellé : meilleure source disponible
        const label = (
          tx.creditorName ||
          tx.debtorName ||
          tx.remittanceInformationUnstructured ||
          tx.remittanceInformationStructured ||
          tx.additionalInformation ||
          'Transaction bancaire'
        ).substring(0, 80).trim();

        const dateLabel = `${String(date.getDate()).padStart(2,'0')}/${String(date.getMonth()+1).padStart(2,'0')}/${date.getFullYear()}`;

        transactions.push({
          bankTxId:  tx.transactionId || tx.internalTransactionId || `${accountId}_${dateStr}_${amount}`,
          date:      dateLabel,
          dateISO:   dateStr,
          monthKey,
          label,
          montant:   amount.toFixed(2),
          type:      amount < 0 ? 'debit' : 'credit',
          currency:  tx.transactionAmount?.currency || 'EUR',
          pending:   !tx.bookingDate,
        });
      }

      accounts.push({
        accountId,
        iban:    details.account?.iban || '',
        name:    details.account?.name || details.account?.ownerName || accountId.substring(0, 8),
        balance: balanceStr,
        balanceNum,
        transactionsCount: transactions.length,
        transactions,
      });
    }

    return res.status(200).json({
      success: true,
      accounts,
      totalTransactions: accounts.reduce((s, a) => s + a.transactionsCount, 0)
    });

  } catch (e) {
    console.error('bank-sync error:', e);
    return res.status(500).json({ error: e.message });
  }
}
