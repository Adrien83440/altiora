// api/bank-sync.js  — SANS Firebase Admin SDK
// GoCardless uniquement → retourne JSON au client
// Le client (banque.html) écrit dans Firestore via Firebase SDK browser
//
// Anti rate-limit : délai 350ms entre chaque appel + retry auto sur 429

const GC_BASE = 'https://bankaccountdata.gocardless.com/api/v2';

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Compteur global pour espacer les appels (350ms entre chaque)
let lastCallTime = 0;

async function gcFetch(url, headers) {
  // Espacer les appels pour rester sous le rate limit (10 req/s)
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < 350) await wait(350 - elapsed);
  lastCallTime = Date.now();

  const res = await fetch(url, { headers });

  // Si rate limited, attendre 3s et réessayer une fois
  if (res.status === 429) {
    console.warn('429 on', url.split('/').slice(-2).join('/'), '— retry in 3s');
    await wait(3000);
    lastCallTime = Date.now();
    const retry = await fetch(url, { headers });
    if (retry.status === 429) {
      throw { rateLimited: true, message: 'Rate limit GoCardless persistant' };
    }
    return retry;
  }

  return res;
}

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

// Catégories et types d'opération Qonto (et autres banques) à exclure des libellés.
// Qonto met ces codes dans remittanceInformationUnstructuredArray À CÔTÉ du vrai libellé,
// ce qui polluait l'affichage (ex: "other_expense · Transfer" au lieu du vrai destinataire).
const BANK_CATEGORY_CODES = new Set([
  // Catégories de dépenses Qonto
  'atm','bank_fees','business_entertainment','commercial_activity',
  'equipment','fees','food_and_grocery','gas_station','gifts',
  'hotel_and_lodging','insurance','internet','legal_and_accounting',
  'logistics','maintenance_and_repairs','marketing','office_rental',
  'office_supplies','online_service','other_expense','other_service',
  'refund','restaurant_and_bar','salary','sales','subscription',
  'tax','telecom','training','transport','utility','voucher',
  // Catégories de revenus
  'other_income','sales_income',
  // Types d'opération
  'card','transfer','income','direct_debit','check','cheque',
  // Mots génériques isolés
  'expense','payment','debit','credit'
]);

// true si la chaîne ressemble à un code technique (catégorie, type d'op) plutôt qu'à un libellé humain
function isCategoryCode(s) {
  const norm = String(s || '').toLowerCase().trim();
  if (!norm) return true;
  if (BANK_CATEGORY_CODES.has(norm)) return true;
  // snake_case pur type "bank_fees", "other_expense" = code technique
  if (/^[a-z]+(_[a-z]+)+$/.test(norm)) return true;
  return false;
}

function cleanLine(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}

// true si la chaîne `s` est contenue (en minuscules) dans `other`, et strictement plus courte
function isSubsetOf(s, other) {
  if (!s || !other || s === other) return false;
  if (other.length <= s.length) return false;
  return other.toLowerCase().includes(s.toLowerCase());
}

function extractLabel(tx) {
  // Sens de la transaction pour choisir la bonne contrepartie.
  // Débit (montant négatif) : contrepartie = creditorName (celui qui reçoit).
  // Crédit (montant positif) : contrepartie = debtorName (celui qui envoie).
  const amt = parseFloat(String((tx.transactionAmount && tx.transactionAmount.amount) || '0').replace(',', '.'));
  const isDebit = amt < 0;
  const counterparty = isDebit ? tx.creditorName : tx.debtorName;

  // Collecter TOUS les candidats dans l'ordre de priorité de lecture
  // (on ne s'arrête pas au premier non-vide : on veut concaténer le meilleur)
  const rawCandidates = [];
  rawCandidates.push(counterparty);                                     // creditorName/debtorName
  rawCandidates.push(tx.remittanceInformationUnstructured);             // motif/référence scalaire
  if (Array.isArray(tx.remittanceInformationUnstructuredArray)) {
    for (let i = 0; i < tx.remittanceInformationUnstructuredArray.length; i++) {
      rawCandidates.push(tx.remittanceInformationUnstructuredArray[i]); // toutes les lignes du tableau
    }
  }
  rawCandidates.push(tx.merchantName);
  rawCandidates.push(tx.remittanceInformationStructured);
  if (Array.isArray(tx.remittanceInformationStructuredArray) && tx.remittanceInformationStructuredArray[0]) {
    rawCandidates.push(tx.remittanceInformationStructuredArray[0].reference);
  }

  // Filtrer : nettoyer, jeter les codes techniques, garder seulement les vrais libellés
  const filtered = [];
  const seen = new Set();
  for (let i = 0; i < rawCandidates.length; i++) {
    const clean = cleanLine(rawCandidates[i]);
    if (!clean || clean.length < 2) continue;
    if (isCategoryCode(clean)) continue;
    // Doit contenir au moins un mot de 3+ lettres (exclut "CB 1234", "ID:99", etc.)
    if (!/[A-Za-zÀ-ÿ]{3,}/.test(clean)) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    filtered.push(clean);
  }

  // Retirer les sous-chaînes : si "PAYPAL" ET "PAYPAL *NETFLIX" sont présents,
  // on ne garde que "PAYPAL *NETFLIX" (plus informatif).
  const deduped = filtered.filter(function(p){
    return !filtered.some(function(other){ return isSubsetOf(p, other); });
  });

  if (deduped.length > 0) {
    // Limiter à 3 pièces max pour ne pas surcharger l'affichage
    return deduped.slice(0, 3).join(' · ').substring(0, 120);
  }

  // Ultimes fallbacks si tout est filtré (cas rare)
  const lastResort = [
    tx.entryReference,
    tx.additionalInformation,
    tx.proprietaryBankTransactionCode
  ];
  for (let i = 0; i < lastResort.length; i++) {
    const clean = cleanLine(lastResort[i]);
    if (clean && !isCategoryCode(clean) && clean.length > 1) {
      return clean.substring(0, 120);
    }
  }

  // Vraiment rien d'exploitable : on retourne la ligne brute la plus longue du tableau
  if (Array.isArray(tx.remittanceInformationUnstructuredArray)) {
    const longest = tx.remittanceInformationUnstructuredArray
      .map(cleanLine)
      .filter(function(s){ return s.length > 1; })
      .sort(function(a,b){ return b.length - a.length; })[0];
    if (longest) return longest.substring(0, 120);
  }

  return 'Transaction bancaire';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Reset le compteur à chaque invocation (serverless = fresh)
  lastCallTime = 0;

  try {
    const { requisition_id, date_from, selected_accounts } = req.body || {};
    if (!requisition_id) return res.status(400).json({ error: 'requisition_id manquant' });

    if (!process.env.GC_BANK_SECRET_ID || !process.env.GC_BANK_SECRET_KEY) {
      return res.status(500).json({ error: 'Variables GC_BANK_SECRET_ID / GC_BANK_SECRET_KEY manquantes dans Vercel' });
    }

    const token = await getGCToken();
    const gcH = { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' };

    // Requisition
    const rRes = await gcFetch(`${GC_BASE}/requisitions/${requisition_id}/`, gcH);
    const rData = await rRes.json();
    console.log('Req status:', rData.status, '| nb accounts:', rData.accounts?.length);

    if (!rData.accounts || rData.accounts.length === 0) {
      return res.status(400).json({
        error: rData.status === 'EXPIRED'
          ? 'Connexion expirée. Déconnectez et reconnectez votre banque.'
          : `Aucun compte trouvé (statut: ${rData.status || 'inconnu'})`
      });
    }

    // ── Filtrer par comptes sélectionnés si spécifié ──
    let accountList = rData.accounts;
    if (Array.isArray(selected_accounts) && selected_accounts.length > 0) {
      accountList = rData.accounts.filter(id => selected_accounts.includes(id));
      console.log('Filtered accounts:', accountList.length, '/', rData.accounts.length);
      if (accountList.length === 0) accountList = rData.accounts;
    }

    const accounts = [];

    for (const accountId of accountList) {
      try {
        // Détails
        const detRes = await gcFetch(`${GC_BASE}/accounts/${accountId}/details/`, gcH);
        const detData = await detRes.json();
        const acc     = detData.account || detData || {};
        const iban    = acc.iban || acc.bban || acc.resourceId || accountId;
        const name    = acc.name || acc.ownerName || acc.product || 'Compte bancaire';
        console.log(`[${accountId}] iban=${iban} name=${name}`);

        // Solde
        let balanceNum = 0, balanceStr = null;
        try {
          const bRes = await gcFetch(`${GC_BASE}/accounts/${accountId}/balances/`, gcH);
          const bData = await bRes.json();
          const b     = bData.balances?.find(x => x.balanceType === 'interimAvailable')
                     || bData.balances?.find(x => x.balanceType === 'closingBooked')
                     || bData.balances?.[0];
          if (b) {
            balanceNum = parseAmount(b.balanceAmount?.amount);
            const curr = b.balanceAmount?.currency || 'EUR';
            balanceStr = balanceNum.toLocaleString('fr-FR', {minimumFractionDigits:2, maximumFractionDigits:2}) + ' ' + curr;
            console.log(`[${accountId}] balance: ${balanceStr}`);
          }
        } catch(e) {
          if (e && e.rateLimited) throw e;
          console.warn(`[${accountId}] balance err:`, e.message);
        }

        // Transactions
        let rawTxs = [];
        try {
          let txUrl = `${GC_BASE}/accounts/${accountId}/transactions/`;
          if (date_from && /^\d{4}-\d{2}-\d{2}$/.test(date_from)) {
            txUrl += `?date_from=${date_from}`;
          }
          const txRes = await gcFetch(txUrl, gcH);
          const txData = await txRes.json();
          rawTxs = [...(txData.transactions?.booked || []), ...(txData.transactions?.pending || [])];
          console.log(`[${accountId}] ${rawTxs.length} transactions`);
          if (rawTxs[0]) console.log('sample:', JSON.stringify(rawTxs[0]).substring(0, 250));
        } catch(e) {
          if (e && e.rateLimited) throw e;
          console.warn(`[${accountId}] tx err:`, e.message);
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
            bankTxId:  tx.transactionId || tx.internalTransactionId || `${accountId}_${dateStr}_${Math.abs(rawAmt)}`,
            date:      `${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}/${y}`,
            dateISO:   dateStr,
            monthKey:  `${y}-${String(m).padStart(2,'0')}`,
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

      } catch(e) {
        if (e && e.rateLimited) {
          return res.status(429).json({ error: 'Votre banque limite temporairement les connexions. Veuillez patienter quelques minutes avant de réessayer.', rate_limited: true });
        }
        console.error(`[${accountId}] FATAL:`, e.message);
      }
    }

    if (accounts.length === 0) return res.status(500).json({ error: 'Impossible de récupérer les données bancaires.' });

    const total = accounts.reduce((s, a) => s + a.transactions.length, 0);
    console.log('OK — total tx:', total);
    return res.status(200).json({ success: true, accounts, totalTransactions: total });

  } catch(e) {
    if (e && e.rateLimited) {
      return res.status(429).json({ error: 'Votre banque limite temporairement les connexions. Veuillez patienter quelques minutes avant de réessayer.', rate_limited: true });
    }
    console.error('bank-sync FATAL:', e);
    return res.status(500).json({ error: e.message || 'Erreur interne serveur' });
  }
}
