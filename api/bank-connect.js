// api/bank-connect.js
// Génère un lien de connexion bancaire GoCardless Bank Account Data

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
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { uid, redirect_url, country = 'FR' } = req.body;
    if (!uid) return res.status(400).json({ error: 'uid requis' });

    const token = await getAccessToken();

    // 0. Déconnecter — supprimer requisition + agreement côté GoCardless
    if (req.body.action === 'disconnect') {
      const { requisition_id, agreement_id } = req.body;
      const results = [];

      // Supprimer la requisition
      if (requisition_id) {
        try {
          const r = await fetch(`${GC_BASE}/requisitions/${requisition_id}/`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
          });
          results.push({ requisition: r.status });
          console.log('[disconnect] requisition', requisition_id, '→', r.status);
        } catch(e) { results.push({ requisition: e.message }); }
      }

      // Supprimer l'agreement
      if (agreement_id) {
        try {
          const r = await fetch(`${GC_BASE}/agreements/enduser/${agreement_id}/`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
          });
          results.push({ agreement: r.status });
          console.log('[disconnect] agreement', agreement_id, '→', r.status);
        } catch(e) { results.push({ agreement: e.message }); }
      }

      return res.status(200).json({ success: true, results });
    }

    // 1. Lister les banques disponibles pour le pays
    if (req.body.action === 'list_banks') {
      const banksRes = await fetch(`${GC_BASE}/institutions/?country=${country}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
      });
      const banks = await banksRes.json();
      return res.status(200).json({ banks });
    }

    const { institution_id } = req.body;
    if (!institution_id) return res.status(400).json({ error: 'institution_id requis' });

    // 2. Récupérer les limites de la banque
    const instRes = await fetch(`${GC_BASE}/institutions/${institution_id}/`, {
      headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
    });
    const instData = await instRes.json();
    const maxDays = instData.transaction_total_days
      ? Math.min(180, parseInt(instData.transaction_total_days))
      : 90;

    // 3. Créer un end-user agreement
    const agreementRes = await fetch(`${GC_BASE}/agreements/enduser/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'accept': 'application/json'
      },
      body: JSON.stringify({
        institution_id,
        max_historical_days: maxDays,
        access_valid_for_days: 90,
        access_scope: ['balances', 'details', 'transactions']
      })
    });
    const agreement = await agreementRes.json();
    if (!agreement.id) throw new Error('Agreement failed: ' + JSON.stringify(agreement));

    // 3. Créer le requisition (lien de connexion)
    const appUrl = process.env.APP_URL || 'https://alteore.com';
    const redirectUrl = redirect_url || `${appUrl}/banque.html?status=connected&uid=${uid}`;

    const reqRes = await fetch(`${GC_BASE}/requisitions/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'accept': 'application/json'
      },
      body: JSON.stringify({
        redirect: redirectUrl,
        institution_id,
        agreement: agreement.id,
        reference: `alteore_${uid}_${Date.now()}`,
        user_language: 'FR'
      })
    });
    const requisition = await reqRes.json();
    if (!requisition.link) throw new Error('Requisition failed: ' + JSON.stringify(requisition));

    return res.status(200).json({
      link: requisition.link,
      requisition_id: requisition.id,
      agreement_id: agreement.id
    });

  } catch (e) {
    console.error('bank-connect error:', e);
    return res.status(500).json({ error: e.message });
  }
}
