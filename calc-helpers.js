/* ═══════════════════════════════════════════════════════════════════════════
 * calc-helpers.js — Bibliothèque de calculs partagée Alteore
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * OBJECTIF : une source de vérité unique pour les calculs qui étaient dupliqués
 * entre pilotage.html, rapport-annuel.html, dashboard.html, cashflow.html,
 * suivi-ca.html et scenarios.html.
 *
 * Garantit qu'une même donnée affiche les mêmes chiffres sur toutes les pages.
 *
 * EXPOSITION : window.CalcHelpers (compatible scripts classiques, pas de module)
 *
 * INCLUT :
 *   • parseCredits()        → gère format actuel (ligne unique) + legacy (paire)
 *                             calcule correctement les intérêts dans les 2 cas
 *   • calcMasseSalariale()  → gère mode auto-paie, auto, manuel + primes objectifs
 *   • EXPLANATIONS          → libellés et descriptions pour les tooltips clients
 *
 * Wave 1 — AUCUN changement sur les formules résultat/cashflow.
 * Les corrections formules viennent en Wave 2 et 3.
 * ═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  var H = {};

  /* ───────────────────────────────────────────────────────────────────────
   * UTILITAIRES
   * ─────────────────────────────────────────────────────────────────────── */

  // Parse "1 234,56" ou "1234.56" ou undefined → 0
  H.pf = function (v) {
    if (v === null || v === undefined || v === '') return 0;
    var n = parseFloat(String(v).replace(',', '.'));
    return isNaN(n) ? 0 : n;
  };

  // Extrait "YYYY-MM" d'une date type "2026-03" ou "2026-03-15" → "2026-03"
  H.parseYYYYMM = function (s) {
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})/.exec(String(s));
    return m ? m[1] + '-' + m[2] : null;
  };

  /* ───────────────────────────────────────────────────────────────────────
   * INTÉRÊTS D'EMPRUNT — computeMonthlyInterest(r, monthKey)
   * ───────────────────────────────────────────────────────────────────────
   * Calcule l'intérêt mensuel RÉEL d'un crédit, en fonction :
   *   • du type d'amortissement (r.amort : 'lineaire', 'constant', 'infine', 'fixe')
   *   • du mois courant relatif au début du prêt (capital restant dû)
   *   • du taux annuel
   *
   * ═══ PROBLÈME HISTORIQUE CORRIGÉ (bug #15 de l'audit) ═══
   * L'ancienne formule `r.montant × taux / 100 / 12` était mathématiquement
   * fausse : `r.montant` est la part capital MENSUELLE (= capital/duree pour un
   * amortissement linéaire), pas le capital restant dû. Pour un prêt 100k€ à
   * 3% sur 5 ans, l'ancienne formule donnait 4,17 €/mois d'intérêt au lieu
   * d'une moyenne réelle d'environ 127 €/mois. Sous-estimation ~30×.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Données stockées sur un crédit pilotage :
   *   { montant: "1666.67",    // part capital mensuelle (capital/duree)
   *     tauxInteret: "3",      // taux annuel en %
   *     amort: "lineaire" | "constant" | "infine" | "fixe",
   *     dateDebut: "YYYY-MM",  // optionnel
   *     dateFin:   "YYYY-MM" } // optionnel
   *
   * ─── AVEC DATES (calcul exact) ───
   * On reconstitue capitalTotal = montant × duree, puis on calcule l'intérêt
   * du mois k (0-indexé) selon l'amort type :
   *   • lineaire : I_k = C × (1 - k/n) × r
   *   • constant (mensualités constantes) : I_k = solde_k × r
   *     où solde_k = C × ((1+r)^n - (1+r)^k) / ((1+r)^n - 1)
   *   • infine : I_k = C × r (constant, capital repayé au dernier mois)
   *   • fixe : I_k = C × r (constant, intérêts sur capital initial)
   *
   * ─── SANS DATES (fallback conservateur) ───
   * Impossible de connaître duree et capital restant dû. On retombe sur
   * l'ancienne formule pour ne pas casser l'historique des clients qui n'ont
   * pas renseigné les dates de leurs crédits. Ces clients verront le même
   * chiffre qu'avant la Wave 1.5 et pourront corriger en ajoutant les dates.
   * ─────────────────────────────────────────────────────────────────────── */
  H.computeMonthlyInterest = function (r, monthKey) {
    var p = H.pf(r.montant);          // part capital mensuelle
    var taux = H.pf(r.tauxInteret);   // taux annuel %
    if (p <= 0 || taux <= 0) return 0;

    var rateM = taux / 100 / 12;      // taux mensuel décimal

    // Sans dates : fallback sur l'ancienne formule (sous-estimée mais
    // compatible avec l'historique). Le client doit renseigner les dates
    // pour bénéficier du calcul exact.
    if (!r.dateDebut || !r.dateFin || !monthKey) {
      return p * rateM;
    }

    var deb = H.parseYYYYMM(r.dateDebut);
    var fin = H.parseYYYYMM(r.dateFin);
    var now = H.parseYYYYMM(monthKey);
    if (!deb || !fin || !now) return p * rateM;

    // Calcul de la durée en mois (inclusive)
    var debY = parseInt(deb.slice(0, 4), 10);
    var debM = parseInt(deb.slice(5, 7), 10);
    var finY = parseInt(fin.slice(0, 4), 10);
    var finM = parseInt(fin.slice(5, 7), 10);
    var duree = (finY - debY) * 12 + (finM - debM) + 1;
    if (duree <= 0) return 0;

    // Mois courant relatif au début (0-indexé)
    var nowY = parseInt(now.slice(0, 4), 10);
    var nowM = parseInt(now.slice(5, 7), 10);
    var k = (nowY - debY) * 12 + (nowM - debM);
    if (k < 0 || k >= duree) return 0;

    // Capital total approximé. Exact pour 'lineaire' (où montant = capital/duree
    // par construction). Pour les autres amortissements, c'est une reconstitution
    // par la même formule linéaire — en pratique les clients saisissent leur
    // "mensualité (principal)" comme capital/duree de toute façon.
    var capitalTotal = p * duree;
    var amort = r.amort || 'constant';

    // ─── In fine : intérêts constants sur capital initial ───
    if (amort === 'infine') {
      return capitalTotal * rateM;
    }

    // ─── Intérêts fixes (prêt américain) : intérêts constants sur capital initial ───
    if (amort === 'fixe') {
      return capitalTotal * rateM;
    }

    // ─── Linéaire : capital constant, intérêts dégressifs ───
    // Au mois k, le solde restant dû AVANT remboursement est :
    //   C × (1 - k/n)     pour k = 0..n-1
    // Intérêt du mois k = solde × rateM
    if (amort === 'lineaire') {
      var soldeL = capitalTotal * (1 - k / duree);
      return soldeL * rateM;
    }

    // ─── Mensualités constantes (par défaut) ───
    // Formule amortissement classique :
    //   Solde au début du mois k = C × ((1+r)^n - (1+r)^k) / ((1+r)^n - 1)
    //   Intérêt du mois k = solde × rateM
    if (rateM === 0) {
      // Pas d'intérêts (cas dégénéré)
      return 0;
    }
    var factor = Math.pow(1 + rateM, duree);
    var soldeK = capitalTotal * (factor - Math.pow(1 + rateM, k)) / (factor - 1);
    return soldeK * rateM;
  };

  /* ───────────────────────────────────────────────────────────────────────
   * CRÉDITS — parseCredits(credits, monthKey)
   * ───────────────────────────────────────────────────────────────────────
   * Prend en charge DEUX formats :
   *
   *   FORMAT ACTUEL (depuis Wave pilotage V2)
   *   Une ligne unique par crédit :
   *     { ligneType:'principal', montant, tauxInteret, tvaAuto, dateDebut, dateFin, amort }
   *   L'intérêt mensuel est calculé via computeMonthlyInterest (calcul exact
   *   si les dates sont présentes, fallback sur l'ancienne formule sinon).
   *
   *   FORMAT LEGACY
   *   Deux lignes jumelées par crédit :
   *     { ligneType:'principal', montant, fournisseur, ... }
   *     { ligneType:'interet',   montant, fournisseur, tvaAuto, tauxInteret }
   *   L'intérêt est lu depuis la ligne 'interet'.
   *
   * Le filtre dateDebut/dateFin est appliqué si `monthKey` est fourni.
   * Retour : { principal, interet, total }
   * ─────────────────────────────────────────────────────────────────────── */
  H.parseCredits = function (credits, monthKey) {
    var result = { principal: 0, interet: 0, total: 0 };
    if (!credits || !credits.length) return result;

    // Détection du format : présence d'au moins une ligne 'interet' = legacy
    var isLegacy = credits.some(function (r) {
      return r && r.ligneType === 'interet';
    });

    for (var i = 0; i < credits.length; i++) {
      var r = credits[i];
      if (!r) continue;

      // Filtre plage de dates
      if (monthKey && r.dateDebut && r.dateFin) {
        var deb = H.parseYYYYMM(r.dateDebut);
        var fin = H.parseYYYYMM(r.dateFin);
        if (deb && fin && (monthKey < deb || monthKey > fin)) continue;
      }

      if (r.ligneType === 'interet') {
        // Ligne d'intérêt legacy
        var mt = H.pf(r.montant);
        if (r.tvaAuto && H.pf(r.tauxInteret) > 0) {
          // Recalculer depuis le principal associé (même fournisseur, en amont)
          // Note : ici on conserve l'ancienne formule car le format legacy n'a
          // ni amort ni dates fiables, et les données sont marginales.
          for (var j = i - 1; j >= 0; j--) {
            var c = credits[j];
            if (c && c.ligneType === 'principal' && c.fournisseur === r.fournisseur) {
              mt = H.pf(c.montant) * H.pf(r.tauxInteret) / 100 / 12;
              break;
            }
          }
        }
        result.interet += mt;
        continue;
      }

      // Ligne principal (ou ligne sans ligneType, considérée comme principal)
      var p = H.pf(r.montant);
      result.principal += p;

      // Format actuel : calcul exact de l'intérêt via computeMonthlyInterest
      // En format legacy, l'intérêt est porté par la ligne 'interet' séparée.
      if (!isLegacy) {
        result.interet += H.computeMonthlyInterest(r, monthKey);
      }
    }

    result.total = result.principal + result.interet;
    return result;
  };

  /* ───────────────────────────────────────────────────────────────────────
   * AVANCEMENT OBJECTIF (utilisé pour les primes)
   * Retourne un pourcentage [0, 150].
   * ─────────────────────────────────────────────────────────────────────── */
  H._calcObjAvancement = function (obj) {
    var criteres = (obj && obj.criteres) || [];
    if (!criteres.length) return 0;
    var totalPoids = 0, totalAvance = 0;
    for (var i = 0; i < criteres.length; i++) {
      var c = criteres[i];
      var poids = H.pf(c.poids);
      var cible = H.pf(c.cible);
      var avancement = H.pf(c.avancement);
      totalPoids += poids;
      if (cible > 0) {
        totalAvance += Math.min(avancement / cible * 100, 150) * poids;
      }
    }
    return totalPoids > 0 ? totalAvance / totalPoids : 0;
  };

  /* ───────────────────────────────────────────────────────────────────────
   * MASSE SALARIALE — calcMasseSalariale(d)
   * ───────────────────────────────────────────────────────────────────────
   * d = le document mensuel pilotage complet (contient d.masseSalariale)
   *
   * Trois modes supportés :
   *   • 'auto-paie'  → lit les super-bruts validés depuis rh-paie
   *                    (nécessite window.getEmployeMSLineAutoPaie — présent
   *                    sur pilotage.html uniquement pour le mois courant.
   *                    Fallback propre sinon : utilise le salaireBrut statique
   *                    de chaque employé × taux de charges).
   *   • 'auto'       → somme (salaireBrut × (1 + tauxCharges/100)) pour chaque
   *                    employé présent dans window._rhEmployes
   *   • manuel       → somme des lignes libres saisies dans ms.lignes
   *
   * Inclut en plus :
   *   • Les primes d'objectifs atteints (window._rhObjectifs)
   *   • Le coût du dirigeant (rémunération + dividendes majorés de leurs taux),
   *     ou son prélèvement privé s'il est en mode 'prelevement'.
   *
   * Retour :
   *   { salaries, dirigeant, primes, prelevementPriveHT, total }
   * ─────────────────────────────────────────────────────────────────────── */
  H.calcMasseSalariale = function (d) {
    var result = {
      salaries: 0,
      dirigeant: 0,
      primes: 0,
      prelevementPriveHT: 0,
      total: 0
    };

    var ms = d && d.masseSalariale;
    if (!ms) return result;

    var emps = (global && global._rhEmployes) || [];
    var objs = (global && global._rhObjectifs) || [];

    // ─── SALARIÉS ──────────────────────────────────────────────
    var mode = ms.mode || 'manuel';

    if (mode === 'auto-paie' && emps.length > 0 && typeof global.getEmployeMSLineAutoPaie === 'function') {
      // Source de vérité : rh-paie (mois courant, pilotage uniquement)
      for (var i = 0; i < emps.length; i++) {
        var line = global.getEmployeMSLineAutoPaie(emps[i]);
        result.salaries += (line && line.cout) || 0;
      }
    } else if ((mode === 'auto' || mode === 'auto-paie') && emps.length > 0) {
      // Mode auto OU fallback auto-paie hors pilotage : fiche statique de l'employé
      for (var k = 0; k < emps.length; k++) {
        var e = emps[k];
        var brut = H.pf(e.salaireBrut);
        var tauxE;
        if (typeof global.getMSTaux === 'function') {
          tauxE = global.getMSTaux(e);
        } else {
          // Fallback : tauxCharges de l'employé, sinon 42%
          tauxE = H.pf(e.tauxCharges);
          if (tauxE <= 0) tauxE = 42;
        }
        result.salaries += brut * (1 + tauxE / 100);
      }
    } else {
      // Mode manuel : lignes libres
      var lignes = (ms.lignes || []);
      for (var m = 0; m < lignes.length; m++) {
        var l = lignes[m];
        var brutM = H.pf(l.brut);
        var tauxM = H.pf(l.tauxCharges);
        if (tauxM <= 0) tauxM = 42;
        result.salaries += brutM * (1 + tauxM / 100);
      }
    }

    // ─── PRIMES D'OBJECTIFS ────────────────────────────────────
    if (objs.length > 0) {
      for (var oi = 0; oi < objs.length; oi++) {
        var obj = objs[oi];
        if (!obj || obj.statut === 'annule' || obj.statut === 'brouillon') continue;
        var prime = obj.prime || {};
        var montant = H.pf(prime.montantBrut);
        if (montant <= 0) continue;
        var tauxP = H.pf(prime.tauxCharges);
        if (tauxP <= 0) tauxP = 45;

        var av = H._calcObjAvancement(obj);
        var modeP = prime.modePalier || 'tout_ou_rien';
        var brutP = 0;

        if (modeP === 'tout_ou_rien') {
          brutP = av >= 100 ? montant : 0;
        } else if (modeP === 'proportionnel') {
          brutP = montant * Math.min(av, 100) / 100;
        } else if (modeP === 'paliers') {
          var paliers = (prime.paliers || []).slice().sort(function (a, b) {
            return H.pf(b.seuil) - H.pf(a.seuil);
          });
          for (var pi = 0; pi < paliers.length; pi++) {
            if (av >= H.pf(paliers[pi].seuil)) {
              brutP = montant * H.pf(paliers[pi].primePct) / 100;
              break;
            }
          }
        }

        if (brutP > 0) {
          // Pour un objectif d'équipe : multiplier par le nombre de membres
          var vol = (obj.type === 'equipe' && obj.employeIds && obj.employeIds.length)
            ? obj.employeIds.length
            : 1;
          result.primes += brutP * (1 + tauxP / 100) * vol;
        }
      }
    }

    // ─── DIRIGEANT ─────────────────────────────────────────────
    var dir = ms.dirigeant || {};
    var remDir = H.pf(dir.remuneration);

    // Utiliser le taux saisi si présent (même si 0), sinon 45
    var tauxDirRaw = parseFloat(dir.tauxCharges);
    var tauxDir = isNaN(tauxDirRaw) ? 45 : tauxDirRaw;

    var divid = H.pf(dir.dividendes);
    var tauxDivRaw = parseFloat(dir.tauxDividendes);
    var tauxDiv = isNaN(tauxDivRaw) ? 30 : tauxDivRaw;

    var coutDirRem = remDir * (1 + tauxDir / 100);
    var coutDirDiv = divid * (1 + tauxDiv / 100);

    if (dir.type === 'prelevement') {
      result.prelevementPriveHT = coutDirRem + coutDirDiv;
    } else {
      result.dirigeant = coutDirRem + coutDirDiv;
    }

    result.total = result.salaries + result.dirigeant + result.primes;
    return result;
  };

  /* ───────────────────────────────────────────────────────────────────────
   * EXPLANATIONS — libellés clients
   * ───────────────────────────────────────────────────────────────────────
   * Utilisées pour afficher des tooltips pédagogiques sur les KPI.
   * Chaque entrée contient :
   *   • title : titre court (pour le tooltip)
   *   • short : phrase de résumé (1 ligne)
   *   • long  : explication détaillée (2-4 phrases)
   *
   * Récupération : CalcHelpers.getExplanation('cle')
   * ─────────────────────────────────────────────────────────────────────── */
  H.EXPLANATIONS = {

    resultat_economique: {
      title: 'Résultat économique',
      short: 'Ce que vous gagnez réellement en exploitant votre activité.',
      long: 'Ce résultat suit la logique comptable : seuls les intérêts d\'emprunt sont considérés comme une charge. Le remboursement du capital n\'en est pas une — il ne fait que réduire votre dette, ce n\'est pas de l\'argent "consommé". C\'est le chiffre que votre expert-comptable regardera et celui qui apparaît dans votre liasse fiscale.'
    },

    resultat_tresorerie: {
      title: 'Résultat en trésorerie',
      short: 'Ce qu\'il vous reste vraiment en poche après toutes vos échéances.',
      long: 'Ce résultat inclut le remboursement du capital d\'emprunt comme une sortie. Il est toujours plus bas que le résultat économique si vous avez des crédits en cours. C\'est le chiffre qui reflète le mieux votre trésorerie disponible mois après mois — utile pour piloter vos arbitrages au quotidien.'
    },

    cashflow: {
      title: 'Cashflow',
      short: 'Le mouvement net de votre trésorerie sur le mois.',
      long: 'Cashflow = tout ce qui entre sur votre compte (CA TTC + rentrées diverses) − tout ce qui en sort (fournisseurs TTC + salaires + échéances de crédit). C\'est le meilleur indicateur de la santé réelle de votre trésorerie : si votre cashflow est positif, votre solde bancaire progresse sur le mois.'
    },

    masse_salariale: {
      title: 'Masse salariale',
      short: 'Coût total employeur de votre équipe (dirigeant compris).',
      long: 'Inclut les salaires bruts majorés des charges patronales, le coût du dirigeant (sauf s\'il est en mode "prélèvement privé"), et les primes liées aux objectifs atteints. En mode auto-paie, les montants proviennent directement des calculs URSSAF du module Paie — vous avez donc la même source de vérité partout dans Alteore.'
    },

    credit_principal: {
      title: 'Capital remboursé',
      short: 'La part de votre mensualité qui rembourse votre prêt.',
      long: 'Cette part ne figure pas dans votre résultat comptable — ce n\'est pas une charge au sens fiscal, juste une diminution de votre dette. Mais elle sort bien de votre trésorerie chaque mois, c\'est pour cela qu\'elle apparaît dans le cashflow et dans le résultat en trésorerie.'
    },

    credit_interet: {
      title: 'Intérêts d\'emprunt',
      short: 'Le coût réel de l\'argent emprunté, basé sur le capital restant dû.',
      long: 'Les intérêts sont une charge financière déductible fiscalement. Ils figurent à la fois dans votre résultat économique et dans votre cashflow. Alteore les calcule en fonction du type d\'amortissement de votre prêt (linéaire, mensualités constantes, in fine, intérêts fixes) et du capital restant dû au mois affiché — ils diminuent donc naturellement à mesure que vous remboursez votre prêt. Pour un calcul exact, renseignez bien les dates de début et de fin de chaque crédit.'
    },

    tva_collectee: {
      title: 'TVA collectée',
      short: 'La TVA que vous avez facturée à vos clients.',
      long: 'Cette TVA ne vous appartient pas : vous la collectez pour l\'État et vous devrez la reverser. Elle est calculée par taux (5,5% / 10% / 20%) et arrondie ligne par ligne pour éviter les écarts avec votre déclaration CA3.'
    },

    tva_deductible: {
      title: 'TVA déductible',
      short: 'La TVA que vous avez payée sur vos achats et que vous pouvez récupérer.',
      long: 'Seules les charges marquées comme "TVA déductible" sont prises en compte. Certaines dépenses (carburant, restauration, cadeaux...) ont une déductibilité limitée — pensez à bien les marquer comme non-déductibles le cas échéant, sinon votre TVA à reverser sera sous-estimée.'
    },

    tva_due: {
      title: 'TVA à reverser',
      short: 'TVA collectée − TVA déductible.',
      long: 'Si positif, vous devez cette somme à l\'État lors de votre prochaine déclaration. Si négatif, vous êtes en crédit de TVA et pouvez demander un remboursement. Cette estimation n\'inclut pas d\'éventuels reports ou régularisations.'
    },

    chargesHT: {
      title: 'Total des charges HT',
      short: 'La somme de toutes vos charges du mois, hors TVA.',
      long: 'Regroupe les charges fixes (loyer, assurances, abonnements...), les charges variables (achats, fournitures...), le leasing, les échéances de crédit et la masse salariale. Les montants sont en HT — la TVA déductible associée est calculée séparément.'
    },

    caHT: {
      title: 'Chiffre d\'affaires HT',
      short: 'Votre chiffre d\'affaires hors taxes du mois.',
      long: 'Somme du CA journalier (tableau des ventes quotidiennes) et des factures professionnelles. Tous les taux de TVA (5,5% / 10% / 20% et taux personnalisé) sont gérés séparément puis additionnés.'
    },

    caTTC: {
      title: 'Chiffre d\'affaires TTC',
      short: 'Votre chiffre d\'affaires toutes taxes comprises.',
      long: 'C\'est le montant que vos clients ont effectivement payé. Il sert de base au calcul du cashflow (ce qui entre réellement sur votre compte bancaire).'
    },

    ebe: {
      title: 'Excédent Brut d\'Exploitation (EBE)',
      short: 'La richesse créée par votre activité, avant frais financiers.',
      long: 'EBE = CA + autres produits − charges d\'exploitation (hors intérêts, hors amortissements). C\'est un indicateur de rentabilité "pure" qui ne dépend pas de la structure de financement. Si votre EBE est négatif, le modèle économique lui-même pose problème.'
    },

    seuil_rentabilite: {
      title: 'Seuil de rentabilité',
      short: 'Le CA minimum à réaliser pour ne pas perdre d\'argent.',
      long: 'Au-dessus de ce seuil, chaque euro de CA supplémentaire contribue directement au bénéfice. En-dessous, votre activité est déficitaire. Il est calculé à partir de vos charges fixes et de votre taux de marge sur coûts variables.'
    }
  };

  // Récupérer une explication par clé (retourne null si inconnue)
  H.getExplanation = function (key) {
    return H.EXPLANATIONS[key] || null;
  };

  // Version courte (utilisée dans les tooltips compacts)
  H.getExplanationShort = function (key) {
    var e = H.EXPLANATIONS[key];
    return e ? e.short : '';
  };

  /* ───────────────────────────────────────────────────────────────────────
   * META
   * ─────────────────────────────────────────────────────────────────────── */
  H.version = '1.0.0'; // Wave 1
  H.wave = 1;

  // Expose
  global.CalcHelpers = H;

})(typeof window !== 'undefined' ? window : this);
