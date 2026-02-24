const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    // Support mode texte (pdfText) OU mode images (pages) selon ce qu'envoie le client
    const { pages, pdfText, mode, fileName, existingYears } = req.body;

    const hasText = mode === 'text' && pdfText && pdfText.trim().length > 200;
    const hasImages = pages && Array.isArray(pages) && pages.length > 0;

    if (!hasText && !hasImages) {
      return res.status(400).json({ error: 'Aucune donnée PDF reçue' });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Retry avec backoff exponentiel sur RateLimitError (429)
    async function callWithRetry(params, maxRetries = 3) {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          return await client.messages.create(params);
        } catch (err) {
          if ((err.status === 429 || err.name === 'RateLimitError') && attempt < maxRetries - 1) {
            const delay = Math.pow(2, attempt) * 3000; // 3s -> 6s -> 12s
            console.log('Rate limit hit, retry ' + (attempt + 1) + '/' + (maxRetries - 1) + ' in ' + delay + 'ms');
            await new Promise(function(r) { setTimeout(r, delay); });
            continue;
          }
          throw err;
        }
      }
    }

    let contextYears = '';
    if (existingYears && Object.keys(existingYears).length > 0) {
      contextYears = '\n\nDonnées des bilans précédents déjà enregistrés pour comparaison :\n' +
        JSON.stringify(existingYears, null, 2) + '\nCompare avec ces données et indique les évolutions.';
    }

    // Construire le contenu selon le mode
    const content = [];

    if (hasText) {
      // MODE TEXTE — ultra léger (~300 tokens/page vs ~1600 en image)
      // Tronquer à 80 000 caractères max
      const truncated = pdfText.length > 80000
        ? pdfText.slice(0, 80000) + '\n[... document tronqué ...]'
        : pdfText;
      content.push({
        type: 'text',
        text: 'Voici le contenu textuel extrait d\'un bilan comptable PDF :\n\n' + truncated
      });
    } else {
      // MODE IMAGES — fallback pour les PDFs scannés (pas de texte extractible)
      const pagesToSend = pages.slice(0, 20); // max 20 pages
      for (let i = 0; i < pagesToSend.length; i++) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: pagesToSend[i] }
        });
      }
    }

    // Prompt principal
    content.push({
      type: 'text',
      text: `Tu es un expert-comptable français. Analyse ce document comptable et extrait les chiffres EXACTS.

REMARQUE IMPORTANTE SUR LE FORMAT D'ENTRÉE :
${hasText
  ? 'Ce document est fourni en mode TEXTE extrait du PDF. Les tableaux sont représentés en texte brut avec des espaces/tabulations comme séparateurs de colonnes. Lis attentivement la structure des colonnes en te basant sur l\'alignement et les en-têtes.'
  : 'Ce document est fourni en mode IMAGES. Lis les tableaux visuellement.'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ÉTAPE 1 — IDENTIFIE LA DATE DE CLÔTURE ET L'EXERCICE N
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Lis la page de garde ou l'en-tête du document.
La période indiquée (ex: "Du 01/01/2023 au 31/12/2023" ou "Du 01/07/2023 au 30/06/2024") te donne :
- La DATE DE CLÔTURE : la dernière date mentionnée
- L'EXERCICE N : c'est cet exercice dont tu dois extraire les chiffres
- L'EXERCICE N-1 : toutes les autres colonnes de chiffres → IGNORE

L'exercice peut avoir une durée atypique (18 mois pour une création d'entreprise, clôture au 30/06, etc.).
Extrais les chiffres tels quels SANS les annualiser.

L'année dans le champ "annee" = année de la date de clôture (ex: 2024 si clôture au 30/06/2024).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ÉTAPE 2 — BILAN ACTIF : LECTURE DES COLONNES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Le bilan actif PCG a TOUJOURS les colonnes dans cet ordre de gauche à droite :
  [BRUT (N)] [AMORT./DÉPRÉC. (N)] [NET (N)] [NET (N-1)]

RÈGLE ABSOLUE — Tu veux NET(N) = la 3ème colonne de montants = avant-dernière valeur numérique.

Exemples tirés de vrais bilans :

  TOTAL ACTIF IMMOBILISÉ  | 357 510 | 52 325 | 305 185 | 328 941
  → totalActifImmobilise = 305 185 ✓  (pas 357 510, pas 52 325, pas 328 941)

  TOTAL GÉNÉRAL           | 412 428 | 52 325 | 360 102 | 370 161
  → totalActif = 360 102 ✓

  Fonds commercial        |  80 000 |   vide |  80 000 |  80 000
  → La colonne Amort peut être VIDE (fonds de commerce non amortissable) : Net = Brut, Amort = 0 ✓

PIÈGE — COLONNES % INTERCALÉES :
Certains cabinets insèrent des colonnes "% de l'actif" entre les colonnes de montants.
Ces colonnes contiennent de petits nombres avec virgule (ex: 84,75 ou 5,96 ou 88,86).
IGNORE-LES COMPLÈTEMENT — ne les compte pas comme des colonnes de montants.

  Exemple avec colonnes % intercalées :
  TOTAL ACTIF IMMOBILISÉ | 357 510 | 52 325 | 305 185 | 84,75 | 328 941 | 88,86
  → Ignore 84,75 et 88,86 → totalActifImmobilise = 305 185 ✓ (toujours la 3ème colonne de montants réels)

ACTIF CIRCULANT — pas de colonnes Brut/Amort :
Les stocks, créances et disponibilités ne s'amortissent pas.
Le tableau a seulement 2 colonnes : [NET(N)] [NET(N-1)] → prends toujours la 1ère.

  Disponibilités   | 74 669 | 52 182  →  tresorerieActive += 74 669 ✓
  Stocks marchand. |  5 900 |  5 890  →  stocks += 5 900 ✓

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ÉTAPE 3 — BILAN PASSIF : LECTURE DES COLONNES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Le bilan passif a TOUJOURS 2 colonnes de montants nets :
  [exercice N] [exercice N-1]

RÈGLE ABSOLUE : prends TOUJOURS la 1ère valeur numérique (exercice N).

  TOTAL CAPITAUX PROPRES | -130 761 | -78 736  →  totalCapitauxPropres = -130 761 ✓
  TOTAL DETTES           |  490 864 | 448 897  →  totalDettes = 490 864 ✓
  TOTAL GÉNÉRAL          |  360 102 | 370 161  →  totalPassif = 360 102 ✓

Valeurs négatives au passif — NORMALES, ne pas les corriger :
- totalCapitauxPropres négatif → pertes accumulées > capitaux (situation nette dégradée)
- resultatExercice négatif → perte de l'exercice en cours
- reportANouveau négatif → reports de pertes des exercices précédents

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ÉTAPE 4 — COMPTE DE RÉSULTAT ET SIG : LECTURE DES COLONNES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Plusieurs formats coexistent. Lis les EN-TÊTES pour identifier l'exercice N, puis :

FORMAT A — Standard à 2 colonnes + variation :
  [N] [N-1] [Variation €] [Variation %]
  → prends la 1ère colonne

FORMAT B — France / Exportation / Total :
  [France] [Exportation] [Total N] [Total N-1]
  → prends la colonne "Total" = 3ème valeur numérique
  → "Exportation" est souvent vide pour les commerces locaux, ce n'est pas une erreur

FORMAT C — Colonnes N% intercalées :
  [N montant] [N %CA] [N-1 montant] [N-1 %CA]
  → prends la 1ère colonne, ignore les %

FORMAT D — SIG avec symboles opératoires :
  Une colonne "+/-/+" à gauche des libellés indique les opérations comptables.
  Ces symboles ne sont PAS des signes pour les montants — ignore-les pour lire les chiffres.
  Les montants négatifs (ex: EBE = -23 985) sont réels et doivent être conservés tels quels.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ÉTAPE 5 — EXTRACTION BRUT / AMORT POUR L'ACTIF IMMOBILISÉ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

En plus du Net, extrais Brut et Amortissements pour les immobilisations (1ère et 2ème colonnes).

  Install. tech., matériel | 91 938 | 26 797 | 65 141 | 52 949
  → immoCorporellesBrut = 91 938, immoCorporellesAmort = 26 797, immoCorporelles = 65 141 ✓

  Fonds commercial         | 80 000 | (vide) | 80 000 | 80 000
  → immosIncorporellesBrut = 80 000, Amort = 0, Net = 80 000 ✓

tauxAmortissement = (totalActifImmobiliseAmort / totalActifImmobiliseBrut) * 100

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ÉTAPE 6 — VÉRIFICATIONS OBLIGATOIRES AVANT DE RÉPONDRE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CHECK 1 — Actif = Passif (tolérance < 1%)
  totalActif doit être égal à totalPassif.
  Si écart > 1% → tu as lu la mauvaise colonne → recommence depuis l'étape 2.

CHECK 2 — Brut − Amort ≈ Net (tolérance < 3%)
  totalActifImmobiliseBrut - totalActifImmobiliseAmort doit ≈ totalActifImmobilise.

CHECK 3 — Résultat cohérent
  resultatExercice (passif) doit correspondre à resultatNet (compte de résultat).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Retourne UNIQUEMENT un JSON valide (pas de markdown, pas de backticks, juste le JSON brut).

{
  "annee": "2024",
  "dateCloture": "30/06/2024",
  "entreprise": "Nom de l'entreprise",
  "formeJuridique": "SARL/SAS/EI/etc",
  "actif": {
    "immobilisationsIncorporellesBrut": 0, "immobilisationsIncorporellesAmort": 0, "immobilisationsIncorporelles": 0,
    "immobilisationsCorporellesBrut": 0, "immobilisationsCorporellesAmort": 0, "immobilisationsCorporelles": 0,
    "immobilisationsFinancieresBrut": 0, "immobilisationsFinancieresAmort": 0, "immobilisationsFinancieres": 0,
    "totalActifImmobiliseBrut": 0, "totalActifImmobiliseAmort": 0, "totalActifImmobilise": 0,
    "tauxAmortissement": 0, "stocks": 0, "creancesClients": 0, "autresCreances": 0,
    "tresorerieActive": 0, "chargesConstateesDavance": 0, "totalActifCirculant": 0, "totalActif": 0
  },
  "passif": {
    "capitalSocial": 0, "reserves": 0, "reportANouveau": 0, "resultatExercice": 0,
    "totalCapitauxPropres": 0, "provisions": 0, "dettesFinancieres": 0, "dettesFournisseurs": 0,
    "dettesFiscalesSociales": 0, "autresDettes": 0, "produitsConstatesAvance": 0,
    "totalDettes": 0, "totalPassif": 0
  },
  "compteResultat": {
    "chiffreAffaires": 0, "achatsChargesExternes": 0, "valeurAjoutee": 0, "chargesPersonnel": 0,
    "ebe": 0, "dotationsAmortissements": 0, "resultatExploitation": 0, "resultatFinancier": 0,
    "resultatExceptionnel": 0, "impotSocietes": 0, "resultatNet": 0
  },
  "ratios": {
    "tauxMargeBrute": 0, "tauxEBE": 0, "tauxResultatNet": 0, "ratioEndettement": 0,
    "capaciteAutofinancement": 0, "tresorerieNette": 0, "bfrJours": 0,
    "ratioLiquiditeGenerale": 0, "rentabiliteCapitauxPropres": 0
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
  "resumeIA": "Résumé global en français accessible pour un commerçant non-comptable."
}

Règles de format JSON :
- Tous les montants sont des nombres entiers (pas de string, pas d'espaces, pas de virgules de milliers)
- Les montants négatifs sont des nombres négatifs (ex: -130761)
- tauxAmortissement et ratios en % décimal (ex: 14.65 pour 14,65%)
- bfrJours en jours entiers
- 4 à 8 conseils variés et actionnables
- SECTEUR : déduis le code NAF depuis l'activité, compare avec moyennes sectorielles BPI/Banque de France${contextYears}`
    });

    const response = await callWithRetry({
      // Haiku pour mode texte (rapide, limites TPM élevées, largement suffisant pour lire des chiffres)
      // Sonnet pour mode images (meilleure vision sur tableaux scannés)
      model: hasText ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: content }]
    });

    let text = response.content[0].text.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    }

    const data = JSON.parse(text);
    data._mode = hasText ? 'text' : 'image';

    // Vérifications de cohérence
    const actif = data.actif || {};
    const passif = data.passif || {};
    const totalA = actif.totalActif || 0;
    const totalP = passif.totalPassif || 0;

    if (totalA > 0 && totalP > 0) {
      const ecart = Math.abs(totalA - totalP) / Math.max(totalA, totalP);
      if (ecart > 0.01) {
        data._avertissement = 'Écart actif (' + totalA + '€) ≠ passif (' + totalP + '€). Possible erreur de lecture de colonne.';
      }
    }

    const brut = actif.totalActifImmobiliseBrut || 0;
    const amort = actif.totalActifImmobiliseAmort || 0;
    const net = actif.totalActifImmobilise || 0;
    if (brut > 0 && net > 0) {
      const ecartImmo = Math.abs((brut - amort) - net) / net;
      if (ecartImmo > 0.03) {
        data._avertissement = (data._avertissement || '') + ' Incohérence Brut−Amort−Net dans l\'actif immobilisé.';
      }
    }

    if (brut > 0 && (!actif.tauxAmortissement || actif.tauxAmortissement === 0)) {
      data.actif.tauxAmortissement = Math.round((amort / brut) * 10000) / 100;
    }

    const sumActif = (actif.totalActifImmobilise || 0) + (actif.totalActifCirculant || 0);
    if (sumActif > 0 && totalA > 0 && Math.abs(sumActif - totalA) / totalA > 0.05) {
      data._avertissement = (data._avertissement || '') + ' Incohérence décomposition actif.';
    }

    const sumPassif = (passif.totalCapitauxPropres || 0) + (passif.totalDettes || 0);
    if (totalP > 0 && Math.abs(Math.abs(sumPassif) - totalP) / totalP > 0.05) {
      data._avertissement = (data._avertissement || '') + ' Incohérence décomposition passif.';
    }

    return res.status(200).json({ success: true, data });

  } catch (err) {
    console.error('Erreur analyze-bilan:', err);
    const isRateLimit = err.status === 429 || err.name === 'RateLimitError';
    return res.status(500).json({
      error: isRateLimit
        ? 'Limite de requêtes atteinte. Veuillez patienter 1 minute avant de réessayer.'
        : 'Erreur lors de l\'analyse du bilan',
      detail: err.message
    });
  }
};
