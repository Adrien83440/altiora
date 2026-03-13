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

  const prompt = `Tu es un expert en droit du travail français, spécialisé dans les conventions collectives et la rémunération variable.

Analyse la conformité de cet objectif/prime :

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
1. Conformité légale : conformité Code du travail, critères objectifs et vérifiables ?
2. Conformité CCN : dispositions spécifiques (primes obligatoires, minima, 13ème mois, ancienneté) ?
3. Risques juridiques : discrimination, inégalité de traitement, requalification d'usage, etc.
4. Recommandations : suggestions concrètes pour sécuriser juridiquement.
5. Formulation : si critères flous, propose une reformulation SMART.

INSTRUCTIONS DE FORMAT (OBLIGATOIRE) :
- Réponds UNIQUEMENT en HTML valide (pas de markdown, pas de \`\`\`, pas de **).
- Utilise ces balises : <h3> pour les titres de section, <p> pour les paragraphes, <ul>/<li> pour les listes, <strong> pour le gras, <em> pour l'italique.
- Pour les alertes critiques utilise : <div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:8px;padding:10px 12px;margin:8px 0;font-size:12px;color:#991b1b">🔴 texte</div>
- Pour les alertes modérées : <div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:10px 12px;margin:8px 0;font-size:12px;color:#92400e">⚠️ texte</div>
- Pour les points conformes : <div style="background:#d1fae5;border:1px solid #6ee7b7;border-radius:8px;padding:10px 12px;margin:8px 0;font-size:12px;color:#065f46">✅ texte</div>
- Pour les recommandations : <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 12px;margin:8px 0;font-size:12px;color:#1e40af">💡 texte</div>
- Style global : font-size:12px, line-height:1.6, couleur texte #1a1f36.
- Sois concis. Max 600 mots.
- NE COMMENCE PAS par \`\`\`html. Retourne directement le HTML.`;

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
