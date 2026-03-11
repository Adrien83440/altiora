/**
 * api/vocal-ai.js
 * Proxy Vercel — Assistant vocal business
 * Reçoit une question + métriques, répond en texte court (pour Speech Synthesis)
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
    const { question, metrics, prenom } = req.body;
    if (!question) return res.status(400).json({ error: 'Question manquante' });

    const prompt = `Tu es un assistant vocal business pour un chef d'entreprise TPE/PME français. Il te pose une question à voix haute et tu dois répondre comme si tu parlais — phrases courtes, naturelles, directes. Tutoie-le.

${prenom ? 'Son prénom : ' + prenom : ''}

SES DONNÉES ACTUELLES :
${JSON.stringify(metrics, null, 2)}

SA QUESTION : "${question}"

CONSIGNES :
- Réponds en 2-4 phrases maximum, comme à l'oral
- Donne des chiffres précis tirés de ses données
- Sois direct et concret
- Pas de formules de politesse excessives
- Si tu ne peux pas répondre avec les données dispo, dis-le simplement
- Utilise "euros" en toutes lettres (pas €) pour la lecture vocale
- Pas de listes à puces, que du texte fluide`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: 'Erreur API', details: errText });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || 'Désolé, je n\'ai pas pu analyser ta question.';

    return res.status(200).json({ answer: text });

  } catch (err) {
    console.error('vocal-ai error:', err);
    return res.status(500).json({ error: err.message });
  }
}
