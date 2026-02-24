const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

module.exports = async function handler(req, res) {
  // CORS
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

    // Contexte des années précédentes pour comparaison
    let contextYears = '';
    if (existingYears && Object.keys(existingYears).length > 0) {
      contextYears = `\n\nDonnées des bilans précédents déjà enregistrés pour comparaison :\n${JSON.stringify(existingYears, null, 2)}\nCompare avec ces données et indique les évolutions.`;
    }

    // Construire le contenu avec les images des pages
    const content = [];
    for (let i = 0; i < pages.length; i++) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: pages[i]
        }
      });
    }

    // Ajouter le prompt texte
    content.push({
      type: 'text',
      text: `Tu es un expert-comptable et analyste financier. Tu viens de voir les pages d'un bilan comptable (fichier: ${fileName || 'bilan.pdf'}).

Analyse ce bilan et retourne UNIQUEMENT un JSON valide (pas de markdown, pas de backticks, juste le JSON brut).

Structure exacte attendue :

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
  
  "resumeIA": "Un paragraphe de résumé global de la santé financière, rédigé simplement pour un commerçant non-expert."
}

Règles IMPORTANTES :
- Lis attentivement CHAQUE chiffre dans les tableaux du bilan. Fais attention aux colonnes (exercice N vs N-1, brut vs amortissements vs net)
- Prends toujours les valeurs de la colonne "Net" ou "Exercice N" (l'exercice le plus récent)
- Tous les montants en euros (nombre, pas de string). Pas de séparateurs de milliers
- Si une donnée n'est pas trouvée dans le bilan, mettre 0
- Les ratios en pourcentage (ex: 15.5 pour 15.5%)
- BFR en jours de CA
- Minimum 4 conseils, maximum 8
- Le résumé IA doit être en français, accessible, avec des recommandations concrètes
- L'année doit correspondre à la date de clôture du bilan
- VÉRIFIE que totalActif = totalActifImmobilise + totalActifCirculant (à peu près)
- VÉRIFIE que totalPassif = totalCapitauxPropres + totalDettes (à peu près)
- SECTEUR : identifie le code NAF/APE sur le bilan. Si absent, déduis le secteur d'activité depuis la raison sociale, les achats ou la nature de l'activité. Utilise tes connaissances des moyennes sectorielles françaises (INSEE, Banque de France, greffes) pour remplir le benchmark. Les moyennes doivent être réalistes pour le secteur identifié. La position compare le ratio de l'entreprise à la moyenne du secteur.
- Intègre la comparaison sectorielle dans les conseils quand c'est pertinent (ex: "Votre marge est supérieure à la moyenne du secteur")${contextYears}`
    });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: content }]
    });

    // Extraire le JSON de la réponse
    let text = response.content[0].text.trim();
    // Nettoyage si Claude ajoute des backticks
    if (text.startsWith('```')) {
      text = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    }

    const data = JSON.parse(text);
    return res.status(200).json({ success: true, data });

  } catch (err) {
    console.error('Erreur analyze-bilan:', err);
    return res.status(500).json({ 
      error: 'Erreur lors de l\'analyse du bilan',
      detail: err.message 
    });
  }
};
