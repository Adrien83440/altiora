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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { uid, redirect_url, country = 'FR' } = req.body;
    if (!uid) return res.status(400).json({ error: 'uid requis' });

    const token = await getAccessToken();

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

    // 2. Créer un end-user agreement (90 jours, 180 jours historique)
    const agreementRes = await fetch(`${GC_BASE}/agreements/enduser/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'accept': 'application/json'
      },
      body: JSON.stringify({
        institution_id,
        max_historical_days: 180,
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
