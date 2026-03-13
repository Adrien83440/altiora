/**
 * api/find-ccn.js
 * Recherche IA de Convention Collective Nationale
 * Reçoit une description de métier/activité → retourne la CCN applicable
 * avec toutes les règles (horaires, congés, primes) au format CCN_RULES
 */

// ── Auth inline (même pattern que generate-rh-doc.js) ──
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
const _rlBuckets=new Map();function _rateLimit(uid,res,max=10){const now=Date.now();let b=_rlBuckets.get(uid);if(!b||now>b.r){b={c:0,r:now+60000};_rlBuckets.set(uid,b)}b.c++;if(b.c>max){res.status(429).json({error:'Trop de requêtes. Réessayez dans 1 minute.'});return true}return false}

export default async function handler(req, res) {
  if (_cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await _verifyAuth(req, res);
  if (!auth) return;
  if (_rateLimit(auth.uid, res, 10)) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configurée' });
  }

  try {
    const { description } = req.body;
    if (!description || typeof description !== 'string' || description.trim().length < 3) {
      return res.status(400).json({ error: 'Description trop courte. Décrivez votre activité.' });
    }
    if (description.length > 500) {
      return res.status(400).json({ error: 'Description trop longue (max 500 caractères).' });
    }

    const systemPrompt = `Tu es un expert en droit du travail français, spécialisé dans les Conventions Collectives Nationales (CCN).

L'utilisateur décrit son activité professionnelle. Tu dois identifier LA convention collective la plus probable et retourner UNIQUEMENT un objet JSON valide (pas de markdown, pas de backticks, pas de texte avant/après).

RÈGLES IMPÉRATIVES :
- Identifie la CCN par son code IDCC officiel (registre Légifrance)
- Si tu hésites entre plusieurs CCN, choisis celle qui s'applique le plus souvent pour cette activité
- Les valeurs horaires sont les MAXIMUMS légaux de la CCN (pas le droit commun sauf si la CCN ne précise pas)
- congesPayes = nombre de jours ouvrés par an (25 minimum légal)
- RTTs = estimation standard pour cette CCN (0 si non applicable)
- Indique le niveau de confiance : "haute" (CCN évidente), "moyenne" (plusieurs possibles), "basse" (incertain)

FORMAT JSON EXACT à retourner :
{
  "key": "identifiant_court_sans_accents",
  "label": "Nom complet de la CCN",
  "idcc": 1234,
  "jourMax": 10,
  "hebdoMax": 48,
  "hebdoMoyMax": 44,
  "reposMin": 11,
  "pauseApres": 6,
  "pauseMin": 20,
  "note": "IDCC XXXX · Points clés de la CCN en 1-2 phrases",
  "primes": [
    {"nom": "Nom de la prime", "montant": "Montant ou description", "obligatoire": true, "note": "Détail"}
  ],
  "anciennete": [
    {"annees": 5, "bonus": "+X%", "note": "Détail"}
  ],
  "treizieme": false,
  "mutuelle": "Obligation légale ou spécificité CCN",
  "congesPayes": 25,
  "rtts": 0,
  "confiance": "haute",
  "alternatives": ["Autre CCN possible (IDCC XXXX)"],
  "explication": "Pourquoi cette CCN s'applique à votre activité, en 2-3 phrases."
}

Si tu ne trouves vraiment AUCUNE CCN applicable, retourne :
{"key": null, "error": "Impossible d'identifier une CCN. Précisez votre activité."}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        system: systemPrompt,
        messages: [
          { role: 'user', content: `Mon activité : ${description.trim()}` }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(502).json({ error: 'Erreur API IA', details: errText });
    }

    const data = await response.json();
    const raw = (data.content?.[0]?.text || '').trim();

    // Parse JSON — nettoyer les éventuelles backticks markdown
    let cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    let result;
    try {
      result = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('JSON parse error:', parseErr, 'Raw:', raw);
      return res.status(502).json({ error: 'Réponse IA invalide. Réessayez.' });
    }

    // Vérification minimale
    if (!result.key && !result.error) {
      return res.status(502).json({ error: 'Réponse IA incomplète. Réessayez.' });
    }

    return res.status(200).json(result);

  } catch (err) {
    console.error('find-ccn error:', err);
    return res.status(500).json({ error: 'Erreur serveur', details: err.message });
  }
}
