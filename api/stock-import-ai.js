/**
 * api/stock-import-ai.js
 * Proxy Vercel — Mapping intelligent de colonnes pour import stock
 * Envoie les headers + exemples à Claude pour détecter le mapping
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
    const { headers, sampleRows } = req.body;
    if (!headers || !headers.length) return res.status(400).json({ error: 'Headers manquants' });

    const fieldsDef = `
Champs cibles disponibles (id → description) :
- ref : Référence produit / SKU / Code article
- ean : Code-barres EAN / UPC / GTIN
- name : Nom / Désignation / Libellé du produit
- cat : Catégorie / Famille / Rayon
- fournisseur : Fournisseur / Marque
- pa : Prix d'achat HT unitaire (nombre)
- pv : Prix de vente HT unitaire (nombre)
- stockBase : Quantité en stock / Stock actuel (nombre entier)
- min : Seuil d'alerte / Stock minimum (nombre)
- unite : Unité de mesure (pièce, kg, litre, mètre, etc.)
- emplacement : Emplacement / Rayon / Zone de stockage
- lot : Numéro de lot
- dlc : Date limite de consommation (date)
- condQte : Conditionnement / Colisage (nombre par carton)
- notes : Remarques / Description / Commentaire
- stockType : Type (matiere = matière première, fini = produit fini, marchandise = marchandise pour revente)
- _ignore : Colonne à ignorer (ne pas importer)
`;

    const sampleText = sampleRows.slice(0, 4).map((row, i) =>
      `Ligne ${i+1}: ${headers.map((h, j) => `${h}="${row[j] || ''}"`).join(' | ')}`
    ).join('\n');

    const prompt = `Tu es un assistant spécialisé dans l'import de données de stock/inventaire.

Voici les colonnes d'un fichier importé :
Headers : ${JSON.stringify(headers)}

Exemples de données :
${sampleText}

${fieldsDef}

Pour CHAQUE colonne du fichier, détermine le champ cible le plus approprié.
Si une colonne ne correspond à aucun champ, utilise "_ignore".
Si un header contient le mot "prix" sans précision achat/vente, regarde les valeurs pour deviner.
Si tu vois des codes numériques longs (8-13 chiffres), c'est probablement un EAN.

Réponds UNIQUEMENT en JSON valide, sans markdown, sans explication :
{"mapping": {"nom_colonne_1": "champ_cible", "nom_colonne_2": "champ_cible", ...}, "confidence": 0.85, "notes": "explication courte en français"}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: 'Erreur API', details: errText });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    
    // Parse JSON robuste
    let result;
    try {
      const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      result = JSON.parse(cleaned);
    } catch(e) {
      result = { mapping: {}, confidence: 0, notes: 'Erreur de parsing: ' + e.message, raw: text };
    }

    return res.status(200).json(result);

  } catch (err) {
    console.error('stock-import-ai error:', err);
    return res.status(500).json({ error: err.message });
  }
}
