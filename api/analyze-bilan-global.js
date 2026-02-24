const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { bilansData } = req.body;
    if (!bilansData || Object.keys(bilansData).length < 2) {
      return res.status(400).json({ error: 'Au moins 2 exercices requis pour une analyse globale.' });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    async function callWithRetry(params, maxRetries = 3) {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          return await client.messages.create(params);
        } catch (err) {
          if ((err.status === 429 || err.name === 'RateLimitError') && attempt < maxRetries - 1) {
            const retryAfter = parseInt(err.headers && err.headers['retry-after']) || 0;
            const delay = retryAfter > 0 ? (retryAfter * 1000 + 2000) : Math.pow(2, attempt) * 5000;
            console.log('Rate limit global, retry in ' + delay + 'ms');
            await new Promise(function(r) { setTimeout(r, delay); });
            continue;
          }
          throw err;
        }
      }
    }

    const sortedYears = Object.keys(bilansData).sort();
    const yFirst = sortedYears[0];
    const yLast = sortedYears[sortedYears.length - 1];
    const entreprise = bilansData[yLast].entreprise || 'l\'entreprise';
    const secteur = bilansData[yLast].secteur || '';

    // Construire un résumé compact des données pour chaque année
    var dataResume = '';
    sortedYears.forEach(function(y) {
      var d = bilansData[y];
      dataResume += '\n--- Exercice ' + y + ' ---\n';
      dataResume += 'CA: ' + d.ca + '€ | Achats+charges ext: ' + d.achats + '€\n';
      dataResume += 'VA: ' + d.va + '€ | Charges personnel: ' + d.chargesPersonnel + '€\n';
      dataResume += 'EBE: ' + d.ebe + '€ | Résultat exploitation: ' + d.resultatExploitation + '€\n';
      dataResume += 'Résultat net: ' + d.resultatNet + '€\n';
      if (d.totalActif > 0) dataResume += 'Total actif: ' + d.totalActif + '€ | Capitaux propres: ' + d.totalCapitauxPropres + '€ | Dettes: ' + d.totalDettes + '€\n';
      if (d.tresorerieActive > 0) dataResume += 'Trésorerie: ' + d.tresorerieActive + '€\n';
    });

    const prompt = `Tu es un expert-comptable et conseiller financier. Analyse l'évolution de ${entreprise}${secteur ? ' (secteur: ' + secteur + ')' : ''} sur ${sortedYears.length} exercices (${yFirst} → ${yLast}).

DONNÉES PAR EXERCICE :
${dataResume}

Fournis une analyse comparative approfondie et actionnable pour un commerçant.

Réponds UNIQUEMENT en JSON brut (sans markdown) avec cette structure exacte :
{
  "resumeGlobal": "Résumé narratif de 3-4 phrases sur la trajectoire globale de l'entreprise, ses forces et ses risques principaux. Accessible pour un non-comptable.",
  "tendances": [
    {"indicateur": "Chiffre d'affaires", "evolution": "+12% sur 3 ans", "direction": "hausse", "commentaire": "Croissance régulière"},
    {"indicateur": "EBE", "evolution": "-5% sur 3 ans", "direction": "baisse", "commentaire": "Pression sur les marges"},
    {"indicateur": "Résultat net", "evolution": "Stable", "direction": "stable", "commentaire": "Résultat contenu"},
    {"indicateur": "Trésorerie", "evolution": "+8k€", "direction": "hausse", "commentaire": "Amélioration de la liquidité"}
  ],
  "analyses": [
    {"theme": "croissance", "titre": "Croissance du chiffre d'affaires", "tonalite": "positif", "detail": "Analyse détaillée avec chiffres précis et contexte sectoriel."},
    {"theme": "rentabilite", "titre": "Rentabilité et marges", "tonalite": "vigilance", "detail": "Analyse de l'évolution des marges avec explication des causes."},
    {"theme": "tresorerie", "titre": "Situation de trésorerie", "tonalite": "positif", "detail": "Analyse de la trésorerie et du BFR."},
    {"theme": "endettement", "titre": "Structure financière", "tonalite": "neutre", "detail": "Analyse de l'endettement et des capitaux propres."},
    {"theme": "structure", "titre": "Structure des charges", "tonalite": "vigilance", "detail": "Analyse de l'évolution des charges et du point mort."}
  ],
  "recommandations": [
    {"priorite": "haute", "titre": "Action prioritaire", "detail": "Description concrète et actionnable."},
    {"priorite": "moyenne", "titre": "Optimisation à prévoir", "detail": "Description concrète et actionnable."},
    {"priorite": "basse", "titre": "Opportunité à saisir", "detail": "Description concrète et actionnable."}
  ]
}

Règles :
- direction = "hausse", "baisse" ou "stable"
- tonalite = "positif", "negatif", "vigilance" ou "neutre"
- theme = "croissance", "rentabilite", "tresorerie", "endettement", "structure" ou "investissement"
- priorite = "haute", "moyenne" ou "basse"
- Utilise les chiffres réels des données fournies dans tes analyses
- 4-5 tendances, 4-6 analyses, 2-4 recommandations`;

    const response = await callWithRetry({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    let text = response.content[0].text.trim();

    // Extraire le JSON robustement
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) {
      throw new Error('Réponse invalide du modèle');
    }
    text = text.slice(jsonStart, jsonEnd + 1);
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('Impossible de parser la réponse JSON: ' + e.message);
    }

    return res.status(200).json({ success: true, data });

  } catch (err) {
    console.error('Erreur analyze-bilan-global:', err);
    const isRateLimit = err.status === 429 || err.name === 'RateLimitError';
    return res.status(500).json({
      error: isRateLimit
        ? 'Limite de requêtes atteinte. Veuillez patienter 2 minutes.'
        : err.message || 'Erreur lors de l\'analyse globale',
      detail: err.message
    });
  }
};
