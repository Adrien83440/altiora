/**
 * api/copilote-ai.js
 * Proxy Vercel — Copilote IA business quotidien
 * Analyse croisée de toutes les données métier
 */

// ── Auth inline ──
function _cors(req,res){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');if(req.method==='OPTIONS'){res.status(200).end();return true}return false}
async function _verifyAuth(req,res){const h=req.headers.authorization||'';const token=h.startsWith('Bearer ')?h.slice(7):'';if(!token){res.status(401).json({error:'Non authentifié.'});return null}try{const apiKey=process.env.FIREBASE_API_KEY;if(apiKey){const r=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key='+apiKey,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken:token})});if(!r.ok){res.status(401).json({error:'Token invalide.'});return null}const d=await r.json();const u=d.users?.[0];if(!u?.localId){res.status(401).json({error:'Utilisateur introuvable.'});return null}return{uid:u.localId}}const parts=token.split('.');if(parts.length!==3)throw new Error('Bad JWT');const payload=JSON.parse(Buffer.from(parts[1],'base64url').toString());if(payload.exp&&payload.exp<Date.now()/1000){res.status(401).json({error:'Token expiré.'});return null}const uid=payload.user_id||payload.sub;if(!uid){res.status(401).json({error:'UID absent.'});return null}return{uid}}catch(e){res.status(401).json({error:'Erreur auth.'});return null}}
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
    const { metrics, prenom } = req.body;
    if (!metrics) return res.status(400).json({ error: 'Metrics manquantes' });

    const now = new Date();
    const mois = now.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    const jour = now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

    const prompt = `Tu es le copilote IA d'un chef d'entreprise TPE/PME français. Tu analyses ses données et tu lui donnes un briefing quotidien concis, actionnable et personnalisé. Tutoie-le.

Date : ${jour}
${prenom ? 'Prénom : ' + prenom : ''}

DONNÉES DE L'ENTREPRISE :
${JSON.stringify(metrics, null, 2)}

CONSIGNES :
- Réponds UNIQUEMENT en JSON valide (pas de markdown, pas de backticks)
- Structure exacte requise :
{
  "score": <nombre 0-100 score santé global>,
  "scoreLabel": "<Excellent|Bon|Correct|Attention|Critique>",
  "greeting": "<salutation personnalisée courte avec le prénom si dispo, ex: Bonjour Adrien ! ou Bonne journée !>",
  "headline": "<phrase principale du briefing, 1 ligne max, percutante>",
  "insights": [
    {"icon": "<emoji>", "type": "<success|warning|danger|info|tip>", "text": "<insight concis et actionnable, max 2 phrases>"}
  ],
  "actions": [
    {"icon": "<emoji>", "priority": "<high|medium|low>", "text": "<action concrète recommandée>", "link": "<page.html ou null>"}
  ],
  "kpiComment": "<commentaire sur l'évolution des KPIs, 1-2 phrases>"
}

RÈGLES :
- 3 à 5 insights maximum, triés par importance
- 2 à 3 actions concrètes maximum
- Sois direct, pas de blabla. Donne des chiffres précis.
- Si le CA baisse, dis pourquoi (si tu peux le déduire) et quoi faire
- Si stock en rupture, quantifie l'impact potentiel
- Si charges augmentent vs CA, alerte
- Si un employé dépasse les heures légales, alerte urgente
- Si la trésorerie est tendue, propose des actions
- Adapte le ton : encourageant si tout va bien, direct et sérieux si problème
- Le score doit refléter la santé réelle : rentabilité, trésorerie, stock, conformité`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }]
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
      const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      result = JSON.parse(cleaned);
    } catch (e) {
      result = { score: 50, scoreLabel: 'Indisponible', greeting: 'Bonjour !', headline: 'Briefing temporairement indisponible', insights: [], actions: [], kpiComment: '', raw: text };
    }

    return res.status(200).json(result);

  } catch (err) {
    console.error('copilote-ai error:', err);
    return res.status(500).json({ error: err.message });
  }
}
