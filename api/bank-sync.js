// api/bank-sync.js  — SANS Firebase Admin SDK
// GoCardless uniquement → retourne JSON au client
// Le client (banque.html) écrit dans Firestore via Firebase SDK browser
//
// Traitement séquentiel des comptes (fiable), timeout individuel par fetch,
// filtre optional par selected_accounts.

const GC_BASE = 'https://bankaccountdata.gocardless.com/api/v2';

async function getGCToken() {
  const res = await fetch(GC_BASE + '/token/new/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({
      secret_id:  process.env.GC_BANK_SECRET_ID,
      secret_key: process.env.GC_BANK_SECRET_KEY
    })
  });
  const data = await res.json();
  if (!data.access) throw new Error('Token GoCardless invalide : ' + JSON.stringify(data));
  return data.access;
}

function parseAmount(val) {
  if (val == null) return 0;
  return parseFloat(String(val).replace(',', '.')) || 0;
}

function extractLabel(tx) {
  const c = [
    tx.creditorName, tx.debtorName,
    tx.remittanceInformationUnstructured,
    tx.remittanceInformationStructuredArray?.[0]?.reference,
    tx.remittanceInformationStructured,
    tx.additionalInformation, tx.merchantName,
    tx.proprietaryBankTransactionCode,
  ];
  const found = c.find(v => v && String(v).trim().length > 1);
  return found ? String(found).trim().substring(0, 120) : 'Transaction bancaire';
}

// Fetch avec timeout individuel (25s par appel) + safe JSON
async function gcFetch(url, headers) {
  const res = await Promise.race([
    fetch(url, { headers }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout 25s: ' + url.split('/').slice(-2).join('/'))), 25000)
    )
  ]);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error('HTTP ' + res.status + ' sur ' + url.split('/').slice(-2).join('/') + ' : ' + txt.substring(0, 200));
  }
  return res.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { requisition_id, date_from, selected_accounts } = req.body || {};
    if (!requisition_id) return res.status(400).json({ error: 'requisition_id manquant' });

    if (!process.env.GC_BANK_SECRET_ID || !process.env.GC_BANK_SECRET_KEY) {
      return res.status(500).json({ error: 'Variables GC_BANK_SECRET_ID / GC_BANK_SECRET_KEY manquantes dans Vercel' });
    }

    const token = await getGCToken();
    const gcH = { 'Authorization': 'Bearer ' + token, 'accept': 'application/json' };

    // Requisition
    const rRes  = await fetch(GC_BASE + '/requisitions/' + requisition_id + '/', { headers: gcH });
    const rData = await rRes.json();
    console.log('Req status:', rData.status, '| nb accounts:', rData.accounts?.length);

    if (!rData.accounts || rData.accounts.length === 0) {
      return res.status(400).json({
        error: rData.status === 'EXPIRED'
          ? 'Connexion expirée. Déconnectez et reconnectez votre banque.'
          : 'Aucun compte trouvé (statut: ' + (rData.status || 'inconnu') + ')'
      });
    }

    // ── Filtrer par comptes sélectionnés si spécifié ──
    let accountIds = rData.accounts;
    if (Array.isArray(selected_accounts) && selected_accounts.length > 0) {
      accountIds = rData.accounts.filter(id => selected_accounts.includes(id));
      console.log('Filtered accounts:', accountIds.length, '/', rData.accounts.length);
      if (accountIds.length === 0) {
        return res.status(400).json({ error: 'Aucun des comptes sélectionnés n\'a été trouvé dans la requisition.' });
      }
    }

    // ── Traiter chaque compte séquentiellement (fiable, pas de rate-limit) ──
    const accounts = [];

    for (const accountId of accountIds) {
      try {
        // Détails
        let iban = accountId, name = 'Compte bancaire';
        try {
          const detData = await gcFetch(GC_BASE + '/accounts/' + accountId + '/details/', gcH);
          const acc = detData.account || detData || {};
          iban = acc.iban || acc.bban || acc.resourceId || accountId;
          name = acc.name || acc.ownerName || acc.product || 'Compte bancaire';
        } catch(e) { console.warn('[' + accountId + '] details err:', e.message); }
        console.log('[' + accountId + '] iban=' + iban + ' name=' + name);

        // Solde
        let balanceNum = 0, balanceStr = null;
        try {
          const bData = await gcFetch(GC_BASE + '/accounts/' + accountId + '/balances/', gcH);
          const b = bData.balances?.find(x => x.balanceType === 'interimAvailable')
                 || bData.balances?.find(x => x.balanceType === 'closingBooked')
                 || bData.balances?.[0];
          if (b) {
            balanceNum = parseAmount(b.balanceAmount?.amount);
            const curr = b.balanceAmount?.currency || 'EUR';
            balanceStr = balanceNum.toLocaleString('fr-FR', {minimumFractionDigits:2, maximumFractionDigits:2}) + ' ' + curr;
            console.log('[' + accountId + '] balance: ' + balanceStr);
          }
        } catch(e) { console.warn('[' + accountId + '] balance err:', e.message); }

        // Transactions
        let rawTxs = [];
        try {
          let txUrl = GC_BASE + '/accounts/' + accountId + '/transactions/';
          if (date_from && /^\d{4}-\d{2}-\d{2}$/.test(date_from)) {
            txUrl += '?date_from=' + date_from;
          }
          const txData = await gcFetch(txUrl, gcH);
          rawTxs = [...(txData.transactions?.booked || []), ...(txData.transactions?.pending || [])];
          console.log('[' + accountId + '] ' + rawTxs.length + ' transactions');
          if (rawTxs[0]) console.log('sample:', JSON.stringify(rawTxs[0]).substring(0, 250));
        } catch(e) { console.warn('[' + accountId + '] tx err:', e.message); }

        const transactions = [];
        for (const tx of rawTxs) {
          const dateStr = tx.bookingDate || tx.valueDate || tx.transactionDate;
          if (!dateStr || typeof dateStr !== 'string') continue;
          const [y, m, d] = dateStr.split('-').map(Number);
          if (!y || !m || !d) continue;
          const rawAmt = parseAmount(tx.transactionAmount?.amount);
          if (rawAmt === 0) continue;
          transactions.push({
            bankTxId:  tx.transactionId || tx.internalTransactionId || accountId + '_' + dateStr + '_' + Math.abs(rawAmt),
            date:      String(d).padStart(2,'0') + '/' + String(m).padStart(2,'0') + '/' + y,
            dateISO:   dateStr,
            monthKey:  y + '-' + String(m).padStart(2,'0'),
            label:     extractLabel(tx),
            montant:   Math.abs(rawAmt).toFixed(2),
            type:      rawAmt < 0 ? 'debit' : 'credit',
            currency:  tx.transactionAmount?.currency || 'EUR',
            pending:   !tx.bookingDate,
            accountId, accountName: name, accountIban: iban
          });
        }

        accounts.push({
          accountId, iban, name,
          balance: balanceStr,
          balanceNum,
          transactionsCount: transactions.length,
          debitsCount: transactions.filter(t => t.type === 'debit').length,
          transactions
        });

      } catch(e) { console.error('[' + accountId + '] FATAL:', e.message); }
    }

    if (accounts.length === 0) return res.status(500).json({ error: 'Impossible de récupérer les données bancaires.' });

    const total = accounts.reduce((s, a) => s + a.transactions.length, 0);
    console.log('OK — total tx:', total);
    return res.status(200).json({ success: true, accounts, totalTransactions: total });

  } catch(e) {
    console.error('bank-sync FATAL:', e);
    return res.status(500).json({ error: e.message || 'Erreur interne serveur' });
  }
}
