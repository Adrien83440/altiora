/**
 * api/generate-contrat.js
 * Génération de contrats de travail assistée par IA
 * Utilise Claude Sonnet + Web Search pour vérifier les lois en vigueur
 */

// ── Auth inline (même pattern que generate-rh-doc.js) ──
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
  if (!token) { res.status(401).json({ error: 'Non authentifié.' }); return null; }
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

const _rlBuckets = new Map();
function _rateLimit(uid, res, max = 8) {
  const now = Date.now();
  let b = _rlBuckets.get(uid);
  if (!b || now > b.r) { b = { c: 0, r: now + 60000 }; _rlBuckets.set(uid, b); }
  b.c++;
  if (b.c > max) { res.status(429).json({ error: 'Trop de requêtes. Attendez une minute.' }); return true; }
  return false;
}

// ── System prompt juridique ──
const SYSTEM_PROMPT = `Tu es un expert juridique spécialisé en droit du travail français, avec une expertise approfondie dans la rédaction de contrats de travail conformes au Code du travail et aux conventions collectives.

MISSION : Générer un contrat de travail complet, professionnel et juridiquement conforme à partir des informations fournies.

RÈGLE CRITIQUE DE FORMAT :
Ta réponse DOIT commencer DIRECTEMENT par la balise <h1> du titre du contrat.
Tu ne dois JAMAIS écrire de texte d'introduction, d'analyse, de résumé de recherche ou de raisonnement avant le HTML.
AUCUN texte avant <h1>. Pas de "Voici le contrat", pas de "J'ai trouvé", pas de résumé de recherche.
Uniquement le HTML du contrat, rien d'autre.

RÈGLES ABSOLUES :
1. RECHERCHE OBLIGATOIRE : Avant de rédiger, tu DOIS utiliser l'outil web_search pour :
   - Vérifier le SMIC horaire et mensuel brut en vigueur
   - Rechercher les dispositions spécifiques de la convention collective (IDCC fourni) : période d'essai, préavis, classification, grille salariale minimum
   - Vérifier les durées légales de période d'essai selon le type de contrat et la catégorie du salarié
   - Pour les CDD : vérifier les règles de durée maximale et de renouvellement en vigueur
   - Pour l'alternance : vérifier les pourcentages du SMIC par tranche d'âge en vigueur
   - Pour les stages : vérifier le montant minimum de la gratification en vigueur

2. MENTIONS OBLIGATOIRES : Chaque contrat DOIT inclure TOUTES les mentions légales obligatoires selon son type. Ne jamais en omettre. Inclure systématiquement :
   - Clause de préavis de rupture (délais selon ancienneté et CCN)
   - Mention RGPD : information sur le traitement des données personnelles du salarié
   - Mention du droit applicable et juridiction compétente (Conseil de Prud'hommes)
   - Pour les CDI : rappel des conditions de rupture (démission, licenciement, rupture conventionnelle)

3. PAS DE PLACEHOLDERS : Tu n'utilises JAMAIS de crochets [À COMPLÉTER], [NOM], etc. Si une information manque, rédige la clause de manière générale ou omets-la proprement.

4. FORMAT HTML :
   - Utilise <h1> pour le titre du contrat
   - <h2> pour les articles
   - <p> pour les paragraphes
   - <strong> pour les mentions importantes
   - <ul>/<li> pour les listes
   - Pas de CSS inline complexe
   - PAS de balise markdown, PAS de backticks

5. STRUCTURE TYPE d'un contrat :
   - En-tête : "CONTRAT DE [TYPE]" + "Conforme aux articles L.xxxx du Code du travail"
   - ENTRE (employeur) ET (salarié)
   - Article 1 : Engagement / Objet
   - Article 2 : Fonctions et qualification
   - Article 3 : Lieu de travail
   - Article 4 : Durée du contrat (CDI/CDD)
   - Article 5 : Période d'essai (+ renouvellement si applicable)
   - Article 6 : Durée et horaires de travail
   - Article 7 : Rémunération
   - Article 8 : Congés payés
   - Article 9 : Protection sociale (mutuelle, prévoyance)
   - Article 10 : Convention collective applicable
   - Article 11 : Obligations du salarié (confidentialité, loyauté)
   - Article 12 : Préavis de rupture (délais légaux et conventionnels)
   - Article 13 : Protection des données personnelles (RGPD)
   - Articles supplémentaires : clauses optionnelles demandées
   - Article final : Dispositions générales + juridiction compétente
   - Signatures (deux colonnes en HTML table)
   - Mention "Fait en deux exemplaires originaux"

6. Pour les CDD obligatoirement ajouter : motif de recours, nom du salarié remplacé si remplacement, date de fin ou durée minimale, possibilité de renouvellement, indemnité de fin de contrat (10%).

7. Pour les contrats d'alternance : mentionner le centre de formation, le diplôme préparé, la rémunération en % du SMIC, le maître d'apprentissage/tuteur.

8. Pour les conventions de stage : durée maximale 6 mois, gratification obligatoire si > 2 mois, pas de lien de subordination.

9. DISCLAIMER : Ajouter en fin de document dans un paragraphe en italique : "Ce document a été généré à l'aide d'un outil d'assistance à la rédaction. Il ne constitue pas un conseil juridique personnalisé. Il est recommandé de le faire vérifier par un professionnel du droit du travail avant signature."

RAPPEL FINAL : Ta sortie ne contient QUE du HTML. Le premier caractère de ta réponse est "<".`;

export default async function handler(req, res) {
  if (_cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await _verifyAuth(req, res);
  if (!auth) return;
  // Rate limit désactivé temporairement pour la phase de test
  // if (_rateLimit(auth.uid, res, 50)) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configurée.' });

  try {
    const { type, employeur, salarie, conditions, clauses, idcc, ccnNom } = req.body;

    if (!type || !employeur || !salarie || !conditions) {
      return res.status(400).json({ error: 'Données incomplètes.' });
    }

    // ── Construire le prompt utilisateur ──
    const typeLabels = {
      'cdi_tp': 'CDI à temps plein',
      'cdi_partiel': 'CDI à temps partiel',
      'cdd_remplacement': 'CDD de remplacement',
      'cdd_surcroit': 'CDD pour surcroît d\'activité',
      'cdd_saisonnier': 'CDD saisonnier',
      'apprentissage': 'Contrat d\'apprentissage',
      'professionnalisation': 'Contrat de professionnalisation',
      'stage': 'Convention de stage'
    };

    const userPrompt = `Génère un ${typeLabels[type] || type} complet et conforme.

INFORMATIONS EMPLOYEUR :
- Raison sociale : ${employeur.raisonSociale || 'Non renseigné'}
- Forme juridique : ${employeur.formeJuridique || 'Non renseigné'}
- SIRET : ${employeur.siret || 'Non renseigné'}
- Adresse : ${employeur.adresse || 'Non renseigné'}
- Représentant légal : ${employeur.representant || 'Non renseigné'} (${employeur.qualiteRepresentant || 'Gérant'})
- Code APE/NAF : ${employeur.codeAPE || 'Non renseigné'}
- Convention collective : ${ccnNom || 'Non renseigné'} (IDCC ${idcc || 'Non renseigné'})
- Organisme mutuelle : ${employeur.mutuelle || 'Non renseigné'}
- Organisme prévoyance : ${employeur.prevoyance || 'Non renseigné'}

INFORMATIONS ${type === 'stage' ? 'STAGIAIRE' : 'SALARIÉ(E)'} :
- Civilité : ${salarie.civilite || 'M.'}
- Nom : ${salarie.nom || 'Non renseigné'}
- Prénom : ${salarie.prenom || 'Non renseigné'}
- Date de naissance : ${salarie.dateNaissance || 'Non renseigné'}
- Lieu de naissance : ${salarie.lieuNaissance || 'Non renseigné'}
- Nationalité : ${salarie.nationalite || 'Française'}
- Adresse : ${salarie.adresse || 'Non renseigné'}
- N° Sécurité sociale : ${salarie.numSS || 'Non renseigné'}
${salarie.etablissement ? '- Établissement de formation : ' + salarie.etablissement : ''}
${salarie.diplome ? '- Diplôme préparé : ' + salarie.diplome : ''}
${salarie.tuteur ? '- Tuteur/Maître d\'apprentissage : ' + salarie.tuteur : ''}

CONDITIONS DU CONTRAT :
- Intitulé du poste : ${conditions.poste || 'Non renseigné'}
- Qualification / Coefficient : ${conditions.qualification || 'Non renseigné'}
- Date de début : ${conditions.dateDebut || 'Non renseigné'}
${conditions.dateFin ? '- Date de fin : ' + conditions.dateFin : ''}
${conditions.duree ? '- Durée : ' + conditions.duree : ''}
${conditions.motifCDD ? '- Motif de recours (CDD) : ' + conditions.motifCDD : ''}
${conditions.salarieRemplace ? '- Salarié remplacé : ' + conditions.salarieRemplace + ' (' + (conditions.posteRemplace || '') + ')' : ''}
- Lieu de travail : ${conditions.lieuTravail || 'Non renseigné'}
- Durée hebdomadaire de travail : ${conditions.dureeHebdo || '35'} heures
${conditions.repartitionHoraire ? '- Répartition horaire : ' + conditions.repartitionHoraire : ''}
- Rémunération brute mensuelle : ${conditions.remuneration || 'Non renseigné'} €
${conditions.periodeEssai ? '- Période d\'essai : ' + conditions.periodeEssai : ''}
${conditions.renouvellementEssai ? '- Renouvellement période d\'essai : Oui' : ''}
${conditions.gratification ? '- Gratification mensuelle (stage) : ' + conditions.gratification + ' €' : ''}

CLAUSES OPTIONNELLES DEMANDÉES :
${clauses && clauses.length > 0 ? clauses.map(c => {
      if (c.type === 'non_concurrence') return `- Clause de non-concurrence : durée ${c.duree || '1 an'}, périmètre géographique : ${c.perimetre || 'départemental'}, contrepartie financière : ${c.contrepartie || '30% du salaire'}`;
      if (c.type === 'confidentialite') return '- Clause de confidentialité';
      if (c.type === 'exclusivite') return '- Clause d\'exclusivité';
      if (c.type === 'teletravail') return `- Clause de télétravail : ${c.jours || '2'} jours/semaine, indemnité : ${c.indemnite || '0'} €/mois`;
      if (c.type === 'vehicule') return '- Véhicule de fonction';
      if (c.type === 'mobilite') return `- Clause de mobilité : ${c.perimetre || 'national'}`;
      if (c.type === 'dedit_formation') return `- Clause de dédit-formation : engagement ${c.duree || '2 ans'}, montant : ${c.montant || 'proportionnel'}`;
      return `- ${c.type}`;
    }).join('\n') : 'Aucune clause optionnelle'}

INSTRUCTIONS SPÉCIALES :
- Recherche les dispositions actuelles de la CCN IDCC ${idcc || '(non précisé)'} pour les clauses de période d'essai, préavis et classification.
- Vérifie que la rémunération est au moins égale au SMIC en vigueur${type === 'apprentissage' || type === 'professionnalisation' ? ' (ou au % applicable selon l\'âge pour l\'alternance)' : ''}.
- Rédige le contrat en HTML structuré, prêt à être affiché et imprimé.`;

    // ── Appel API Anthropic avec web_search ──
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 12000,
        system: SYSTEM_PROMPT,
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 8
          }
        ],
        messages: [
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(response.status).json({ error: 'Erreur API IA', details: errText });
    }

    const data = await response.json();

    // Extraire le texte des blocs de réponse (peut contenir text + tool_use + tool_result)
    let rawText = '';
    if (data.content && Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text' && block.text) {
          rawText += block.text;
        }
      }
    }

    // Nettoyer : enlever les éventuels backticks markdown
    rawText = rawText.replace(/```html?\s*/gi, '').replace(/```/g, '').trim();

    // CRITIQUE : extraire uniquement le HTML du contrat
    // Claude écrit souvent son raisonnement en texte brut AVANT le HTML
    // On cherche le premier tag HTML significatif et on coupe tout ce qui précède
    let htmlContent = rawText;
    const htmlStartPatterns = [
      /<h1[\s>]/i,
      /<div[\s>]/i,
      /<!DOCTYPE/i,
      /<html[\s>]/i,
      /<article[\s>]/i,
      /<section[\s>]/i,
      /<header[\s>]/i
    ];
    for (const pattern of htmlStartPatterns) {
      const match = rawText.match(pattern);
      if (match && match.index !== undefined) {
        htmlContent = rawText.substring(match.index);
        break;
      }
    }

    // Si aucun tag trouvé mais contient du HTML inline, chercher le premier <
    if (htmlContent === rawText && rawText.includes('<')) {
      const firstTag = rawText.indexOf('<');
      if (firstTag > 0) {
        htmlContent = rawText.substring(firstTag);
      }
    }

    if (!htmlContent) {
      return res.status(500).json({ error: 'Aucun contenu généré.' });
    }

    return res.status(200).json({
      html: htmlContent,
      type: type,
      typeLabel: typeLabels[type] || type,
      generatedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('generate-contrat error:', err);
    return res.status(500).json({ error: 'Erreur serveur', details: err.message });
  }
}
