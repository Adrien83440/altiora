// api/bank-sync.js  — SANS Firebase Admin SDK
// GoCardless uniquement → retourne JSON au client
// Le client (banque.html) écrit dans Firestore via Firebase SDK browser
//
// Optimisé : appels parallélisés (details + balances + transactions en //),
//            comptes traités en parallèle, timeout individuel par fetch.

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

// Fetch avec timeout individuel (20s par appel)
function fetchWithTimeout(url, opts = {}, timeoutMs = 20000) {
  return Promise.race([
    fetch(url, opts),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout ' + timeoutMs + 'ms: ' + url.split('/').slice(-2).join('/'))), timeoutMs)
    )
  ]);
}

// Traite un compte : details + balances + transactions en parallèle
// Si preview=true, on ne récupère que details+balances (pas de transactions)
async function processAccount(accountId, gcH, date_from, preview) {
  // Préparer les appels
  const fetches = [
    fetchWithTimeout(GC_BASE + '/accounts/' + accountId + '/details/',  { headers: gcH }).then(r => r.json()),
    fetchWithTimeout(GC_BASE + '/accounts/' + accountId + '/balances/', { headers: gcH }).then(r => r.json()),
  ];

  // Transactions seulement en mode normal (pas preview)
  if (!preview) {
    let txUrl = GC_BASE + '/accounts/' + accountId + '/transactions/';
    if (date_from && /^\d{4}-\d{2}-\d{2}$/.test(date_from)) {
      txUrl += '?date_from=' + date_from;
    }
    fetches.push(fetchWithTimeout(txUrl, { headers: gcH }).then(r => r.json()));
  }

  const results = await Promise.allSettled(fetches);
  const detResult = results[0];
  const balResult = results[1];
  const txResult  = results[2]; // undefined en mode preview

  // ── Details ──
  let iban = accountId, name = 'Compte bancaire';
  if (detResult.status === 'fulfilled') {
    const acc = detResult.value.account || detResult.value || {};
    iban = acc.iban || acc.bban || acc.resourceId || accountId;
    name = acc.name || acc.ownerName || acc.product || 'Compte bancaire';
  } else {
    console.warn('[' + accountId + '] details err:', detResult.reason?.message);
  }
  console.log('[' + accountId + '] iban=' + iban + ' name=' + name);

  // ── Balances ──
  let balanceNum = 0, balanceStr = null;
  if (balResult.status === 'fulfilled') {
    const bData = balResult.value;
    const b = bData.balances?.find(x => x.balanceType === 'interimAvailable')
           || bData.balances?.find(x => x.balanceType === 'closingBooked')
           || bData.balances?.[0];
    if (b) {
      balanceNum = parseAmount(b.balanceAmount?.amount);
      const curr = b.balanceAmount?.currency || 'EUR';
      balanceStr = balanceNum.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + curr;
      console.log('[' + accountId + '] balance: ' + balanceStr);
    }
  } else {
    console.warn('[' + accountId + '] balance err:', balResult.reason?.message);
  }

  // ── Transactions (skip en mode preview) ──
  let rawTxs = [];
  if (!preview && txResult && txResult.status === 'fulfilled') {
    const txData = txResult.value;
    rawTxs = [...(txData.transactions?.booked || []), ...(txData.transactions?.pending || [])];
    console.log('[' + accountId + '] ' + rawTxs.length + ' transactions');
    if (rawTxs[0]) console.log('sample:', JSON.stringify(rawTxs[0]).substring(0, 250));
  } else if (!preview && txResult) {
    console.warn('[' + accountId + '] tx err:', txResult.reason?.message);
  }

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
      date:      String(d).padStart(2, '0') + '/' + String(m).padStart(2, '0') + '/' + y,
      dateISO:   dateStr,
      monthKey:  y + '-' + String(m).padStart(2, '0'),
      label:     extractLabel(tx),
      montant:   Math.abs(rawAmt).toFixed(2),
      type:      rawAmt < 0 ? 'debit' : 'credit',
      currency:  tx.transactionAmount?.currency || 'EUR',
      pending:   !tx.bookingDate,
      accountId, accountName: name, accountIban: iban
    });
  }

  return {
    accountId, iban, name,
    balance: balanceStr,
    balanceNum,
    transactionsCount: transactions.length,
    debitsCount: transactions.filter(t => t.type === 'debit').length,
    transactions
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { requisition_id, date_from, selected_accounts, preview } = req.body || {};
    if (!requisition_id) return res.status(400).json({ error: 'requisition_id manquant' });

    if (!process.env.GC_BANK_SECRET_ID || !process.env.GC_BANK_SECRET_KEY) {
      return res.status(500).json({ error: 'Variables GC_BANK_SECRET_ID / GC_BANK_SECRET_KEY manquantes dans Vercel' });
    }

    const token = await getGCToken();
    const gcH = { 'Authorization': 'Bearer ' + token, 'accept': 'application/json' };

    // Requisition
    const rRes  = await fetchWithTimeout(GC_BASE + '/requisitions/' + requisition_id + '/', { headers: gcH });
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

    // ── Traiter les comptes en parallèle ──
    const isPreview = !!preview;
    if (isPreview) console.log('MODE PREVIEW — pas de transactions');
    const results = await Promise.allSettled(
      accountIds.map(accountId => processAccount(accountId, gcH, date_from, isPreview))
    );

    const accounts = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'fulfilled') {
        accounts.push(results[i].value);
      } else {
        console.error('[' + accountIds[i] + '] FATAL:', results[i].reason?.message);
      }
    }

    if (accounts.length === 0) return res.status(500).json({ error: 'Impossible de récupérer les données bancaires.' });

    if (isPreview) {
      // Mode preview : retourne juste les infos compte (pas de transactions)
      const previewAccounts = accounts.map(a => ({
        accountId: a.accountId, iban: a.iban, name: a.name,
        balance: a.balance, balanceNum: a.balanceNum
      }));
      console.log('PREVIEW OK —', previewAccounts.length, 'comptes');
      return res.status(200).json({ success: true, preview: true, accounts: previewAccounts });
    }

    const total = accounts.reduce((s, a) => s + a.transactions.length, 0);
    console.log('OK — total tx:', total);
    return res.status(200).json({ success: true, accounts, totalTransactions: total });

  } catch(e) {
    console.error('bank-sync FATAL:', e);
    return res.status(500).json({ error: e.message || 'Erreur interne serveur' });
  }
}
