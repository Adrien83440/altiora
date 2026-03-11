/**
 * api/generate-contrat.js
 * Génération de contrats de travail — Claude Haiku (rapide, fiable)
 * Données légales intégrées directement (pas de web search = pas de rate limit)
 */

// ════════════════════════════════════════════════════════════════
// 📋 DONNÉES LÉGALES — À METTRE À JOUR QUAND LA LOI CHANGE
//    Le SMIC change en général au 1er janvier (parfois novembre)
//    Dernière mise à jour : novembre 2024
// ════════════════════════════════════════════════════════════════
const LEGAL = {
  smicHoraire: '11,88',           // € brut/heure
  smicMensuel: '1 801,80',        // € brut/mois pour 35h
  smicDate: 'novembre 2024',      // Date de la dernière revalorisation
  gratificationStage: '4,35',     // € minimum/heure
  // Période d'essai CDI (art. L.1221-19)
  essaiEmploye: '2 mois',
  essaiMaitrise: '3 mois',
  essaiCadre: '4 mois',
  // CDD
  cddDureeMax: '18 mois',
  cddIndemnite: '10%',
  // Apprentissage (% du SMIC par année)
  apprentissage: '16-17 ans 27%/39%/55%, 18-20 ans 43%/51%/67%, 21-25 ans 53%/61%/78%, 26+ ans 100%',
};
// ════════════════════════════════════════════════════════════════

export const config = { maxDuration: 90 };

function _cors(req, res) {
  const origin = req.headers.origin;
  const allowed = ['https://alteore.com', 'https://www.alteore.com'];
  if (allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  else res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') { res.status(200).end(); return true; }
  return false;
}

async function _verifyAuth(req, res) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) { res.status(401).json({ error: 'Non authentifie.' }); return null; }
  try {
    const apiKey = process.env.FIREBASE_API_KEY;
    if (!apiKey) { res.status(500).json({ error: 'Config serveur manquante.' }); return null; }
    const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + apiKey, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token })
    });
    if (!r.ok) { res.status(401).json({ error: 'Token invalide.' }); return null; }
    const d = await r.json();
    const u = d.users?.[0];
    if (!u?.localId) { res.status(401).json({ error: 'Utilisateur introuvable.' }); return null; }
    return { uid: u.localId };
  } catch (e) { res.status(401).json({ error: 'Erreur auth.' }); return null; }
}

const SYSTEM_PROMPT = `Tu es un juriste expert en droit du travail francais. Tu rediges des contrats de travail complets et conformes.

DONNEES LEGALES EN VIGUEUR :
- SMIC horaire brut : ${LEGAL.smicHoraire} euros (${LEGAL.smicDate}), soit ${LEGAL.smicMensuel} euros mensuel brut pour 35h
- Duree legale du travail : 35 heures hebdomadaires (art. L.3121-27)
- Conges payes : 2,5 jours ouvrables par mois, soit 30 jours/an (art. L.3141-3)
- Periode essai CDI (art. L.1221-19) : Ouvriers/Employes ${LEGAL.essaiEmploye}, Agents de maitrise ${LEGAL.essaiMaitrise}, Cadres ${LEGAL.essaiCadre}
- Renouvellement essai : 1 fois si accord de branche le prevoit (art. L.1221-21)
- CDD duree max : ${LEGAL.cddDureeMax} renouvellements inclus (art. L.1242-8)
- Indemnite fin CDD : ${LEGAL.cddIndemnite} des remunerations brutes (art. L.1243-8)
- Stage : max 6 mois/an enseignement, gratification obligatoire si > 2 mois : ${LEGAL.gratificationStage} euros/h minimum
- Apprentissage remuneration (% SMIC) : ${LEGAL.apprentissage}
- Preavis demission/licenciement : selon CCN, a defaut 1 mois (< 2 ans), 2 mois (>= 2 ans)
- Mutuelle obligatoire depuis 2016 (ANI), participation employeur >= 50%

Si un IDCC est fourni, mentionne que les dispositions conventionnelles plus favorables prevalent.
IMPORTANT : Tu disposes d'1 recherche web. Utilise-la pour rechercher "convention collective IDCC [numero] periode essai preavis grille salaire" afin d'adapter le contrat aux dispositions specifiques de la CCN du salarie.

FORMAT DE SORTIE :
1. Ta reponse commence DIRECTEMENT par <h1>. AUCUN texte avant. ZERO introduction.
2. HTML : <h1> titre, <h2> articles, <p> paragraphes, <strong> gras, <em> italique, <ul>/<li> listes
3. JAMAIS de placeholders [A COMPLETER]
4. JAMAIS de backticks markdown
5. Le premier caractere de ta reponse est le symbole <

STRUCTURE :
<h1>CONTRAT DE [TYPE]</h1>
<p><em>Conforme aux articles L.xxxx et suivants du Code du travail</em></p>
ENTRE (employeur) ET (salarie)
Art. 1 Engagement / Art. 2 Fonctions / Art. 3 Lieu / Art. 4 Duree / Art. 5 Essai / Art. 6 Horaires / Art. 7 Remuneration / Art. 8 Conges / Art. 9 Protection sociale / Art. 10 CCN / Art. 11 Obligations / Art. 12 Preavis et rupture / Art. 13 RGPD / + clauses optionnelles / Art. final Dispositions generales
Signatures (table 2 colonnes) + "Fait en deux exemplaires originaux"
Disclaimer italique en fin.`;

export default async function handler(req, res) {
  if (_cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await _verifyAuth(req, res);
  if (!auth) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configuree.' });

  try {
    const { type, employeur, salarie, conditions, clauses, idcc, ccnNom } = req.body;
    if (!type || !employeur || !salarie || !conditions) {
      return res.status(400).json({ error: 'Donnees incompletes.' });
    }

    const typeLabels = {
      'cdi_tp': 'CDI a temps plein', 'cdi_partiel': 'CDI a temps partiel',
      'cdd_remplacement': 'CDD de remplacement', 'cdd_surcroit': 'CDD pour surcroit d\'activite',
      'cdd_saisonnier': 'CDD saisonnier', 'apprentissage': 'Contrat d\'apprentissage',
      'professionnalisation': 'Contrat de professionnalisation', 'stage': 'Convention de stage'
    };

    const userPrompt = `Genere un ${typeLabels[type] || type} complet.

EMPLOYEUR : ${employeur.raisonSociale||'?'} (${employeur.formeJuridique||'?'}), SIRET ${employeur.siret||'?'}, ${employeur.adresse||'?'}, represente par ${employeur.representant||'?'} (${employeur.qualiteRepresentant||'Gerant'}), APE ${employeur.codeAPE||'?'}, CCN ${ccnNom||'?'} IDCC ${idcc||'?'}, mutuelle ${employeur.mutuelle||'?'}, prevoyance ${employeur.prevoyance||'?'}

${type==='stage'?'STAGIAIRE':'SALARIE'} : ${salarie.civilite||'M.'} ${salarie.prenom||''} ${salarie.nom||''}, ne(e) le ${salarie.dateNaissance||'?'} a ${salarie.lieuNaissance||'?'}, ${salarie.nationalite||'Francaise'}, ${salarie.adresse||'?'}, SS ${salarie.numSS||'?'}${salarie.etablissement?' | Formation: '+salarie.etablissement:''}${salarie.diplome?' ('+salarie.diplome+')':''}${salarie.tuteur?' | Tuteur: '+salarie.tuteur:''}

CONDITIONS : poste ${conditions.poste||'?'}, qualification ${conditions.qualification||'selon CCN'}, debut ${conditions.dateDebut||'?'}${conditions.dateFin?', fin '+conditions.dateFin:''}${conditions.duree?', duree '+conditions.duree:''}${conditions.motifCDD?', motif: '+conditions.motifCDD:''}${conditions.salarieRemplace?', remplace '+conditions.salarieRemplace:''}, lieu ${conditions.lieuTravail||'?'}, ${conditions.dureeHebdo||'35'}h/sem${conditions.repartitionHoraire?', repartition: '+conditions.repartitionHoraire:''}, remuneration ${conditions.remuneration||'?'} euros brut/mois${conditions.periodeEssai?', essai '+conditions.periodeEssai:''}${conditions.renouvellementEssai?', renouvellement oui':''}${conditions.gratification?', gratification '+conditions.gratification+' euros/mois':''}

CLAUSES : ${clauses&&clauses.length>0?clauses.map(c=>{
if(c.type==='non_concurrence')return'non-concurrence '+( c.duree||'1 an')+' zone '+(c.perimetre||'departementale')+' contrepartie '+(c.contrepartie||'30%');
if(c.type==='teletravail')return'teletravail '+(c.jours||'2')+'j/sem indemnite '+(c.indemnite||'0')+'euros';
if(c.type==='mobilite')return'mobilite '+(c.perimetre||'national');
if(c.type==='dedit_formation')return'dedit-formation '+(c.duree||'2 ans');
return c.type.replace(/_/g,' ');}).join(', '):'aucune'}

Commence directement par <h1>.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 1
          }
        ],
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error('Anthropic error:', response.status, errText);
      return res.status(502).json({ error: 'Erreur IA. Reessayez dans quelques secondes.' });
    }

    const data = await response.json();
    let rawText = '';
    if (data.content && Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text' && block.text) rawText += block.text;
      }
    }

    rawText = rawText.replace(/```html?\s*/gi, '').replace(/```/g, '').trim();

    let htmlContent = rawText;
    const m = rawText.match(/<h1[\s>]/i);
    if (m && m.index > 0) htmlContent = rawText.substring(m.index);

    if (!htmlContent || htmlContent.length < 50) {
      return res.status(500).json({ error: 'Contenu genere trop court.' });
    }

    return res.status(200).json({
      html: htmlContent,
      type,
      typeLabel: typeLabels[type] || type,
      generatedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('generate-contrat error:', err);
    return res.status(500).json({ error: 'Erreur serveur', details: err.message });
  }
}
