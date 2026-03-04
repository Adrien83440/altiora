// api/bank-sync.js
// Récupère les transactions GoCardless via Firebase Admin
// Écrit dans bank_pending (pas dans Pilotage) — validation manuelle dans bank-validation.html

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const GC_BASE = 'https://bankaccountdata.gocardless.com/api/v2';

function initFirebase() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({
    credential: cert({
      projectId: 'altiora-70599',
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
    })
  });
  return getFirestore();
}

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
  return parseFloat(String(val).replace(',', '.')) || 0;
}

function extractLabel(tx) {
  const candidates = [
    tx.creditorName,
    tx.debtorName,
    tx.remittanceInformationUnstructured,
    tx.additionalInformation,
    tx.remittanceInformationStructured,
    tx.proprietaryBankTransactionCode,
  ];
  const label = candidates.find(c => c && String(c).trim().length > 1) || 'Transaction bancaire';
  return String(label).substring(0, 80).trim();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { uid, requisition_id } = req.body;
    if (!uid || !requisition_id) return res.status(400).json({ error: 'uid + requisition_id requis' });

    const db = initFirebase();
    const token = await getAccessToken();

    // 1. Comptes du requisition
    const reqRes = await fetch(`${GC_BASE}/requisitions/${requisition_id}/`, {
      headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
    });
    const requisition = await reqRes.json();
    console.log('Requisition status:', requisition.status, '| accounts:', requisition.accounts?.length);

    if (!requisition.accounts || requisition.accounts.length === 0) {
      return res.status(400).json({
        error: requisition.status === 'EXPIRED'
          ? 'Connexion bancaire expirée — déconnectez et reconnectez votre banque.'
          : 'Aucun compte trouvé dans ce requisition (statut: ' + requisition.status + ')'
      });
    }

    const accountsSummary = [];
    const allTransactions = [];

    for (const accountId of requisition.accounts) {
      // 2. Détails compte
      const detailsRes = await fetch(`${GC_BASE}/accounts/${accountId}/details/`, {
        headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
      });
      const details = await detailsRes.json();
      console.log('Details account keys:', Object.keys(details?.account || {}));

      const iban = details.account?.iban || details.account?.bban || details.account?.resourceId || '';
      const name = details.account?.name || details.account?.ownerName || details.account?.product || '';

      // 3. Solde
      let balanceStr = null;
      let balanceNum = 0;
      try {
        const balRes = await fetch(`${GC_BASE}/accounts/${accountId}/balances/`, {
          headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
        });
        const bd = await balRes.json();
        const bal = bd.balances?.find(b => b.balanceType === 'interimAvailable')
          || bd.balances?.find(b => b.balanceType === 'closingBooked')
          || bd.balances?.[0];
        if (bal) {
          balanceNum = parseAmount(bal.balanceAmount?.amount);
          const currency = bal.balanceAmount?.currency || 'EUR';
          balanceStr = `${balanceNum.toLocaleString('fr-FR', { minimumFractionDigits: 2 })} ${currency}`;
          console.log('Balance:', balanceStr);
        }
      } catch(e) { console.warn('Balance error:', e.message); }

      // 4. Transactions
      let rawTxs = [];
      try {
        const txRes = await fetch(`${GC_BASE}/accounts/${accountId}/transactions/`, {
          headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
        });
        const txData = await txRes.json();
        rawTxs = [
          ...(txData.transactions?.booked || []),
          ...(txData.transactions?.pending || [])
        ];
        console.log('Raw transactions:', rawTxs.length);
        if (rawTxs[0]) console.log('TX sample:', JSON.stringify(rawTxs[0]).substring(0, 200));
      } catch(e) { console.warn('Transactions error:', e.message); }

      // 5. Formater
      let accTxCount = 0;
      for (const tx of rawTxs) {
        const dateStr = tx.bookingDate || tx.valueDate || tx.transactionDate;
        if (!dateStr) continue;
        const [y, m, d] = dateStr.split('-').map(Number);
        if (!y || !m || !d) continue;

        const amount = parseAmount(tx.transactionAmount?.amount);
        if (amount === 0) continue;

        const monthKey = `${y}-${String(m).padStart(2, '0')}`;
        const dateLabel = `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
        const bankTxId = tx.transactionId || tx.internalTransactionId || `${accountId}_${dateStr}_${amount}`;

        allTransactions.push({
          bankTxId,
          date: dateLabel,
          dateISO: dateStr,
          monthKey,
          label: extractLabel(tx),
          montant: Math.abs(amount).toFixed(2),
          type: amount < 0 ? 'debit' : 'credit',
          currency: tx.transactionAmount?.currency || 'EUR',
          pending: !tx.bookingDate,
          accountName: name || accountId.substring(0, 8),
          accountIban: iban,
        });
        accTxCount++;
      }

      accountsSummary.push({
        accountId,
        iban,
        name,
        balance: balanceStr,
        balanceNum,
        transactionsCount: accTxCount,
        debitsCount: allTransactions.filter(t => t.accountId === accountId || true).length, // recalculé après
      });
    }

    // Recalculer debitsCount par compte
    for (const acc of accountsSummary) {
      acc.debitsCount = allTransactions.filter(t => t.accountIban === acc.iban && t.type === 'debit').length;
      acc.transactionsCount = allTransactions.filter(t => t.accountIban === acc.iban).length;
    }

    // 6. Sauvegarder dans bank_pending (pas dans Pilotage — validation manuelle requise)
    await db.collection('bank_pending').doc(uid).set({
      transactions: allTransactions,
      syncedAt: new Date().toISOString(),
      requisition_id,
    });

    // 7. Mettre à jour bank_connections
    await db.collection('bank_connections').doc(uid).set({
      requisition_id,
      accounts: accountsSummary,
      lastSync: new Date().toISOString(),
      status: 'active'
    }, { merge: true });

    // 8. Sync solde → cashflow (non bloquant)
    try {
      const totalBalance = accountsSummary.reduce((s, a) => s + (a.balanceNum || 0), 0);
      if (totalBalance !== 0) {
        const today = new Date().toISOString().split('T')[0];
        await db.collection('cashflow').doc(uid)
          .collection('config').doc('tresorerie')
          .set({ solde: totalBalance, date: today, source: 'bank_sync', syncedAt: new Date().toISOString() });
      }
    } catch(e) { console.warn('Sync cashflow:', e.message); }

    console.log('Done — transactions:', allTransactions.length, '| accounts:', accountsSummary.length);

    return res.status(200).json({
      success: true,
      accounts: accountsSummary,
      totalTransactions: allTransactions.length,
      pendingCount: allTransactions.filter(t => t.type === 'debit').length,
    });

  } catch (e) {
    console.error('bank-sync error:', e);
    return res.status(500).json({ error: e.message });
  }
}
