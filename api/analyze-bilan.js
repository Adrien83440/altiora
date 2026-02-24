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
      text: `Tu es un expert-comptable français. Analyse ce bilan comptable et extrait les chiffres EXACTS.

═══════════════════════════════════════════════════
ÉTAPE 1 — IDENTIFIE LA DATE DE CLÔTURE
═══════════════════════════════════════════════════

Lis la page de garde. La période indiquée (ex: "du 01/01/2022 au 31/12/2022") te donne la date de clôture : 31/12/2022.
C'est L'UNIQUE exercice dont tu dois extraire les chiffres.

═══════════════════════════════════════════════════
ÉTAPE 2 — BILAN ACTIF : STRUCTURE EXACTE DU FORMAT PCG FRANÇAIS
═══════════════════════════════════════════════════

Le bilan actif au format PCG a TOUJOURS exactement 4 colonnes dans cet ordre :
  [BRUT] [AMORT./DÉPRÉC.] [NET exercice N] [NET exercice N-1]

Exemple réel que tu verras :
  TOTAL ACTIF IMMOBILISE | 69 332 | 18 058 | 51 274 | 37 511

→ 69 332 = Brut         ← IGNORE
→ 18 058 = Amortissements ← IGNORE  
→ 51 274 = NET 31/12/2022 ← PRENDS CETTE VALEUR ✓
→ 37 511 = NET 31/12/2021 ← IGNORE

RÈGLE ABSOLUE ACTIF : prends TOUJOURS la 3ème valeur numérique (avant-dernière), jamais la 4ème.

Autre exemple :
  TOTAL GENERAL | 101 452 | 18 058 | 83 394 | 61 334
→ totalActif = 83 394 ✓ (pas 61 334, pas 101 452)

═══════════════════════════════════════════════════
ÉTAPE 3 — BILAN PASSIF : STRUCTURE EXACTE DU FORMAT PCG FRANÇAIS
═══════════════════════════════════════════════════

Le bilan passif au format PCG a TOUJOURS exactement 2 colonnes :
  [exercice N = 31/12/2022] [exercice N-1 = 31/12/2021]

Exemple réel que tu verras :
  TOTAL CAPITAUX PROPRES | -6 508 | -696

→ -6 508 = 31/12/2022 ← PRENDS CETTE VALEUR ✓
→ -696   = 31/12/2021 ← IGNORE

  TOTAL DETTES | 89 902 | 62 031
→ 89 902 = 31/12/2022 ← PRENDS CETTE VALEUR ✓
→ 62 031 = 31/12/2021 ← IGNORE

  TOTAL GENERAL | 83 394 | 61 334
→ totalPassif = 83 394 ✓ (pas 61 334)

RÈGLE ABSOLUE PASSIF : prends TOUJOURS la 1ère valeur numérique, jamais la 2ème.

═══════════════════════════════════════════════════
ÉTAPE 4 — COMPTE DE RÉSULTAT
═══════════════════════════════════════════════════

Le compte de résultat a 2 colonnes de montants (+ colonnes variation) :
  [exercice N (12 mois)] [exercice N-1 (19 mois ou autre durée)]

Exemple :
  Chiffre d'affaires net | 237 155 | 133 939 | 103 217 | 77,06%
→ CA = 237 155 ✓ (première colonne de montant)

RÈGLE ABSOLUE CR : prends TOUJOURS la 1ère colonne de montant.

═══════════════════════════════════════════════════
ÉTAPE 5 — VÉRIFICATION OBLIGATOIRE AVANT DE RÉPONDRE
═══════════════════════════════════════════════════

Vérifie que : totalActif = totalPassif (exactement)
Si ce n'est pas le cas, tu as lu la mauvaise colonne → recommence depuis l'étape 2.

Les valeurs correctes pour ce bilan sont cohérentes quand actif = passif au centime près.

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
