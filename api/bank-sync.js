// api/bank-sync.js
// Récupère les transactions GoCardless et les retourne au client
// Zéro écriture Firestore — tout passe par bank-validation.html

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

function parseAmount(val) {
  if (val == null) return 0;
  // Gère "1234.56", "1234,56", "-1234.56", etc.
  return parseFloat(String(val).replace(',', '.')) || 0;
}

function extractIban(details) {
  // GoCardless retourne l'IBAN à différents endroits selon les banques
  return details?.account?.iban
    || details?.account?.bban
    || details?.account?.resourceId
    || details?.iban
    || details?.account?.identifier
    || '';
}

function extractName(details) {
  return details?.account?.name
    || details?.account?.ownerName
    || details?.account?.product
    || details?.account?.displayName
    || details?.account?.currency
    || '';
}

function extractLabel(tx) {
  // Ordre de priorité pour le libellé le plus lisible
  const candidates = [
    tx.creditorName,
    tx.debtorName,
    tx.remittanceInformationUnstructured,
    tx.additionalInformation,
    tx.remittanceInformationStructuredArray?.[0]?.reference,
    tx.remittanceInformationStructured,
    tx.proprietaryBankTransactionCode,
    'Transaction bancaire'
  ];
  const label = candidates.find(c => c && c.trim() && c.trim().length > 1) || 'Transaction bancaire';
  return label.substring(0, 80).trim();
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
    console.log('Requisition status:', requisition.status, '| accounts:', requisition.accounts?.length);

    if (!requisition.accounts || requisition.accounts.length === 0) {
      return res.status(400).json({
        error: 'Aucun compte trouvé',
        detail: `Statut requisition: ${requisition.status}. Reconnectez votre banque.`
      });
    }

    const accounts = [];

    for (const accountId of requisition.accounts) {
      console.log('Processing account:', accountId);

      // 2. Détails du compte
      let details = {};
      try {
        const r = await fetch(`${GC_BASE}/accounts/${accountId}/details/`, {
          headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
        });
        details = await r.json();
        console.log('Details keys:', Object.keys(details?.account || {}));
      } catch(e) { console.warn('Details error:', e.message); }

      // 3. Solde
      let balanceStr = null;
      let balanceNum = 0;
      try {
        const r = await fetch(`${GC_BASE}/accounts/${accountId}/balances/`, {
          headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
        });
        const bd = await r.json();
        const bal = bd.balances?.find(b => b.balanceType === 'interimAvailable')
          || bd.balances?.find(b => b.balanceType === 'closingBooked')
          || bd.balances?.[0];
        if (bal) {
          balanceNum = parseAmount(bal.balanceAmount?.amount);
          const currency = bal.balanceAmount?.currency || 'EUR';
          balanceStr = `${balanceNum.toLocaleString('fr-FR', {minimumFractionDigits:2})} ${currency}`;
          console.log('Balance:', balanceStr);
        }
      } catch(e) { console.warn('Balance error:', e.message); }

      // 4. Transactions
      let rawTxs = [];
      try {
        const r = await fetch(`${GC_BASE}/accounts/${accountId}/transactions/`, {
          headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
        });
        const txData = await r.json();
        rawTxs = [
          ...(txData.transactions?.booked || []),
          ...(txData.transactions?.pending || [])
        ];
        console.log('Raw transactions:', rawTxs.length);
        // Log un exemple pour debug
        if (rawTxs.length > 0) {
          const ex = rawTxs[0];
          console.log('TX sample keys:', Object.keys(ex));
          console.log('TX sample amount:', ex.transactionAmount);
        }
      } catch(e) { console.warn('Transactions error:', e.message); }

      // 5. Formater les transactions
      const transactions = [];
      for (const tx of rawTxs) {
        const dateStr = tx.bookingDate || tx.valueDate || tx.transactionDate;
        if (!dateStr) continue;

        // Construire la date sans ambiguïté timezone
        const [y, m, d] = dateStr.split('-').map(Number);
        if (!y || !m || !d) continue;

        const amount = parseAmount(tx.transactionAmount?.amount);
        if (amount === 0) continue;

        const monthKey = `${y}-${String(m).padStart(2,'0')}`;
        const dateLabel = `${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}/${y}`;
        const label = extractLabel(tx);

        transactions.push({
          bankTxId:  tx.transactionId || tx.internalTransactionId || `${accountId}_${dateStr}_${amount}`,
          date:      dateLabel,
          dateISO:   dateStr,
          monthKey,
          label,
          montant:   Math.abs(amount).toFixed(2),
          type:      amount < 0 ? 'debit' : 'credit',
          currency:  tx.transactionAmount?.currency || 'EUR',
          pending:   !tx.bookingDate,
        });
      }

      console.log('Formatted transactions:', transactions.length, '| debits:', transactions.filter(t=>t.type==='debit').length);

      accounts.push({
        accountId,
        iban:    extractIban(details),
        name:    extractName(details),
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
