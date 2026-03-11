/**
 * api/stock-scan-ai.js
 * Proxy Vercel — Scan de bons de livraison / factures fournisseurs
 * Claude Sonnet Vision extrait les lignes produit
 */

// ── Auth inline ──
function _cors(req,res){
  const origin = req.headers.origin;
  const allowed = ['https://alteore.com','https://www.alteore.com'];
  if(allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  else res.setHeader('Access-Control-Allow-Origin','https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  res.setHeader('Vary','Origin');
  if(req.method==='OPTIONS'){res.status(200).end();return true}
  return false
}
async function _verifyAuth(req,res){
  const h=req.headers.authorization||'';
  const token=h.startsWith('Bearer ')?h.slice(7):'';
  if(!token){res.status(401).json({error:'Non authentifié.'});return null}
  try{
    const apiKey=process.env.FIREBASE_API_KEY;
    if(!apiKey){res.status(500).json({error:'Config serveur manquante.'});return null}
    const r=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key='+apiKey,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken:token})});
    if(!r.ok){res.status(401).json({error:'Token invalide.'});return null}
    const d=await r.json();
    const u=d.users?.[0];
    if(!u?.localId){res.status(401).json({error:'Utilisateur introuvable.'});return null}
    return{uid:u.localId}
  }catch(e){res.status(401).json({error:'Erreur auth.'});return null}
}
const _rlBuckets=new Map();function _rateLimit(uid,res,max=20){const now=Date.now();let b=_rlBuckets.get(uid);if(!b||now>b.r){b={c:0,r:now+60000};_rlBuckets.set(uid,b)}b.c++;if(b.c>max){res.status(429).json({error:'Trop de requêtes.'});return true}return false}

export default async function handler(req, res) {
  if (_cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await _verifyAuth(req, res);
  if (!auth) return;
  if (_rateLimit(auth.uid, res, 10)) return;



  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY manquante' });

  try {
    const { image, mediaType, existingRefs } = req.body;
    if (!image) return res.status(400).json({ error: 'Image manquante' });

    const refsContext = existingRefs && existingRefs.length
      ? `\nRÉFÉRENCES EXISTANTES dans le stock du client (essaie de matcher) :\n${existingRefs.slice(0, 200).map(r => `${r.ref} — ${r.name}`).join('\n')}`
      : '';

    const prompt = `Tu es un assistant spécialisé dans l'extraction de données de bons de livraison, factures fournisseurs et tickets de réception.

Analyse cette image et extrais TOUTES les lignes de produits que tu vois.
${refsContext}

Réponds UNIQUEMENT en JSON valide (pas de markdown, pas de backticks) :
{
  "docType": "bon_livraison|facture|ticket|autre",
  "fournisseur": "nom du fournisseur si visible",
  "date": "YYYY-MM-DD si visible, sinon null",
  "numero": "numéro du document si visible",
  "lignes": [
    {
      "ref": "référence/code article si visible",
      "designation": "nom du produit",
      "quantite": <nombre>,
      "unite": "unité si visible (kg, pce, L, etc.)",
      "prixUnitaireHT": <prix unitaire HT si visible, sinon null>,
      "totalHT": <total ligne HT si visible, sinon null>,
      "tva": <taux TVA si visible, sinon null>,
      "matchedRef": "<référence existante la plus proche si trouvée, sinon null>"
    }
  ],
  "totalHT": <total document HT si visible>,
  "totalTTC": <total TTC si visible>,
  "confidence": <0-1 confiance globale>,
  "notes": "remarques éventuelles"
}

RÈGLES :
- Extrais TOUTES les lignes même si certaines infos manquent
- Si le document est flou ou partiellement lisible, extrais ce que tu peux
- Les prix peuvent être en format français (virgule décimale)
- Convertis les virgules en points dans les nombres
- Si tu vois un code-barres, mets-le dans ref
- matchedRef = la ref existante du stock qui correspond le mieux (même produit)`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: 'Erreur API', details: errText });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';

    let result;
    try {
      result = JSON.parse(text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
    } catch (e) {
      result = { lignes: [], confidence: 0, notes: 'Erreur parsing: ' + e.message, raw: text };
    }

    return res.status(200).json(result);

  } catch (err) {
    console.error('stock-scan-ai error:', err);
    return res.status(500).json({ error: err.message });
  }
}
