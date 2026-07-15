// api/bank-sync.js  — SANS Firebase Admin SDK
// GoCardless uniquement → retourne JSON au client
// Le client (banque.html) écrit dans Firestore via Firebase SDK browser
//
// Anti rate-limit : délai 350ms entre chaque appel + retry auto sur 429
//
// DURCISSEMENT (juillet 2026) :
// - Tous les statuts HTTP GoCardless sont vérifiés et loggés (avant : un 403/409
//   sur /transactions/ était silencieusement interprété comme "0 transactions")
// - Messages dédiés pour TOUS les statuts de requisition (GC, CR, RJ, SA, GA, UA, EX)
// - Si un compte remonte 0 transaction ou une erreur, on interroge son statut
//   GoCardless (READY / DISCOVERED / PROCESSING / ERROR...) pour expliquer pourquoi
// - La réponse inclut un tableau `warnings` (additif) que banque.html affiche

const GC_BASE = 'https://bankaccountdata.gocardless.com/api/v2';

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Compteur global pour espacer les appels (350ms entre chaque)
let lastCallTime = 0;

// Extrait le délai de retry d'une réponse 429 (header Retry-After ou body "try again in N seconds")
function extractRetryAfter(res, body) {
  let secs = 0;
  try {
    const h = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
    if (h && !isNaN(parseInt(h, 10))) secs = parseInt(h, 10);
  } catch (e) {}
  if (!secs && body && body.detail) {
    const m = String(body.detail).match(/(\d+)\s*seconds/i);
    if (m) secs = parseInt(m[1], 10);
  }
  return secs;
}

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
      let body = null;
      try { body = await retry.json(); } catch (e) {}
      const retryAfter = extractRetryAfter(retry, body);
      throw { rateLimited: true, retryAfter, message: 'Rate limit GoCardless persistant' };
    }
    return retry;
  }

  return res;
}

// Appel GoCardless avec parsing JSON + log du statut HTTP.
// Retourne { httpStatus, ok, data } — ne throw QUE sur rate limit persistant.
async function gcCall(url, headers, label) {
  const res = await gcFetch(url, headers);
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    const bodyTxt = data ? JSON.stringify(data).substring(0, 200) : '(pas de body)';
    console.warn(`[GC] ${label} → HTTP ${res.status} ${bodyTxt}`);
  }
  return { httpStatus: res.status, ok: res.ok, data: data || {} };
}

// true si un body d'erreur GoCardless signale un consentement (EUA) expiré
// (ex : "End User Agreement (EUA) xxx has expired")
function isEuaExpiredBody(data) {
  try {
    const txt = JSON.stringify(data || {}).toLowerCase();
    return txt.includes('expired') && (txt.includes('eua') || txt.includes('end user agreement'));
  } catch (e) { return false; }
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

// ── Messages utilisateur selon le statut de la requisition GoCardless ──
// CR = créée, GC = écran de consentement GoCardless, UA = authentification banque,
// RJ = rejetée par la banque, SA = sélection des comptes, GA = autorisation finale,
// LN = liée (OK), EX/EXPIRED = expirée.
function requisitionStatusMessage(status) {
  switch (status) {
    case 'EX':
    case 'EXPIRED':
      return 'Connexion expirée. Déconnectez et reconnectez votre banque.';
    case 'UA':
      // Le user a commencé le flow mais ne l'a pas terminé sur le site de sa banque
      // (SMS non saisi, app non validée, onglet fermé avant la fin, etc.).
      return 'Votre connexion bancaire n\'a pas été finalisée. Recommencez la connexion en allant jusqu\'au bout de la validation sur le site de votre banque (saisie du code SMS, validation dans votre application bancaire, etc.).';
    case 'GC':
      // Le user est resté (ou a annulé) sur l'écran de consentement GoCardless,
      // AVANT même d'arriver sur le site de sa banque.
      return 'La connexion a été interrompue sur l\'écran de consentement (avant l\'accès au site de votre banque). Annulez cette tentative puis reconnectez votre banque en acceptant le consentement et en allant jusqu\'au bout.';
    case 'CR':
      return 'La connexion bancaire n\'a jamais été démarrée. Annulez cette tentative puis relancez la connexion.';
    case 'RJ':
      return 'Votre banque a refusé la connexion (identifiants incorrects ou accès refusé). Annulez cette tentative puis réessayez en vérifiant vos identifiants de banque en ligne.';
    case 'SA':
      return 'La connexion s\'est arrêtée à l\'étape de sélection des comptes. Annulez cette tentative puis recommencez en sélectionnant au moins un compte.';
    case 'GA':
      return 'La connexion s\'est arrêtée à la dernière étape d\'autorisation. Annulez cette tentative puis recommencez en allant jusqu\'au bout.';
    default:
      return `Aucun compte trouvé (statut : ${status || 'inconnu'}). Annulez cette tentative puis reconnectez votre banque.`;
  }
}

// ── Message utilisateur pour un compte dont les transactions ne remontent pas ──
// txHttp = statut HTTP de l'appel /transactions/, accStatus = statut GoCardless du compte
function accountIssueMessage(txHttp, accStatus) {
  if (accStatus === 'DISCOVERED' || accStatus === 'PROCESSING' || txHttp === 409) {
    return 'La banque n\'a pas encore transmis les données de ce compte (statut ' + (accStatus || 'en préparation') + '). C\'est normal juste après une connexion : réessayez la synchronisation dans 5 à 10 minutes.';
  }
  if (txHttp === 403) {
    return 'L\'accès aux transactions de ce compte n\'a pas été autorisé lors du consentement bancaire. Déconnectez puis reconnectez la banque en autorisant l\'accès aux opérations.';
  }
  if (txHttp === 401 || txHttp === 404 || accStatus === 'EXPIRED') {
    return 'Ce compte n\'est plus accessible (consentement expiré ou compte retiré). Déconnectez puis reconnectez la banque.';
  }
  if (accStatus === 'ERROR' || accStatus === 'SUSPENDED') {
    return 'La banque signale une erreur sur ce compte (statut ' + accStatus + '). Déconnectez puis reconnectez la banque ; si le problème persiste, contactez le support.';
  }
  if (txHttp >= 500) {
    return 'La banque (ou GoCardless) rencontre un problème technique temporaire. Réessayez dans quelques minutes.';
  }
  return null;
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

// Message rate-limit selon la durée du blocage (limite courte vs quota quotidien DSP2)
function rateLimitMessage(e) {
  const secs = (e && e.retryAfter) || 0;
  if (secs > 3600) {
    return 'La limite quotidienne d\'appels de votre banque est atteinte (réglementation DSP2 : environ 4 synchronisations par jour et par compte). Vos données actuelles sont conservées — réessayez demain.';
  }
  return 'Votre banque limite temporairement les connexions. Veuillez patienter quelques minutes avant de réessayer.';
}

// Dédoublonner les warnings : quand N comptes remontent exactement le même
// problème (cas typique : consentement sans l'accès aux opérations → 403 sur
// TOUS les comptes), on n'affiche le message qu'une fois, préfixé du nombre
// de comptes, au lieu d'un mur de texte répété N fois.
function dedupeWarnings(list) {
  const counts = {};
  const order = [];
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    if (counts[w] === undefined) { counts[w] = 0; order.push(w); }
    counts[w]++;
  }
  return order.map(function(w){
    if (counts[w] === 1) return w;
    // Retirer le préfixe "Nom du compte : " pour un message groupé propre
    const idx = w.indexOf(' : ');
    const core = idx > -1 ? w.substring(idx + 3) : w;
    return counts[w] + ' comptes — ' + core;
  });
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
    const rCall = await gcCall(`${GC_BASE}/requisitions/${requisition_id}/`, gcH, 'requisition');
    const rData = rCall.data;
    console.log('Req status:', rData.status, '| nb accounts:', rData.accounts?.length, '| HTTP:', rCall.httpStatus);

    // Consentement (EUA) expiré ? Détection à trois niveaux (champ additif) :
    // statut de la requisition, body des erreurs 401 par compte, statut des comptes.
    let euaExpired = (rData.status === 'EX' || rData.status === 'EXPIRED');

    // Requisition introuvable côté GoCardless (supprimée) mais encore référencée dans Firestore
    if (rCall.httpStatus === 404) {
      return res.status(400).json({
        error: 'Cette connexion bancaire n\'existe plus. Déconnectez cette banque puis reconnectez-la.',
        requisitionStatus: 'DELETED'
      });
    }

    if (!rData.accounts || rData.accounts.length === 0) {
      return res.status(400).json({
        error: requisitionStatusMessage(rData.status),
        requisitionStatus: rData.status || 'unknown',
        euaExpired: !!euaExpired
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
    const warnings = [];

    for (const accountId of accountList) {
      try {
        // Détails
        const detCall = await gcCall(`${GC_BASE}/accounts/${accountId}/details/`, gcH, `details ${accountId}`);
        const acc     = (detCall.ok && (detCall.data.account || detCall.data)) || {};
        const iban    = acc.iban || acc.bban || acc.resourceId || accountId;
        const name    = acc.name || acc.ownerName || acc.product || 'Compte bancaire';
        console.log(`[${accountId}] details → HTTP ${detCall.httpStatus} | iban=${iban} name=${name}`);

        // Solde
        let balanceNum = 0, balanceStr = null;
        const balCall = await gcCall(`${GC_BASE}/accounts/${accountId}/balances/`, gcH, `balances ${accountId}`);
        if (balCall.ok) {
          const b = balCall.data.balances?.find(x => x.balanceType === 'interimAvailable')
                 || balCall.data.balances?.find(x => x.balanceType === 'closingBooked')
                 || balCall.data.balances?.[0];
          if (b) {
            balanceNum = parseAmount(b.balanceAmount?.amount);
            const curr = b.balanceAmount?.currency || 'EUR';
            balanceStr = balanceNum.toLocaleString('fr-FR', {minimumFractionDigits:2, maximumFractionDigits:2}) + ' ' + curr;
            console.log(`[${accountId}] balance: ${balanceStr}`);
          }
        }

        // Transactions
        let rawTxs = [];
        let txUrl = `${GC_BASE}/accounts/${accountId}/transactions/`;
        if (date_from && /^\d{4}-\d{2}-\d{2}$/.test(date_from)) {
          txUrl += `?date_from=${date_from}`;
        }
        const txCall = await gcCall(txUrl, gcH, `transactions ${accountId}`);
        if (txCall.ok) {
          rawTxs = [...(txCall.data.transactions?.booked || []), ...(txCall.data.transactions?.pending || [])];
        }
        console.log(`[${accountId}] transactions → HTTP ${txCall.httpStatus} | ${rawTxs.length} transactions`);
        if (isEuaExpiredBody(detCall.data) || isEuaExpiredBody(balCall.data) || isEuaExpiredBody(txCall.data)) euaExpired = true;
        if (rawTxs[0]) console.log('sample:', JSON.stringify(rawTxs[0]).substring(0, 250));

        // ── Diagnostic : transactions en erreur OU vides → interroger le statut du compte ──
        // (endpoint métadonnées /accounts/{id}/ : hors quotas DSP2, appelé uniquement si besoin)
        let gcAccountStatus = null;
        let issueMessage = null;
        const detailsFailed = !detCall.ok;
        if (!txCall.ok || rawTxs.length === 0 || detailsFailed) {
          const metaCall = await gcCall(`${GC_BASE}/accounts/${accountId}/`, gcH, `meta ${accountId}`);
          gcAccountStatus = (metaCall.ok && metaCall.data.status) || null;
          console.log(`[${accountId}] statut compte GoCardless: ${gcAccountStatus || 'inconnu'}`);
          if (gcAccountStatus === 'EXPIRED') euaExpired = true;

          if (!txCall.ok || detailsFailed) {
            issueMessage = accountIssueMessage(txCall.ok ? detCall.httpStatus : txCall.httpStatus, gcAccountStatus);
          } else if (rawTxs.length === 0 && gcAccountStatus && gcAccountStatus !== 'READY') {
            // HTTP 200 mais 0 transaction ET compte pas encore prêt → banque pas finie de traiter
            issueMessage = accountIssueMessage(200, gcAccountStatus);
          } else if (rawTxs.length === 0 && !date_from) {
            // Historique complet demandé, compte READY, et pourtant 0 transaction :
            // soit compte réellement vide, soit la banque ne transmet pas les opérations.
            issueMessage = 'La banque n\'a transmis aucune transaction pour ce compte. Si ce compte a des mouvements, réessayez dans quelques minutes ; si le problème persiste, contactez le support Alteore.';
          }
          if (issueMessage) warnings.push(`${name} : ${issueMessage}`);
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
          transactions,
          // Champs additifs de diagnostic (ignorés par l'ancien front, utilisés par le nouveau)
          gcAccountStatus: gcAccountStatus,
          issueMessage: issueMessage
        });

      } catch(e) {
        if (e && e.rateLimited) {
          return res.status(429).json({ error: rateLimitMessage(e), rate_limited: true });
        }
        console.error(`[${accountId}] FATAL:`, e.message);
        warnings.push(`Compte ${accountId} : erreur technique (${e.message || 'inconnue'})`);
      }
    }

    const warningsOut = dedupeWarnings(warnings);

    if (accounts.length === 0) {
      return res.status(500).json({
        error: warningsOut[0] || 'Impossible de récupérer les données bancaires.',
        warnings: warningsOut
      });
    }

    const total = accounts.reduce((s, a) => s + a.transactions.length, 0);
    console.log('OK — total tx:', total, warningsOut.length ? `| ${warningsOut.length} warning(s)` : '');
    return res.status(200).json({
      success: true,
      accounts,
      totalTransactions: total,
      requisitionStatus: rData.status || null,
      euaExpired: !!euaExpired,
      warnings: warningsOut
    });

  } catch(e) {
    if (e && e.rateLimited) {
      return res.status(429).json({ error: rateLimitMessage(e), rate_limited: true });
    }
    console.error('bank-sync FATAL:', e);
    return res.status(500).json({ error: e.message || 'Erreur interne serveur' });
  }
}
