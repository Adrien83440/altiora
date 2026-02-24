const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { pages, fileName, existingYears } = req.body;
    if (!pages || !Array.isArray(pages) || pages.length === 0) {
      return res.status(400).json({ error: 'Aucune page du PDF reçue' });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    let contextYears = '';
    if (existingYears && Object.keys(existingYears).length > 0) {
      contextYears = `\n\nDonnées des bilans précédents déjà enregistrés pour comparaison :\n${JSON.stringify(existingYears, null, 2)}\nCompare avec ces données et indique les évolutions.`;
    }

    // Construire le contenu avec les images des pages
    const content = [];
    for (let i = 0; i < pages.length; i++) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: pages[i] }
      });
    }

    content.push({
      type: 'text',
      text: `Tu es un expert-comptable. Tu viens de voir les pages d'un bilan comptable (fichier: ${fileName || 'bilan.pdf'}).

MISSION CRITIQUE : extraire les chiffres EXACTS du bilan. La précision des montants est FONDAMENTALE.

ATTENTION AUX COLONNES — Dans les bilans français :
- Il y a souvent 2 colonnes de chiffres : l'exercice N (le plus récent, souvent à gauche) et l'exercice N-1 (à droite)
- Il y a parfois 3 colonnes : BRUT | AMORTISSEMENTS | NET — prends TOUJOURS la colonne NET
- La date de clôture est indiquée en haut du tableau (ex: "31/12/2022" et "31/12/2021")
- Tu dois extraire UNIQUEMENT les chiffres de l'exercice le plus récent (celui de la date de clôture principale)
- NE MÉLANGE JAMAIS les chiffres des deux exercices

VÉRIFICATIONS OBLIGATOIRES avant de répondre :
1. TOTAL ACTIF doit être ÉGAL à TOTAL PASSIF (c'est une règle comptable absolue — si ce n'est pas le cas, tu as fait une erreur)
2. totalActif = totalActifImmobilise + totalActifCirculant
3. totalPassif = totalCapitauxPropres + totalDettes
4. Les totaux intermédiaires doivent correspondre à la somme de leurs composants
5. Si un montant est négatif dans le bilan (entre parenthèses ou avec un signe -), reporte-le comme négatif

SI TU AS UN DOUTE SUR UN CHIFFRE : relis la page correspondante. Mieux vaut mettre 0 que d'inventer un montant.

Retourne UNIQUEMENT un JSON valide (pas de markdown, pas de backticks, juste le JSON brut).

{
  "annee": "2024",
  "dateCloture": "31/12/2024",
  "entreprise": "Nom de l'entreprise",
  "formeJuridique": "SARL/SAS/etc",
  
  "actif": {
    "immobilisationsIncorporelles": 0,
    "immobilisationsCorporelles": 0,
    "immobilisationsFinancieres": 0,
    "totalActifImmobilise": 0,
    "stocks": 0,
    "creancesClients": 0,
    "autresCreances": 0,
    "tresorerieActive": 0,
    "totalActifCirculant": 0,
    "totalActif": 0
  },
  
  "passif": {
    "capitalSocial": 0,
    "reserves": 0,
    "resultatExercice": 0,
    "totalCapitauxPropres": 0,
    "dettesFinancieres": 0,
    "dettesFournisseurs": 0,
    "dettesFiscalesSociales": 0,
    "autresDettes": 0,
    "totalDettes": 0,
    "totalPassif": 0
  },
  
  "compteResultat": {
    "chiffreAffaires": 0,
    "achatsChargesExternes": 0,
    "valeurAjoutee": 0,
    "chargesPersonnel": 0,
    "ebe": 0,
    "dotationsAmortissements": 0,
    "resultatExploitation": 0,
    "resultatFinancier": 0,
    "resultatExceptionnel": 0,
    "impotSocietes": 0,
    "resultatNet": 0
  },
  
  "ratios": {
    "tauxMargeBrute": 0,
    "tauxEBE": 0,
    "tauxResultatNet": 0,
    "ratioEndettement": 0,
    "capaciteAutofinancement": 0,
    "tresorerieNette": 0,
    "bfrJours": 0,
    "ratioLiquiditeGenerale": 0,
    "rentabiliteCapitauxPropres": 0
  },

  "secteur": {
    "codeNAF": "47.11B",
    "libelle": "Commerce de détail alimentaire",
    "benchmark": {
      "tauxMargeBrute": {"moyenne": 0, "position": "au-dessus|en-dessous|dans la moyenne"},
      "tauxEBE": {"moyenne": 0, "position": "au-dessus|en-dessous|dans la moyenne"},
      "tauxResultatNet": {"moyenne": 0, "position": "au-dessus|en-dessous|dans la moyenne"},
      "ratioEndettement": {"moyenne": 0, "position": "au-dessus|en-dessous|dans la moyenne"},
      "bfrJours": {"moyenne": 0, "position": "au-dessus|en-dessous|dans la moyenne"},
      "ratioLiquiditeGenerale": {"moyenne": 0, "position": "au-dessus|en-dessous|dans la moyenne"}
    },
    "commentaire": "Phrase résumant la position de l'entreprise par rapport à son secteur"
  },
  
  "conseils": [
    {
      "type": "force|faiblesse|opportunite|vigilance",
      "titre": "Titre court",
      "detail": "Explication détaillée et actionnable pour un commerçant"
    }
  ],
  
  "resumeIA": "Résumé global en français, accessible, avec recommandations concrètes."
}

Règles STRICTES :
- Tous les montants en euros (nombre entier, PAS de string, PAS de séparateurs de milliers)
- Ratios en pourcentage (ex: 15.5 pour 15.5%), BFR en jours de CA
- 4 à 8 conseils
- VÉRIFIE QUE totalActif == totalPassif (règle comptable fondamentale)
- SECTEUR : identifie le code NAF/APE ou déduis-le. Compare avec les moyennes sectorielles françaises.${contextYears}`
    });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: content }]
    });

    let text = response.content[0].text.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    }

    const data = JSON.parse(text);

    // VÉRIFICATION DE COHÉRENCE côté serveur
    const actif = data.actif || {};
    const passif = data.passif || {};
    const totalA = actif.totalActif || 0;
    const totalP = passif.totalPassif || 0;

    // Vérifier Actif = Passif (tolérance 2%)
    if (totalA > 0 && totalP > 0) {
      const ecart = Math.abs(totalA - totalP) / Math.max(totalA, totalP);
      if (ecart > 0.02) {
        // Forcer la cohérence : prendre le total le plus fiable
        // Le total général est souvent le plus fiable
        const totalRef = Math.min(totalA, totalP) > 0 ? Math.round((totalA + totalP) / 2) : Math.max(totalA, totalP);
        data._avertissement = "Écart détecté entre total actif (" + totalA + "€) et total passif (" + totalP + "€). Les chiffres peuvent contenir des imprécisions de lecture.";
      }
    }

    // Vérifier cohérence interne actif
    const sumActif = (actif.totalActifImmobilise || 0) + (actif.totalActifCirculant || 0);
    if (sumActif > 0 && totalA > 0) {
      const ecartActif = Math.abs(sumActif - totalA) / totalA;
      if (ecartActif > 0.05) {
        data._avertissement = (data._avertissement || '') + " Incohérence dans la décomposition de l'actif.";
      }
    }

    // Vérifier cohérence interne passif
    const sumPassif = (passif.totalCapitauxPropres || 0) + (passif.totalDettes || 0);
    if (Math.abs(sumPassif) > 0 && totalP > 0) {
      const ecartPassif = Math.abs(sumPassif - totalP) / totalP;
      if (ecartPassif > 0.05) {
        data._avertissement = (data._avertissement || '') + " Incohérence dans la décomposition du passif.";
      }
    }

    return res.status(200).json({ success: true, data });

  } catch (err) {
    console.error('Erreur analyze-bilan:', err);
    return res.status(500).json({
      error: 'Erreur lors de l\'analyse du bilan',
      detail: err.message
    });
  }
};
