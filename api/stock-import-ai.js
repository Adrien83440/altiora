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

— IDENTIFIANTS —
- ref : Référence produit / SKU / Code article (le plus stable côté logiciel source : "Code", "IdArt", "Code article")
- ean : Code-barres EAN / UPC / GTIN (8-13 chiffres, parfois nommé "Multi Code", "Barcode", "Gencod")
- refFournisseur : Référence du produit chez le fournisseur ("Ref. Fourn.", "Cod. Fourn.", "Ref Frns")

— DESCRIPTION —
- name : Nom / Désignation / Libellé du produit ("Designation", "Libellé", "Article", "Modele" si pas de variantes)
- parentRefName : Nom du modèle parent quand le fichier contient des variantes ("Modele", "Modèle", "Style", "Famille produit"). À utiliser UNIQUEMENT si une colonne distincte sert d'identifiant produit (ref) ET qu'une autre colonne donne le libellé du modèle parent.
- fournisseur : Fournisseur ou Marque ("Marque", "Fabricant", "Fournisseur", "Brand", "Supplier")

— CATÉGORISATION (deux niveaux) —
- cat : Famille / Catégorie principale / Rayon ("cFAMILLE", "Famille", "Catégorie", "Rayon", "Cat", "Family")
- sousCat : Sous-famille / Sous-catégorie ("CSSFAMILLE", "Sous-famille", "Sous-catégorie", "Sub-cat", "Type")

— VARIANTES (clothing/textile/bijoux) —
- taille : Taille ou pointure ("Taille", "Size", "Pointure", "T.")
- couleur : Couleur ou coloris ("Coloris", "Couleur", "Color", "Colour")

— PRIX —
- pa : Prix d'achat HT catalogue / unitaire ("PA", "Prix achat", "PUHT achat", "Cost")
- pmpa : Prix moyen pondéré d'achat ("PMPA", "Prix Moyen Pondéré")
- cump : Coût unitaire moyen pondéré ("CUMP", "CMUP", "PMP")
- pv : Prix de vente HT ("HT", "PV HT", "Prix vente HT", "Price HT"). NE PAS confondre avec TTC.
- _ignore_ttc : Le prix TTC doit être IGNORÉ (Alteore travaille en HT). Si une colonne s'appelle "TTC" ou "Prix vente TTC", la mapper sur "_ignore".
- txMarque : Taux de marque calculé ("Tx Marq.", "Taux marque", "Marge %")

— STOCK —
- stockBase : Quantité en stock actuelle ("Qté en Stock", "Stock", "Qté", "Stock dispo", "Quantity")
- min : Seuil d'alerte stock minimum ("Stock min", "Seuil alerte", "Alerte"). Préférer cette cible quand le mot "alerte" apparaît.
- qMin : Stock minimum informatif du logiciel source ("Q_Mini", "Quantité mini") — DIFFÉRENT de "min" qui est le seuil d'alerte Alteore. Si le fichier a UNIQUEMENT Q_Mini sans autre seuil, mapper sur "min". Si les deux existent, Q_Mini → qMin et le seuil alerte → min.
- qMax : Stock maximum cible ("Q_Maxi", "Quantité maxi", "Max stock")
- qAppro : Quantité de réapprovisionnement ("Q_Appro", "Qté commande", "Reorder qty")
- qReservee : Quantité réservée client ("Qté Reservée", "Réservé", "Reserved")
- qCommande : Quantité en commande fournisseur ("Qté en Cde", "En commande", "On order")
- valorisation : Valorisation totale du stock ("Valorisation", "Stock value", "Valeur stock")

— ATTRIBUTS —
- unite : Unité de mesure (pièce, kg, litre, mètre, etc.)
- emplacement : Emplacement / Rayon / Zone de stockage
- lot : Numéro de lot
- dlc : Date limite de consommation
- condQte : Conditionnement / Colisage (nombre par carton)
- stockType : Type (matiere = matière première, fini = produit fini, marchandise = marchandise pour revente)
- soldes : En soldes (oui/non, 0/1)
- catSolde : Catégorie de soldes ("CatSolde", "Type solde")
- notes : Remarques / Description / Commentaire libre / Nota

— À IGNORER —
- _ignore : Colonne à ignorer (ne pas importer)
`;

    const sampleText = sampleRows.slice(0, 5).map((row, i) =>
      `Ligne ${i+1}: ${headers.map((h, j) => `${h}="${row[j] || ''}"`).join(' | ')}`
    ).join('\n');

    const prompt = `Tu es un assistant spécialisé dans l'import de données de stock/inventaire pour Alteore (SaaS de gestion pour TPE/PME : commerçants, retailers, artisans, restaurateurs).

Voici les colonnes d'un fichier importé :
Headers : ${JSON.stringify(headers)}

Exemples de données (5 premières lignes) :
${sampleText}

${fieldsDef}

INSTRUCTIONS DE MAPPING :

1. Pour CHAQUE colonne du fichier, détermine le champ cible le plus approprié parmi la liste ci-dessus.
2. Si une colonne ne correspond à aucun champ, utilise "_ignore".
3. **TVA / Prix HT vs TTC** : Alteore travaille EN HT. Si le fichier a "HT" ET "TTC", "HT" → pv, "TTC" → _ignore. Si une seule colonne "Prix" existe, regarde l'écart avec PA pour deviner.
4. **Plusieurs colonnes "prix d'achat"** : si tu vois PA + PMPA + CUMP, mappe-les RESPECTIVEMENT à pa, pmpa, cump (ne les fusionne pas).
5. **Catégorie hiérarchique** : si tu vois "cFAMILLE" et "CSSFAMILLE", c'est respectivement cat (famille principale) et sousCat (sous-famille). De même "Famille"+"Sous-famille", "Rayon"+"Catégorie", etc.
6. **Variantes (taille/couleur)** : détecte "Taille", "Coloris", "Couleur", "Size", "Color". Ces colonnes signifient que le fichier contient des variantes d'un modèle parent.
7. **Modèle parent vs SKU** : si tu vois à la fois une colonne "Modele/Modèle/Style" ET une colonne "Code/Ref/SKU/IdArt", la SKU unique est le code article (ref) et le modèle est parentRefName (libellé du groupe parent). Si "Modele" est la seule colonne nom, alors Modele → name et pas de parentRefName.
8. **EAN** : si tu vois des codes numériques de 8-13 chiffres dans une colonne, c'est probablement un EAN — même si la colonne s'appelle "Multi Code", "Code barres", "Gencod" ou similaire.
9. **Q_Mini / Stock min** : voir la définition détaillée ci-dessus. En cas de doute, "Q_Mini" → min.
10. **Valeurs vides ou marqueurs "###"** dans les exemples : ignore-les pour deviner le contenu, base-toi sur les autres lignes.

Pour le champ "confidence" :
- 0.9-1.0 : tous les headers sont reconnus, le mapping est évident
- 0.7-0.89 : la majorité est reconnue, 1-2 colonnes ambiguës
- 0.5-0.69 : plusieurs colonnes ambiguës ou inconnues
- < 0.5 : fichier non reconnu, mapping incertain

Réponds UNIQUEMENT en JSON valide, sans markdown, sans explication hors du champ "notes" :
{"mapping": {"nom_colonne_1": "champ_cible", "nom_colonne_2": "champ_cible", ...}, "confidence": 0.85, "notes": "explication courte en français : ce qui a été reconnu, structure du fichier (variantes ou non), points d'attention", "hasVariants": true|false, "detectedSource": "nom du logiciel source si reconnaissable (ex: Cegid, EBP, Sage, Polaris, Vega, ou null)"}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
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
