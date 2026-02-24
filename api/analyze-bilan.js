const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { pdfBase64, fileName, existingYears } = req.body;
    if (!pdfBase64) return res.status(400).json({ error: 'PDF manquant' });

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Contexte des années précédentes pour comparaison
    let contextYears = '';
    if (existingYears && Object.keys(existingYears).length > 0) {
      contextYears = `\n\nDonnées des bilans précédents déjà enregistrés pour comparaison :\n${JSON.stringify(existingYears, null, 2)}\nCompare avec ces données et indique les évolutions.`;
    }

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdfBase64
              }
            },
            {
              type: 'text',
              text: `Tu es un expert-comptable et analyste financier. Analyse ce bilan comptable et retourne UNIQUEMENT un JSON valide (pas de markdown, pas de backticks, juste le JSON).

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
  
  "conseils": [
    {
      "type": "force|faiblesse|opportunite|vigilance",
      "titre": "Titre court",
      "detail": "Explication détaillée et actionnable pour un commerçant"
    }
  ],
  
  "resumeIA": "Un paragraphe de résumé global de la santé financière, rédigé simplement pour un commerçant non-expert."
}

Règles :
- Tous les montants en euros (nombre, pas de string)
- Si une donnée n'est pas trouvée dans le bilan, mettre 0
- Les ratios en pourcentage (ex: 15.5 pour 15.5%)
- BFR en jours de CA
- Minimum 4 conseils, maximum 8
- Le résumé IA doit être en français, accessible, avec des recommandations concrètes
- L'année doit correspondre à la date de clôture du bilan${contextYears}`
            }
          ]
        }
      ]
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
