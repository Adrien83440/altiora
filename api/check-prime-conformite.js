/**
 * api/check-prime-conformite.js
 * Vérification IA de la conformité d'un objectif/prime
 * avec la CCN applicable au salarié
 */

// ── Auth inline (pattern Vercel serverless) ──
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

module.exports = async function(req, res) {
  if(_cors(req,res)) return;
  if(req.method!=='POST') return res.status(405).json({error:'POST uniquement'});
  const user=await _verifyAuth(req,res);
  if(!user) return;
  if(_rateLimit(user.uid,res,5)) return;

  const { objectif, ccn, employe } = req.body || {};
  if(!objectif) return res.status(400).json({error:'Objectif manquant.'});

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if(!ANTHROPIC_KEY) return res.status(500).json({error:'Clé API IA non configurée.'});

  // Construire le prompt
  const criteres = (objectif.criteres||[]).map((c,i) =>
    `  ${i+1}. ${c.label||'Sans nom'} — Cible: ${c.cible||'?'} ${c.unite||''} — Poids: ${c.poids||0}%`
  ).join('\n');

  const prime = objectif.prime || {};
  const palierDesc = prime.modePalier === 'paliers'
    ? (prime.paliers||[]).map(p => `    ≥${p.seuil}% → ${p.primePct}% de la prime`).join('\n')
    : prime.modePalier === 'proportionnel' ? '    Proportionnel au taux d\'atteinte' : '    Tout ou rien (100% requis)';

  const empDesc = employe
    ? `- Salarié : ${employe.prenom||''} ${employe.nom||''}, poste ${employe.poste||'non précisé'}, contrat ${employe.typeContrat||'CDI'}, salaire brut ${employe.salaireBrut||'?'}€/mois`
    : '- Salarié : non précisé';

  const ccnDesc = ccn ? `- CCN applicable : ${ccn}` : '- CCN : non renseignée';

  const prompt = `Tu es un expert en droit du travail français, spécialisé dans les conventions collectives et la rémunération variable. Analyse la conformité de cet objectif/prime :

OBJECTIF :
- Titre : ${objectif.titre || 'Sans titre'}
- Type : ${objectif.type || 'individuel'} (individuel / équipe / exceptionnel)
- Périodicité : ${objectif.periodicite || 'non précisé'}
- Description : ${objectif.description || 'Aucune'}
${empDesc}
${ccnDesc}

CRITÈRES D'ÉVALUATION :
${criteres || '  Aucun critère défini'}

PRIME :
- Montant brut : ${prime.montantBrut || '0'}€ (mode: ${prime.mode || 'fixe'})
- Mode déclenchement : ${prime.modePalier || 'tout_ou_rien'}
${palierDesc}
- Taux charges patronales : ${prime.tauxCharges || 45}%

ANALYSE DEMANDÉE :
1. **Conformité légale** : Cet objectif et cette prime sont-ils conformes au Code du travail français ? Les critères sont-ils suffisamment objectifs et vérifiables ?
2. **Conformité CCN** : Si la CCN est renseignée, y a-t-il des dispositions spécifiques (primes obligatoires, minima, 13ème mois, prime d'ancienneté) qui pourraient interférer ou compléter cet objectif ?
3. **Risques juridiques** : Identifie les risques potentiels (discrimination, inégalité de traitement, requalification d'usage, etc.)
4. **Recommandations** : Suggestions concrètes pour sécuriser juridiquement cet objectif.
5. **Formulation** : Si les critères sont flous, propose une reformulation SMART.

Réponds en français, de manière structurée et concise. Mets en avant les points critiques.`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('Anthropic API error:', resp.status, err);
      return res.status(502).json({ error: 'Erreur API IA. Réessayez.' });
    }

    const data = await resp.json();
    const analyse = (data.content || []).map(b => b.text || '').join('\n').trim();

    return res.status(200).json({ analyse });
  } catch (e) {
    console.error('check-prime-conformite error:', e);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
};
