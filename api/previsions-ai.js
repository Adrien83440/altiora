/**
 * api/previsions-ai.js
 * Prévisions de demande IA — Claude Sonnet
 * Croise historique ventes + météo + fériés + événements
 */

// ── Auth inline (même pattern que stock-analyze-ai.js) ──
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
const _rlBuckets=new Map();function _rateLimit(uid,res,max=5){const now=Date.now();let b=_rlBuckets.get(uid);if(!b||now>b.r){b={c:0,r:now+60000};_rlBuckets.set(uid,b)}b.c++;if(b.c>max){res.status(429).json({error:'Trop de requêtes. Réessayez dans 1 minute.'});return true}return false}

export default async function handler(req, res) {
  if (_cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await _verifyAuth(req, res);
  if (!auth) return;
  if (_rateLimit(auth.uid, res, 5)) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY manquante' });

  try {
    const { products, historique, meteo, joursFeries, events, dateDebut, dateFin, businessType } = req.body;

    if (!products || !products.length) return res.status(400).json({ error: 'Aucun produit fourni.' });
    if (!dateDebut || !dateFin) return res.status(400).json({ error: 'Dates manquantes.' });

    // Limiter la taille du payload (sécurité)
    const maxHistEntries = 500;
    const histTrunc = (historique || []).slice(-maxHistEntries);

    // Adapter le contexte au type d'activité
    const btContexts = {
      alimentaire: `Tu es un expert en prévision de demande pour commerces alimentaires français (boulangeries, restaurants, traiteurs, épiceries). Les pertes (jeté, donné) sont un KPI majeur. Le gaspillage alimentaire est un enjeu clé.`,
      commerce: `Tu es un expert en prévision de ventes pour commerces de détail français (boutiques vêtements, accessoires, décoration, retail). Il n'y a PAS de notion de "jeté" — les produits invendus restent en stock. L'analyse porte sur les tendances de vente par catégorie, la saisonnalité des collections, et les pics de fréquentation.`,
      service: `Tu es un expert en prévision de demande pour activités de service françaises (salon de coiffure, institut de beauté, consulting, agence). L'analyse porte sur le taux de remplissage des créneaux, les annulations, et l'optimisation du planning.`
    };
    const btContext = btContexts[businessType] || btContexts.alimentaire;

    const prompt = `${btContext} Tu analyses l'historique de ventes, la météo, les jours de la semaine, les jours fériés et les événements locaux pour prédire les quantités par produit.

PRODUITS À PRÉVOIR :
${JSON.stringify(products.map(p => ({ id: p.id, name: p.name, unit: p.unit || 'pièces', pvHT: p.pvHT || 0, coutUnitaire: p.coutUnitaire || 0 })), null, 1)}

HISTORIQUE DES VENTES (${histTrunc.length} entrées, jours récents) :
${JSON.stringify(histTrunc.map(e => ({ date: e.date, productId: e.productId, vendu: e.vendu, jete: e.jete, produit: e.produit })), null, 1)}

MÉTÉO :
${meteo ? JSON.stringify(meteo, null, 1) : 'Non disponible'}

JOURS FÉRIÉS FRANÇAIS (période concernée) :
${joursFeries && joursFeries.length ? joursFeries.join(', ') : 'Aucun'}

ÉVÉNEMENTS LOCAUX :
${events && events.length ? JSON.stringify(events, null, 1) : 'Aucun'}

PÉRIODE À PRÉVOIR : du ${dateDebut} au ${dateFin}

RÈGLES D'ANALYSE :
- Type d'activité : ${businessType || 'alimentaire'}
- Identifie les patterns par jour de semaine (lundi creux, dimanche pic pour boulangeries, vendredi/samedi pics pour restaurants, etc.)
- Pour le COMMERCE/RETAIL : analyse les tendances par catégorie, les pics saisonniers (soldes, fêtes, rentrée), pas de notion de gaspillage
- Pour les SERVICES : analyse le taux de remplissage, les no-shows, les jours de forte demande
- La météo chaude (>25°C) augmente glaces/boissons fraîches, baisse soupes/viennoiseries lourdes
- La météo chaude augmente aussi les sorties shopping et la fréquentation des terrasses
- La pluie réduit la fréquentation globale de 10-20%
- Le vent fort (>40km/h) réduit la fréquentation de 5-15%
- Les jours fériés = pattern dimanche (fermeture possible, ou pic si ouvert)
- Le jour AVANT un férié est souvent un pic
- Les événements locaux (marchés, fêtes, matchs) augmentent la demande de 20-50%
- Si l'historique est court (<14 jours), la confiance doit être basse (<0.6)
- Pour chaque produit, calcule la moyenne par jour de semaine, puis ajuste selon météo/fériés/événements
- Ne prédis jamais 0 sauf si le produit n'a JAMAIS été vendu ce jour-là sur l'historique
- Les quantités doivent être des ENTIERS (on ne vend pas 12.5 baguettes)
- Explique brièvement les facteurs pour chaque prédiction

Réponds UNIQUEMENT en JSON valide (pas de markdown, pas de backticks) :
{
  "predictions": [
    {
      "date": "YYYY-MM-DD",
      "productId": "id_du_produit",
      "predicted": 120,
      "confidence": 0.85,
      "factors": ["lundi_classique", "beau_temps", "pas_ferie"],
      "comment": "Explication courte en français"
    }
  ],
  "alertes": [
    {
      "type": "meteo|ferie|evenement|tendance|historique_insuffisant",
      "icon": "emoji",
      "message": "Message d'alerte en français",
      "severity": "info|warning|danger"
    }
  ],
  "insights": {
    "tendanceGlobale": "hausse|stable|baisse",
    "jourPic": "dimanche",
    "jourCreux": "lundi",
    "commentaire": "Résumé en 1-2 phrases des tendances détectées",
    "caPrevisionnel": 0,
    "coutMPPrevisionnel": 0,
    "margePrevisionnel": 0
  }
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(response.status).json({ error: 'Erreur API IA', details: errText });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';

    let result;
    try {
      result = JSON.parse(text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
    } catch (e) {
      console.error('JSON parse error:', e, 'Raw:', text.substring(0, 500));
      result = {
        predictions: [],
        alertes: [{ type: 'error', icon: '⚠️', message: 'Erreur de format dans la réponse IA. Réessayez.', severity: 'danger' }],
        insights: { tendanceGlobale: 'stable', commentaire: 'Analyse indisponible.', jourPic: '—', jourCreux: '—' },
        raw: text.substring(0, 300)
      };
    }

    // Calculs CA/Marge côté serveur (plus fiable)
    if (result.predictions && result.predictions.length) {
      let totalCA = 0, totalCout = 0;
      result.predictions.forEach(pred => {
        const prod = products.find(p => p.id === pred.productId);
        if (prod) {
          totalCA += (pred.predicted || 0) * (prod.pvHT || 0);
          totalCout += (pred.predicted || 0) * (prod.coutUnitaire || 0);
        }
      });
      if (!result.insights) result.insights = {};
      result.insights.caPrevisionnel = Math.round(totalCA * 100) / 100;
      result.insights.coutMPPrevisionnel = Math.round(totalCout * 100) / 100;
      result.insights.margePrevisionnel = Math.round((totalCA - totalCout) * 100) / 100;
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('previsions-ai error:', err);
    return res.status(500).json({ error: err.message });
  }
}
