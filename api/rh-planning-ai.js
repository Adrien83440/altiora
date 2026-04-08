// api/rh-planning-ai.js — Proxy ALTEORE Planning RH IA → Claude API (Sonnet)
// Appelé via fetch('/api/rh-planning-ai') depuis rh-planning.html


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

// ── Firestore log (admin token) ──
async function _logRun(uid, payload) {
  try {
    const fbKey = process.env.FIREBASE_API_KEY;
    const email = process.env.FIREBASE_API_EMAIL;
    const password = process.env.FIREBASE_API_PASSWORD;
    if (!fbKey || !email || !password) return;
    const a = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${fbKey}`,
      {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true})});
    if (!a.ok) return;
    const {idToken} = await a.json();
    const docId = Date.now().toString();
    const url = `https://firestore.googleapis.com/v1/projects/altiora-70599/databases/(default)/documents/rh_ai_logs/${uid}/runs?documentId=${docId}`;
    const fields = {
      ts: { timestampValue: new Date().toISOString() },
      prompt: { stringValue: (payload.prompt||'').slice(0, 20000) },
      response: { stringValue: (payload.response||'').slice(0, 20000) },
      stop_reason: { stringValue: payload.stop_reason||'' },
      input_tokens: { integerValue: payload.input_tokens||0 },
      output_tokens: { integerValue: payload.output_tokens||0 },
      ok: { booleanValue: !!payload.ok }
    };
    await fetch(url, {method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${idToken}`},body:JSON.stringify({fields})});
  } catch(e) { console.error('[rh-planning-ai] log failed:', e.message); }
}

export default async function handler(req, res) {
  if (_cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await _verifyAuth(req, res);
  if (!auth) return;
  if (_rateLimit(auth.uid, res, 15)) return;

  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { prompt, max_tokens } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt required' });
    }

    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY not configured');
      return res.status(500).json({ error: 'API key not configured' });
    }

    const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: Math.min(max_tokens || 16000, 32000),
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!apiResponse.ok) {
      const errText = await apiResponse.text();
      console.error('Claude API error:', apiResponse.status, errText);
      return res.status(502).json({ error: 'AI service error', details: apiResponse.status });
    }

    const data = await apiResponse.json();
    const text = data.content
      ?.filter(b => b.type === 'text')
      ?.map(b => b.text)
      ?.join('\n') || '';

    if (data.stop_reason === 'max_tokens') {
      await _logRun(auth.uid, { prompt, response: text, stop_reason: 'max_tokens', input_tokens: data.usage?.input_tokens, output_tokens: data.usage?.output_tokens, ok: false });
      return res.status(502).json({ error: 'Réponse IA tronquée. Réduisez le nombre d\'employés ou simplifiez les instructions.' });
    }

    await _logRun(auth.uid, { prompt, response: text, stop_reason: data.stop_reason||'end_turn', input_tokens: data.usage?.input_tokens, output_tokens: data.usage?.output_tokens, ok: true });
    return res.status(200).json({ text, usage: data.usage || null });

  } catch (error) {
    console.error('RH Planning AI error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}
