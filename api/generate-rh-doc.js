/**
 * api/generate-rh-doc.js
 * Proxy Vercel pour l'API Anthropic — Module Documents RH
 * Evite les erreurs CORS lors des appels depuis le navigateur
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
async function _verifyAuth(req,res){const h=req.headers.authorization||'';const token=h.startsWith('Bearer ')?h.slice(7):'';if(!token){res.status(401).json({error:'Non authentifié.'});return null}try{const apiKey=process.env.FIREBASE_API_KEY;if(apiKey){const r=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key='+apiKey,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken:token})});if(!r.ok){res.status(401).json({error:'Token invalide.'});return null}const d=await r.json();const u=d.users?.[0];if(!u?.localId){res.status(401).json({error:'Utilisateur introuvable.'});return null}return{uid:u.localId}}const parts=token.split('.');if(parts.length!==3)throw new Error('Bad JWT');const payload=JSON.parse(Buffer.from(parts[1],'base64url').toString());if(payload.exp&&payload.exp<Date.now()/1000){res.status(401).json({error:'Token expiré.'});return null}const uid=payload.user_id||payload.sub;if(!uid){res.status(401).json({error:'UID absent.'});return null}return{uid}}catch(e){res.status(401).json({error:'Erreur auth.'});return null}}
const _rlBuckets=new Map();function _rateLimit(uid,res,max=20){const now=Date.now();let b=_rlBuckets.get(uid);if(!b||now>b.r){b={c:0,r:now+60000};_rlBuckets.set(uid,b)}b.c++;if(b.c>max){res.status(429).json({error:'Trop de requêtes.'});return true}return false}

export default async function handler(req, res) {
  if (_cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await _verifyAuth(req, res);
  if (!auth) return;
  if (_rateLimit(auth.uid, res, 15)) return;

  // CORS preflight


  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configuree dans les variables Vercel' });
  }

  try {
    const { prompt, docName } = req.body;

    if (!prompt || !docName) {
      return res.status(400).json({ error: 'Parametre prompt ou docName manquant' });
    }

    // Limite de taille pour eviter les abus
    if (prompt.length > 8000) {
      return res.status(400).json({ error: 'Prompt trop long' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2500,
        system: 'Tu es un expert juridique RH specialise dans le droit du travail francais. Tu generes des documents RH professionnels prets a signer. REGLE ABSOLUE : tu n\'utilises JAMAIS de placeholders comme [A COMPLETER], [NOM], [ADRESSE], [...] ou tout espace reserve. Si une information manque, tu rediges la clause de maniere generale. Le document doit etre pret a imprimer et signer immediatement.',
        messages: [
          { role: 'user', content: prompt }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(response.status).json({
        error: 'Erreur API Anthropic',
        details: errText
      });
    }

    const data = await response.json();
    const content = data.content?.[0]?.text || '';

    return res.status(200).json({ content });

  } catch (err) {
    console.error('generate-rh-doc error:', err);
    return res.status(500).json({ error: 'Erreur serveur', details: err.message });
  }
}
