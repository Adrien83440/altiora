const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { pages, pdfText, mode, fileName, existingYears } = req.body;

    const hasText = mode === 'text' && pdfText && pdfText.trim().length > 200;
    const hasImages = pages && Array.isArray(pages) && pages.length > 0;

    if (!hasText && !hasImages) {
      return res.status(400).json({ error: 'Aucune donnée PDF reçue' });
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
            console.log('Rate limit, retry in ' + delay + 'ms');
            await new Promise(function(r) { setTimeout(r, delay); });
            continue;
          }
          throw err;
        }
      }
    }

    let contextYears = '';
    if (existingYears && Object.keys(existingYears).length > 0) {
      contextYears = '\nBilans existants pour comparaison: ' + JSON.stringify(existingYears);
    }

    const content = [];

    if (hasText) {
      const truncated = pdfText.length > 40000 ? pdfText.slice(0, 40000) + '\n[tronqué]' : pdfText;
      content.push({ type: 'text', text: 'Document comptable (texte extrait du PDF) :\n\n' + truncated });
    } else {
      const pagesToSend = pages.slice(0, 20);
      for (let i = 0; i < pagesToSend.length; i++) {
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: pagesToSend[i] } });
      }
    }

    content.push({
      type: 'text',
      text: `Tu es expert-comptable. Extrais UNIQUEMENT les données du tableau SIG (Soldes Intermédiaires de Gestion) de ce document comptable.

Le SIG est le tableau qui contient les lignes : Chiffre d'affaires, Marge brute, Valeur ajoutée, EBE, Résultat d'exploitation, Résultat net.
C'est le tableau le plus fiable — concentre-toi exclusivement dessus, ignore le bilan actif/passif.

RÈGLES DE LECTURE DU SIG :
1. Les lignes EN GRAS ou sur fond COLORÉ sont les TOTAUX (valeurs à extraire)
2. Les lignes normales en dessous sont des détails intermédiaires
3. Format [valeur | % | valeur répétée] → prendre la 1ère colonne de valeur
4. Format France/Export/Total → prendre la colonne "Total"
5. Ignorer toutes les colonnes % (valeurs < 100 avec décimale)
6. Valeurs négatives = normales (résultat déficitaire, charges financières)

CORRESPONDANCES EXACTES :
- "Chiffre d'affaires" / "Production totale" / "Prod + ventes marchandises" → chiffreAffaires
- "Achats et charges externes" / "Achats matières + charges externes" → achatsChargesExternes  
- "Valeur ajoutée" (ligne gras/colorée) → valeurAjoutee
- "Charges de personnel" / "Salaires et charges" → chargesPersonnel
- "Excédent Brut d'Exploitation" / "EBE" (ligne gras/colorée) → ebe
- "Dotations aux amortissements" → dotationsAmortissements
- "Résultat d'exploitation" (ligne gras/colorée) → resultatExploitation
- Produits financiers - Charges financières → resultatFinancier (peut être négatif)
- "Résultat exceptionnel" → resultatExceptionnel
- "Impôt sur les sociétés" / "IS" → impotSocietes
- "Résultat de l'exercice" / "Résultat net" (dernière ligne gras/colorée) → resultatNet

VÉRIFICATIONS INTERNES (corriger si besoin) :
- valeurAjoutee ≈ chiffreAffaires - achatsChargesExternes (±5%)
- ebe ≈ valeurAjoutee - chargesPersonnel (±5%)
- resultatExploitation ≈ ebe - dotationsAmortissements (±5%)
- resultatNet ≈ resultatExploitation + resultatFinancier + resultatExceptionnel - impotSocietes (±5%)
Si une valeur extraite ne vérifie pas ces équations, RELIS le tableau et corrige.

Pour le bilan (totalActif, totalPassif, capitaux propres, dettes, trésorerie) :
Extrais ces totaux s'ils sont clairement lisibles. Sinon mets 0 — ce n'est pas grave.

Réponds UNIQUEMENT en JSON brut (sans markdown, sans backticks) :
{"annee":"2024","dateCloture":"31/12/2024","entreprise":"Nom","formeJuridique":"SARL",
"actif":{"immobilisationsIncorporellesBrut":0,"immobilisationsIncorporellesAmort":0,"immobilisationsIncorporelles":0,"immobilisationsCorporellesBrut":0,"immobilisationsCorporellesAmort":0,"immobilisationsCorporelles":0,"immobilisationsFinancieresBrut":0,"immobilisationsFinancieresAmort":0,"immobilisationsFinancieres":0,"totalActifImmobiliseBrut":0,"totalActifImmobiliseAmort":0,"totalActifImmobilise":0,"tauxAmortissement":0,"stocks":0,"creancesClients":0,"autresCreances":0,"tresorerieActive":0,"chargesConstateesDavance":0,"totalActifCirculant":0,"totalActif":0},
"passif":{"capitalSocial":0,"reserves":0,"reportANouveau":0,"resultatExercice":0,"totalCapitauxPropres":0,"provisions":0,"dettesFinancieres":0,"dettesFournisseurs":0,"dettesFiscalesSociales":0,"autresDettes":0,"produitsConstatesAvance":0,"totalDettes":0,"totalPassif":0},
"compteResultat":{"chiffreAffaires":0,"achatsChargesExternes":0,"valeurAjoutee":0,"chargesPersonnel":0,"ebe":0,"dotationsAmortissements":0,"resultatExploitation":0,"resultatFinancier":0,"resultatExceptionnel":0,"impotSocietes":0,"resultatNet":0},
"ratios":{"tauxMargeBrute":0,"tauxEBE":0,"tauxResultatNet":0,"ratioEndettement":0,"capaciteAutofinancement":0,"tresorerieNette":0,"bfrJours":0,"ratioLiquiditeGenerale":0,"rentabiliteCapitauxPropres":0},
"secteur":{"codeNAF":"","libelle":"","benchmark":{"tauxMargeBrute":{"moyenne":0,"position":""},"tauxEBE":{"moyenne":0,"position":""},"tauxResultatNet":{"moyenne":0,"position":""},"ratioEndettement":{"moyenne":0,"position":""},"bfrJours":{"moyenne":0,"position":""},"ratioLiquiditeGenerale":{"moyenne":0,"position":""}},"commentaire":""},
"conseils":[{"type":"force","titre":"","detail":""}],
"resumeIA":""}

Montants = entiers. Ratios = décimal (ex: 14.65). 4-6 conseils actionnables.${contextYears}`
    });

    const response = await callWithRetry({
      model: hasText ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      messages: [{ role: 'user', content: content }]
    });

    let text = response.content[0].text.trim();

    // Extraire le JSON robustement
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
      throw new Error('Le document PDF ne contient pas de tableau SIG lisible. Assurez-vous que le fichier contient bien les Soldes Intermédiaires de Gestion.');
    }
    text = text.slice(jsonStart, jsonEnd + 1);
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

    let data;
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      const shortText = text.slice(0, 300);
      throw new Error('Impossible de lire le tableau SIG. Essayez un PDF natif issu directement du logiciel comptable. Détail: ' + shortText);
    }

    data._mode = hasText ? 'text' : 'image';

    // ── Vérifications et auto-corrections ────────────────────────────────
    const cr = data.compteResultat || {};

    // Recalculer valeurAjoutee si aberrante
    const vaCalculee = (cr.chiffreAffaires || 0) - (cr.achatsChargesExternes || 0);
    if (cr.valeurAjoutee === 0 && vaCalculee !== 0) {
      data.compteResultat.valeurAjoutee = vaCalculee;
      cr.valeurAjoutee = vaCalculee;
    }

    // Recalculer EBE si aberrant (écart > 15%)
    const ebeCalcule = (cr.valeurAjoutee || 0) - (cr.chargesPersonnel || 0);
    const ebeExtrait = cr.ebe || 0;
    if (Math.abs(ebeCalcule) > 500 && Math.abs(ebeExtrait) > 0) {
      const ecartEbe = Math.abs(ebeCalcule - ebeExtrait) / (Math.abs(ebeCalcule) || 1);
      if (ecartEbe > 0.15) {
        data._avertissement = 'EBE incohérent: VA(' + cr.valeurAjoutee + ') - Personnel(' + cr.chargesPersonnel + ') = ' + ebeCalcule + ' ≠ EBE extrait(' + ebeExtrait + '). Vérifiez le document.';
      }
    }

    // Recalculer les ratios clés depuis les données SIG
    const ca = cr.chiffreAffaires || 0;
    if (ca > 0) {
      const ratios = data.ratios || {};
      ratios.tauxMargeBrute = Math.round((cr.valeurAjoutee || 0) / ca * 10000) / 100;
      ratios.tauxEBE = Math.round((cr.ebe || 0) / ca * 10000) / 100;
      ratios.tauxResultatNet = Math.round((cr.resultatNet || 0) / ca * 10000) / 100;
      data.ratios = ratios;
    }

    // Cohérence actif = passif si les deux sont renseignés
    const actif = data.actif || {};
    const passif = data.passif || {};
    const totalA = actif.totalActif || 0;
    const totalP = passif.totalPassif || 0;
    if (totalA > 0 && totalP > 0 && Math.abs(totalA - totalP) / Math.max(totalA, totalP) > 0.01) {
      data._avertissement = (data._avertissement || '') + ' Écart actif/passif détecté (non bloquant, SIG fiable).';
    }

    // tauxAmortissement
    const brut = actif.totalActifImmobiliseBrut || 0;
    const amort = actif.totalActifImmobiliseAmort || 0;
    if (brut > 0 && (!actif.tauxAmortissement || actif.tauxAmortissement === 0)) {
      data.actif.tauxAmortissement = Math.round((amort / brut) * 10000) / 100;
    }

    return res.status(200).json({ success: true, data });

  } catch (err) {
    console.error('Erreur analyze-bilan:', err);
    const isRateLimit = err.status === 429 || err.name === 'RateLimitError';
    return res.status(500).json({
      error: isRateLimit
        ? 'Limite de requêtes atteinte. Veuillez patienter 2 minutes avant de réessayer.'
        : err.message || 'Erreur lors de l\'analyse du bilan',
      detail: err.message
    });
  }
};
