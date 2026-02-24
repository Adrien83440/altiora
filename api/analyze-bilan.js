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

    // Lire le retry-after depuis les headers de l'erreur 429
    async function callWithRetry(params, maxRetries = 3) {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          return await client.messages.create(params);
        } catch (err) {
          if ((err.status === 429 || err.name === 'RateLimitError') && attempt < maxRetries - 1) {
            // Respecter le retry-after Anthropic (en secondes) + 2s marge
            const retryAfter = parseInt(err.headers && err.headers['retry-after']) || 0;
            const delay = retryAfter > 0 ? (retryAfter * 1000 + 2000) : Math.pow(2, attempt) * 5000;
            console.log('Rate limit, retry in ' + delay + 'ms (retry-after: ' + retryAfter + 's)');
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
      // Mode texte : tronquer à 40 000 chars max (~10 000 tokens) pour rester sous les limites
      const truncated = pdfText.length > 40000 ? pdfText.slice(0, 40000) + '\n[tronqué]' : pdfText;
      content.push({ type: 'text', text: 'Bilan comptable PDF (texte extrait):\n\n' + truncated });
    } else {
      // Mode images : max 20 pages
      const pagesToSend = pages.slice(0, 20);
      for (let i = 0; i < pagesToSend.length; i++) {
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: pagesToSend[i] } });
      }
    }

    // Prompt compact — ~400 tokens au lieu de ~2000
    content.push({
      type: 'text',
      text: `Expert-comptable français. Extrais les chiffres EXACTS de ce bilan PCG.

RÈGLES DE LECTURE :
- Bilan ACTIF : 4 colonnes [Brut][Amort][Net N][Net N-1] → prendre Net N = 3ème colonne
- Actif circulant : 2 colonnes [Net N][Net N-1] → prendre la 1ère
- Bilan PASSIF : 2 colonnes [N][N-1] → prendre la 1ère
- Compte de résultat format France/Export/Total → prendre colonne "Total"
- Ignorer colonnes % intercalées (nombres < 100 avec virgule)
- Valeurs négatives normales (capitaux propres, résultat, report)
- Année = année de clôture (ex: clôture 30/06/2024 → annee = "2024")

VÉRIFICATION : totalActif doit = totalPassif (±1%). Si non → relire les colonnes.

Réponds UNIQUEMENT en JSON brut (sans markdown) :
{"annee":"2024","dateCloture":"31/12/2024","entreprise":"Nom","formeJuridique":"SARL",
"actif":{"immobilisationsIncorporellesBrut":0,"immobilisationsIncorporellesAmort":0,"immobilisationsIncorporelles":0,"immobilisationsCorporellesBrut":0,"immobilisationsCorporellesAmort":0,"immobilisationsCorporelles":0,"immobilisationsFinancieresBrut":0,"immobilisationsFinancieresAmort":0,"immobilisationsFinancieres":0,"totalActifImmobiliseBrut":0,"totalActifImmobiliseAmort":0,"totalActifImmobilise":0,"tauxAmortissement":0,"stocks":0,"creancesClients":0,"autresCreances":0,"tresorerieActive":0,"chargesConstateesDavance":0,"totalActifCirculant":0,"totalActif":0},
"passif":{"capitalSocial":0,"reserves":0,"reportANouveau":0,"resultatExercice":0,"totalCapitauxPropres":0,"provisions":0,"dettesFinancieres":0,"dettesFournisseurs":0,"dettesFiscalesSociales":0,"autresDettes":0,"produitsConstatesAvance":0,"totalDettes":0,"totalPassif":0},
"compteResultat":{"chiffreAffaires":0,"achatsChargesExternes":0,"valeurAjoutee":0,"chargesPersonnel":0,"ebe":0,"dotationsAmortissements":0,"resultatExploitation":0,"resultatFinancier":0,"resultatExceptionnel":0,"impotSocietes":0,"resultatNet":0},
"ratios":{"tauxMargeBrute":0,"tauxEBE":0,"tauxResultatNet":0,"ratioEndettement":0,"capaciteAutofinancement":0,"tresorerieNette":0,"bfrJours":0,"ratioLiquiditeGenerale":0,"rentabiliteCapitauxPropres":0},
"secteur":{"codeNAF":"","libelle":"","benchmark":{"tauxMargeBrute":{"moyenne":0,"position":""},"tauxEBE":{"moyenne":0,"position":""},"tauxResultatNet":{"moyenne":0,"position":""},"ratioEndettement":{"moyenne":0,"position":""},"bfrJours":{"moyenne":0,"position":""},"ratioLiquiditeGenerale":{"moyenne":0,"position":""}},"commentaire":""},
"conseils":[{"type":"force","titre":"","detail":""}],
"resumeIA":""}

Montants = entiers. Ratios = décimal (ex: 14.65). 4-6 conseils variés.${contextYears}`
    });

    const response = await callWithRetry({
      model: hasText ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      messages: [{ role: 'user', content: content }]
    });

    let text = response.content[0].text.trim();

    // Extraire le JSON robustement : trouver le premier { et le dernier }
    // Gère les cas où Claude ajoute du texte avant/après le JSON
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
      throw new Error('Aucun JSON trouvé dans la réponse du modèle');
    }
    text = text.slice(jsonStart, jsonEnd + 1);

    // Nettoyer les éventuels caractères de contrôle qui cassent JSON.parse
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

    let data;
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      // Claude a répondu du texte au lieu de JSON (ex: "document illisible", "OCR de mauvaise qualité")
      // On le renvoie comme erreur lisible pour l'utilisateur
      const shortText = text.slice(0, 300).replace(/"/g, '\'');
      throw new Error('Le document PDF semble être un scan de mauvaise qualité. Essayez un PDF natif issu directement du logiciel comptable. Détail: ' + shortText);
    }
    data._mode = hasText ? 'text' : 'image';

    // Vérifications de cohérence
    const actif = data.actif || {};
    const passif = data.passif || {};
    const totalA = actif.totalActif || 0;
    const totalP = passif.totalPassif || 0;

    if (totalA > 0 && totalP > 0 && Math.abs(totalA - totalP) / Math.max(totalA, totalP) > 0.01) {
      data._avertissement = 'Écart actif (' + totalA + '€) ≠ passif (' + totalP + '€).';
    }

    const brut = actif.totalActifImmobiliseBrut || 0;
    const amort = actif.totalActifImmobiliseAmort || 0;
    const net = actif.totalActifImmobilise || 0;
    if (brut > 0 && net > 0 && Math.abs((brut - amort) - net) / net > 0.03) {
      data._avertissement = (data._avertissement || '') + ' Incohérence Brut−Amort−Net.';
    }
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
        : 'Erreur lors de l\'analyse du bilan',
      detail: err.message
    });
  }
};
