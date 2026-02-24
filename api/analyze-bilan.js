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

═══════════════════════════════════════════════════
RÈGLE N°1 — IDENTIFICATION DE LA BONNE COLONNE (CRITIQUE)
═══════════════════════════════════════════════════

ÉTAPE 1 : Identifier la date de clôture principale du bilan
→ Elle est sur la page de garde (ex: "Période du 01/01/2022 au 31/12/2022")
→ La date de FIN (31/12/2022) = c'est l'exercice à extraire

ÉTAPE 2 : Pour CHAQUE tableau (actif, passif, compte de résultat), LIS L'EN-TÊTE DES COLONNES
→ Les en-têtes indiquent les dates : ex "31/12/2022" et "31/12/2021"  
→ La position varie selon les cabinets : parfois N est à gauche, parfois à droite
→ NE SUPPOSE JAMAIS la position. LIS la date en en-tête de chaque colonne.

ÉTAPE 3 : Extraire UNIQUEMENT les chiffres de la colonne dont la date correspond à la clôture principale
→ Si clôture = 31/12/2022, prends TOUS les chiffres sous l'en-tête "31/12/2022" 
→ IGNORE TOTALEMENT l'autre colonne (N-1)

CAS SPÉCIAL — Bilan actif avec colonnes BRUT | AMORTISSEMENTS | NET :
→ Prends la colonne NET de l'exercice N (pas le brut, pas les amortissements)
→ La colonne NET est celle qui donne le montant final après amortissements

PIÈGE FRÉQUENT : ne pas confondre la colonne "Exercice N" et "Exercice N-1". 
Si tes chiffres Total Actif ≠ Total Passif, tu as probablement mélangé les colonnes → recommence.

═══════════════════════════════════════════════════
RÈGLE N°2 — VÉRIFICATIONS DE COHÉRENCE OBLIGATOIRES
═══════════════════════════════════════════════════

AVANT de répondre, vérifie ces 3 égalités :
1. totalActif DOIT ÊTRE EXACTEMENT ÉGAL à totalPassif (sinon tu as mélangé les colonnes !)
2. totalActif = totalActifImmobilise + totalActifCirculant (±1€ d'arrondi max)
3. totalPassif = totalCapitauxPropres + totalDettes (±1€ d'arrondi max)

Si une de ces vérifications échoue : RELIS les tableaux, vérifie quelle colonne tu lis.
Le TOTAL GÉNÉRAL du bilan (dernière ligne "TOTAL GENERAL" ou "TOTAL ACTIF"/"TOTAL PASSIF") est toujours le chiffre le plus fiable → pars de là et remonte.

═══════════════════════════════════════════════════

Retourne UNIQUEMENT un JSON valide (pas de markdown, pas de backticks, juste le JSON brut).

{
  "annee": "2022",
  "dateCloture": "31/12/2022",
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
    "commentaire": "Phrase résumant la position par rapport au secteur"
  },
  
  "conseils": [
    {"type": "force|faiblesse|opportunite|vigilance", "titre": "Titre court", "detail": "Explication actionnable"}
  ],
  
  "resumeIA": "Résumé global en français accessible pour un commerçant."
}

Règles :
- Montants en euros (nombre entier, PAS de string, PAS de séparateurs)
- Ratios en % (ex: 15.5), BFR en jours de CA
- 4 à 8 conseils
- SECTEUR : identifie le code NAF/APE ou déduis-le. Compare avec moyennes sectorielles françaises.${contextYears}`
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
