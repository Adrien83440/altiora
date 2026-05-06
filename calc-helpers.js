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
   * PALIERS ABSOLUS (CA auto-lu) — helpers internes
   * ───────────────────────────────────────────────────────────────────────
   * Les objectifs de type `modePalier === 'paliers_abs'` lient automatiquement
   * la prime au CA HT du mois (ou du trimestre) consulté dans Pilotage.
   *
   * Paliers : [{ seuilCA, primeBrut }] — CUMULATIFS (chaque palier franchi
   * ajoute sa prime).
   *
   * Périodicités supportées :
   *   • mensuel     → CA du mois courant uniquement
   *   • trimestriel → somme CA des 3 mois du trimestre, prime comptée
   *                   UNIQUEMENT sur le 3e mois (mars/juin/sept/déc)
   * ─────────────────────────────────────────────────────────────────────── */
  // Extrait le CA HT d'un document pilotage/months/{key}
  H._caHtFromMonthDoc = function (data) {
    if (!data) return 0;
    var ca = data.ca || [], fp = data.facturesPro || [];
    var s = 0;
    for (var i = 0; i < ca.length; i++) {
      var r = ca[i];
      s += H.pf(r.ht055) + H.pf(r.ht10) + H.pf(r.ht20) + H.pf(r.ht21) + H.pf(r.ht85);
      if (!r.ht055 && !r.ht10 && !r.ht20 && !r.ht21 && !r.ht85) s += H.pf(r.montantHT);
    }
    for (var j = 0; j < fp.length; j++) {
      var f = fp[j];
      s += H.pf(f.ht055) + H.pf(f.ht10) + H.pf(f.ht20) + H.pf(f.ht0) + H.pf(f.ht21) + H.pf(f.ht85);
    }
    return s;
  };
  // Retourne les 3 clés YYYY-MM du trimestre d'une clé donnée
  H._trimestreKeysOf = function (key) {
    var p = (key || '').split('-'); if (p.length < 2) return [];
    var y = parseInt(p[0], 10), mo = parseInt(p[1], 10);
    if (!y || !mo) return [];
    var startM = Math.floor((mo - 1) / 3) * 3 + 1;
    var out = [];
    for (var i = 0; i < 3; i++) {
      var mm = startM + i;
      out.push(y + '-' + (mm < 10 ? '0' : '') + mm);
    }
    return out;
  };
  // La prime doit-elle s'appliquer à ce mois ? (évite de compter 3x une prime trimestrielle)
  H._shouldPrimeApplyToMonth = function (obj, monthKey) {
    var per = (obj && obj.periodicite) || 'mensuel';
    if (per === 'mensuel') return true;
    if (per === 'trimestriel') {
      var p = (monthKey || '').split('-'); if (p.length < 2) return false;
      var mo = parseInt(p[1], 10);
      return mo === 3 || mo === 6 || mo === 9 || mo === 12;
    }
    return false;
  };
  // Calcule la prime brute acquise (cumulatif, CA ≥ seuil)
  H._calcPrimeAbsFromCA = function (paliersAbs, caHT) {
    var s = 0;
    var list = paliersAbs || [];
    for (var i = 0; i < list.length; i++) {
      var seuil = H.pf(list[i].seuilCA);
      var prime = H.pf(list[i].primeBrut);
      if (seuil > 0 && caHT >= seuil) s += prime;
    }
    return s;
  };
  // Calcule le CA total à comparer pour un objectif, selon périodicité
  //   • Essaie d'abord le cache global window._caByMonth (rempli par pilotage)
  //   • Pour mensuel : fallback sur currentMonthData (d) si pas de cache
  //   • Pour trimestriel : nécessite le cache ; sinon retourne 0
  H._getCAForPaliersAbs = function (obj, monthKey, currentMonthData) {
    var per = (obj && obj.periodicite) || 'mensuel';
    var cache = (global && global._caByMonth) || {};
    if (per === 'mensuel') {
      if (monthKey && typeof cache[monthKey] === 'number') return cache[monthKey];
      // Fallback : calcule directement depuis le doc du mois (si fourni)
      if (currentMonthData) return H._caHtFromMonthDoc(currentMonthData);
      return 0;
    }
    if (per === 'trimestriel') {
      if (!monthKey) return 0;
      var keys = H._trimestreKeysOf(monthKey);
      var total = 0, missing = 0;
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (typeof cache[k] === 'number') total += cache[k];
        else if (k === monthKey && currentMonthData) total += H._caHtFromMonthDoc(currentMonthData);
        else missing++;
      }
      // Si des mois manquent dans le cache → calcul dégradé : on retourne ce qu'on a
      //  (le cache sera rempli au fur et à mesure que l'utilisateur navigue)
      return total;
    }
    return 0;
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
        if (l.saisieMode === 'net') {
          // Mode net : montant saisi = net, les charges patronales sont en charges variables
          result.salaries += brutM;
        } else {
          var tauxM = H.pf(l.tauxCharges);
          if (tauxM <= 0) tauxM = 42;
          result.salaries += brutM * (1 + tauxM / 100);
        }
      }
    }

    // ─── PRIMES D'OBJECTIFS ────────────────────────────────────
    // Note : monthKey peut être lu depuis d._monthKey (ajouté par les callers
    // qui ont la clé sous la main, typiquement pilotage). Sans monthKey :
    //   • mensuel    → calcule à partir de d directement (mode dégradé OK)
    //   • trimestriel → skippé (impossible de savoir si on est fin de trimestre)
    var _monthKey = d && d._monthKey ? d._monthKey : null;
    if (objs.length > 0) {
      for (var oi = 0; oi < objs.length; oi++) {
        var obj = objs[oi];
        if (!obj || obj.statut === 'annule' || obj.statut === 'brouillon') continue;
        var prime = obj.prime || {};
        var tauxP = H.pf(prime.tauxCharges);
        if (tauxP <= 0) tauxP = 45;
        var modeP = prime.modePalier || 'tout_ou_rien';
        var brutP = 0;

        // ── MODE PALIERS_ABS : CA auto-lu, cumulatif ──
        if (modeP === 'paliers_abs') {
          // Trimestriel sans monthKey → skip (ne pas afficher de prime sans contexte)
          if ((obj.periodicite === 'trimestriel') && !_monthKey) continue;
          // Skip si la prime ne doit pas s'appliquer à ce mois (trimestriel hors fin de trim)
          if (_monthKey && !H._shouldPrimeApplyToMonth(obj, _monthKey)) continue;
          var caHT = H._getCAForPaliersAbs(obj, _monthKey, d);
          brutP = H._calcPrimeAbsFromCA(prime.paliersAbs, caHT);
        } else {
          // ── MODES CLASSIQUES (avancement sur critères) ──
          var montant = H.pf(prime.montantBrut);
          if (montant <= 0) continue;
          var av = H._calcObjAvancement(obj);
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
   * HEURES SUPPLÉMENTAIRES — majorations par CCN
   * ───────────────────────────────────────────────────────────────────────
   * Règles de majoration des heures supplémentaires selon la Convention
   * Collective. Format d'une tranche :
   *   { seuil: <heures_par_semaine>, taux: <% majoration> }
   * Les tranches sont cumulatives. Le taux est un pourcentage (pas un
   * coefficient) — ex: { seuil: 8, taux: 25 } = +25% pour les 8 premières
   * heures sup hebdo, puis passage à la tranche suivante.
   *
   * La dernière tranche doit avoir seuil: Infinity (= au-delà).
   *
   * RÈGLES CÂBLÉES :
   *   • HCR (IDCC 1979)     : +10% (36e→39e) / +20% (40e→43e) / +50% (44e+)
   *   • default (droit commun) : +25% (36e→43e) / +50% (44e+)
   *
   * PRIORITÉ DE RÉSOLUTION pour un employé :
   *   1. emp.majorationCustom.tranches (override manuel)
   *   2. CCN_OVERTIME_RULES[IDCC]       (CCN pré-câblée)
   *   3. CCN_OVERTIME_RULES.default     (fallback droit commun)
   * ─────────────────────────────────────────────────────────────────────── */

  H.CCN_OVERTIME_RULES = {
    // IDCC 1979 — Hôtels Cafés Restaurants
    '1979': [
      { seuil: 4, taux: 10 },         // 36e → 39e : +10%
      { seuil: 4, taux: 20 },         // 40e → 43e : +20%
      { seuil: Infinity, taux: 50 }   // 44e+     : +50%
    ],
    // Droit commun (Code du travail, L.3121-36)
    default: [
      { seuil: 8, taux: 25 },         // 36e → 43e : +25%
      { seuil: Infinity, taux: 50 }   // 44e+     : +50%
    ]
  };

  /* Retourne les tranches applicables pour un employé.
     Ordre : custom > CCN pré-câblée > default */
  H.getOvertimeTranches = function (emp) {
    if (!emp) return H.CCN_OVERTIME_RULES.default;

    // 1) Override manuel ?
    if (emp.majorationCustom &&
        Array.isArray(emp.majorationCustom.tranches) &&
        emp.majorationCustom.tranches.length > 0) {
      // Protection : s'assurer que la dernière tranche est Infinity
      var tr = emp.majorationCustom.tranches.slice();
      var last = tr[tr.length - 1];
      if (last && isFinite(last.seuil)) {
        tr.push({ seuil: Infinity, taux: H.pf(last.taux) });
      }
      return tr;
    }

    // 2) CCN pré-câblée : on accepte un IDCC passé soit dans emp.ccnData.idcc,
    //    soit directement dans emp.ccn si c'est un nombre, soit via la clé.
    var idcc = null;
    if (emp.ccnData && emp.ccnData.idcc != null) idcc = String(emp.ccnData.idcc);
    if (!idcc && emp.ccn && /^\d+$/.test(String(emp.ccn))) idcc = String(emp.ccn);
    if (idcc && H.CCN_OVERTIME_RULES[idcc]) return H.CCN_OVERTIME_RULES[idcc];

    // 3) Fallback
    return H.CCN_OVERTIME_RULES.default;
  };

  /* Décrit les tranches sous forme lisible pour l'UI.
     Ex: "+10% (36e→39e) · +20% (40e→43e) · +50% au-delà" */
  H.describeOvertimeTranches = function (tranches) {
    if (!Array.isArray(tranches) || tranches.length === 0) return '';
    var parts = [];
    var cumul = 35;
    for (var i = 0; i < tranches.length; i++) {
      var t = tranches[i];
      var taux = H.pf(t.taux);
      if (!isFinite(t.seuil)) {
        parts.push('+' + taux + '% au-delà');
      } else {
        parts.push('+' + taux + '% (' + (cumul + 1) + 'e→' + (cumul + t.seuil) + 'e)');
        cumul += t.seuil;
      }
    }
    return parts.join(' · ');
  };

  /* Calcule le brut mensuel contractuel à partir d'un taux horaire de base.
     - tauxH       : taux horaire brut de base (€/h) — celui de la 1ère heure
     - heuresHebdo : nb heures contractuelles par semaine (ex: 39)
     - tranches    : tableau de majorations
     Retourne le brut mensuel mensualisé (52/12).
     
     Ex HCR 39h à 12€/h :
       35h × 12 + 4h × 12 × 1.10 = 420 + 52.80 = 472.80 €/sem
       × 52/12 = 2049.20 €/mois */
  H.calcBrutFromTauxHoraire = function (tauxH, heuresHebdo, tranches) {
    var th = H.pf(tauxH);
    var hh = H.pf(heuresHebdo);
    if (th <= 0 || hh <= 0) return 0;
    if (!Array.isArray(tranches) || tranches.length === 0) {
      tranches = H.CCN_OVERTIME_RULES.default;
    }

    var base = Math.min(hh, 35);
    var heuresEqSem = base;
    var reste = Math.max(hh - 35, 0);

    for (var i = 0; i < tranches.length && reste > 0; i++) {
      var t = tranches[i];
      var seuil = isFinite(t.seuil) ? t.seuil : reste;
      var inTr = Math.min(reste, seuil);
      heuresEqSem += inTr * (1 + H.pf(t.taux) / 100);
      reste -= inTr;
    }

    return Math.round(th * heuresEqSem * 52 / 12 * 100) / 100;
  };

  /* Fonction inverse : déduit le taux horaire de base depuis le brut mensuel.
     Utile pour "auto-fill" informatif dans le formulaire à partir d'un brut
     déjà saisi. */
  H.calcTauxHoraireFromBrut = function (brut, heuresHebdo, tranches) {
    var b = H.pf(brut);
    var hh = H.pf(heuresHebdo);
    if (b <= 0 || hh <= 0) return 0;
    if (!Array.isArray(tranches) || tranches.length === 0) {
      tranches = H.CCN_OVERTIME_RULES.default;
    }

    var base = Math.min(hh, 35);
    var heuresEqSem = base;
    var reste = Math.max(hh - 35, 0);

    for (var i = 0; i < tranches.length && reste > 0; i++) {
      var t = tranches[i];
      var seuil = isFinite(t.seuil) ? t.seuil : reste;
      var inTr = Math.min(reste, seuil);
      heuresEqSem += inTr * (1 + H.pf(t.taux) / 100);
      reste -= inTr;
    }

    var heuresEqMois = heuresEqSem * 52 / 12;
    if (heuresEqMois <= 0) return 0;
    return Math.round(b / heuresEqMois * 10000) / 10000; // 4 décimales
  };

  /* Calcul du brut mensuel réel à partir des heures travaillées réelles
     + heures sup exceptionnelles (utilisé par rh-paie.html).

     Sémantique des paramètres (comme actuellement dans rh-paie) :
     - heuresReelles   : total des heures travaillées dans le mois
                         (INCLUT les heures structurelles du contrat)
     - heuresSupExcept : heures sup EXCEPTIONNELLES au-delà du contrat

     Logique :
     1. On fait d'abord un prorata du brut contractuel selon heuresReelles
        vs heures contractuelles mensualisées. Cela gère correctement les
        absences et les temps partiels.
     2. Si heuresReelles dépasse le contrat, on bascule l'excédent dans
        les heures sup exceptionnelles.
     3. Les heures sup exceptionnelles sont payées aux tranches qui SUIVENT
        les heures sup structurelles du contrat.
        Ex: HCR 39h (tranche +10% déjà "consommée" par le contrat) —
        la 1ère heure exceptionnelle tombe dans la tranche +20%.
  */
  H.calcBrutFromHeuresReelles = function (emp, heuresReelles, heuresSupExcept) {
    if (!emp) return 0;
    var tauxHBase = H.pf(emp.tauxHoraireBase);
    if (tauxHBase <= 0) return 0; // Appelant doit gérer le fallback

    var hHebdo = H.pf(emp.heuresHebdo) || 35;
    var hReelles = H.pf(heuresReelles);
    var hSupExcept = H.pf(heuresSupExcept);
    if (hReelles <= 0 && hSupExcept <= 0) return 0;

    var tranches = H.getOvertimeTranches(emp);
    var moisEq = 52 / 12;
    var heuresContratMensuel = hHebdo * moisEq;

    // Étape 1 : prorata du brut contrat selon heures réelles
    var brutContratPlein = H.calcBrutFromTauxHoraire(tauxHBase, hHebdo, tranches);
    var brutProrata, heuresAuDela;
    if (hReelles <= heuresContratMensuel) {
      brutProrata = brutContratPlein * (hReelles / heuresContratMensuel);
      heuresAuDela = 0;
    } else {
      brutProrata = brutContratPlein;
      heuresAuDela = hReelles - heuresContratMensuel;
    }

    // Étape 2 : heures sup exceptionnelles totales (implicites + explicites)
    var hSupTotalMois = heuresAuDela + hSupExcept;
    if (hSupTotalMois <= 0) return Math.round(brutProrata * 100) / 100;

    // Étape 3 : appliquer les tranches, en skipant ce qui est déjà consommé
    // par le contrat (heures sup structurelles hebdo).
    var hSupContratSem = Math.max(hHebdo - 35, 0);
    var hSupExceptSem = hSupTotalMois / moisEq;

    var consomme = hSupContratSem;
    var reste = hSupExceptSem;
    var montantSupExcept = 0;

    for (var i = 0; i < tranches.length && reste > 0; i++) {
      var t = tranches[i];
      var seuilTr = isFinite(t.seuil) ? t.seuil : reste + consomme;

      if (consomme >= seuilTr) {
        // Tranche déjà entièrement consommée par le contrat
        consomme -= seuilTr;
        continue;
      }

      var dispo = seuilTr - consomme;
      var inTr = Math.min(reste, dispo);
      montantSupExcept += tauxHBase * (1 + H.pf(t.taux) / 100) * inTr * moisEq;
      reste -= inTr;
      consomme = 0; // le reste des tranches est "frais"
    }

    return Math.round((brutProrata + montantSupExcept) * 100) / 100;
  };

  /* ───────────────────────────────────────────────────────────────────────
   * AVANTAGES EN NATURE (AEN)
   * ───────────────────────────────────────────────────────────────────────
   * Les AEN s'ajoutent au brut pour le calcul des cotisations. Ils sont
   * ensuite déduits du net imposable pour obtenir le net à payer
   * (car déjà consommés en nature).
   *
   * Structure stockée sur emp.avantagesNature :
   *   {
   *     repas:     { actif: bool, nbMois: number, unitaire: number, total: number },
   *     logement:  { actif: bool, montantMensuel: number },
   *     vehicule:  { actif: bool, montantMensuel: number },
   *     transport: { actif: bool, montantMensuel: number }
   *   }
   *
   * Montant URSSAF 2026 pour le repas : 5,50€ (barème général, éditable).
   * ─────────────────────────────────────────────────────────────────────── */

  H.AEN_REPAS_UNITAIRE_DEFAULT = 5.50;
  H.AEN_REPAS_NB_MOIS_DEFAULT = 20;

  /* Retourne le détail des AEN actifs d'un employé.
     Sortie :
       {
         total:   number   — somme mensuelle de tous les AEN actifs
         lignes:  [...]    — lignes prêtes à afficher dans un bulletin
         detail:  {...}    — montants par type (pour calculs ciblés)
       }
     Si aucun AEN actif : total = 0, lignes vides. */
  H.getAvantagesNatureEffectif = function (emp) {
    var out = { total: 0, lignes: [], detail: {} };
    if (!emp || !emp.avantagesNature) return out;
    var a = emp.avantagesNature;

    // Repas
    if (a.repas && a.repas.actif) {
      var nb = H.pf(a.repas.nbMois);
      var u  = H.pf(a.repas.unitaire);
      var tR = Math.round(nb * u * 100) / 100;
      if (tR > 0) {
        out.total += tR;
        out.detail.repas = tR;
        out.lignes.push({
          type: 'repas',
          label: 'Avantage en nature — repas',
          base: nb,
          tauxOuUnitaire: u,
          details: nb + ' × ' + u.toFixed(2).replace('.',',') + ' €',
          montant: tR
        });
      }
    }

    // Logement
    if (a.logement && a.logement.actif) {
      var lv = H.pf(a.logement.montantMensuel);
      if (lv > 0) {
        out.total += lv;
        out.detail.logement = lv;
        out.lignes.push({
          type: 'logement',
          label: 'Avantage en nature — logement',
          details: '',
          montant: lv
        });
      }
    }

    // Véhicule
    if (a.vehicule && a.vehicule.actif) {
      var vv = H.pf(a.vehicule.montantMensuel);
      if (vv > 0) {
        out.total += vv;
        out.detail.vehicule = vv;
        out.lignes.push({
          type: 'vehicule',
          label: 'Avantage en nature — véhicule',
          details: '',
          montant: vv
        });
      }
    }

    // Transport
    if (a.transport && a.transport.actif) {
      var tv = H.pf(a.transport.montantMensuel);
      if (tv > 0) {
        out.total += tv;
        out.detail.transport = tv;
        out.lignes.push({
          type: 'transport',
          label: 'Avantage en nature — transport',
          details: '',
          montant: tv
        });
      }
    }

    out.total = Math.round(out.total * 100) / 100;
    return out;
  };

  /* ───────────────────────────────────────────────────────────────────────
   * EMPRUNTS — Tableau d'amortissement partagé
   * ───────────────────────────────────────────────────────────────────────
   *
   * Source de vérité unique pour le calcul des échéances d'emprunt.
   * Logique extraite de dettes.html pour qu'elle soit réutilisée par
   * pilotage.html → garantit que la mensualité affichée dans Pilotage
   * correspond EXACTEMENT à celle affichée dans Dettes & Emprunts.
   *
   * Avant cette extraction, Pilotage utilisait une formule simpliste
   *   intérêt = montant × taux / 100 / 12
   * qui était fausse pour 3 des 4 types d'amortissement et produisait
   * un écart visible avec Dettes (ex : 100,25 € vs 101,25 € sur MATINAE).
   *
   * Format dette attendu (compatible avec dettes.html `_dettes[]`) :
   *   {
   *     type: 'emprunt',
   *     montant: 900,           // capital initial emprunté
   *     taux: 3,                // taux annuel %
   *     duree: 9,               // durée en mois
   *     amort: 'constant'|'lineaire'|'fixe'|'infine',
   *     debut: '2026-01-01'     // ISO date
   *   }
   *
   * Retour calcAmortSchedule : tableau d'échéances
   *   [{ date: 'YYYY-MM-DD', capital, interet, mensualite, solde, idx }, …]
   * ─────────────────────────────────────────────────────────────────────── */

  // Ajoute n mois à une date (1er du mois résultat, en local)
  H._addMonths = function (date, n) {
    var d = new Date(date);
    return new Date(d.getFullYear(), d.getMonth() + n, 1);
  };

  // Calcule le monthKey "YYYY-MM" qui correspond logiquement à la k-ième
  // échéance d'un emprunt démarré à `debut`, en local.
  // Convention : la 1ère échéance (k=0) tombe dans le mois de début du prêt.
  // Ainsi un prêt démarré le 01/01/2026 a sa 1ère échéance dans "2026-01",
  // sa 5ème dans "2026-05", etc. — cohérent avec ce que voit l'utilisateur.
  H._echeanceMonthKey = function (debut, k) {
    var d = new Date(debut);
    var y = d.getFullYear();
    var m = d.getMonth() + k; // 0-indexé
    // normaliser
    var dt = new Date(y, m, 1);
    var yy = dt.getFullYear();
    var mm = dt.getMonth() + 1;
    return yy + '-' + (mm < 10 ? '0' + mm : '' + mm);
  };

  // Reproduit le format historique "YYYY-MM-DD" que produisait dettes.html
  // pour l'affichage. On garde ce format pour ne pas changer ce qui est
  // affiché côté Dettes & Emprunts (compat visuelle).
  H._displayDate = function (dt) {
    try { return dt.toISOString().slice(0, 10); } catch (e) {
      return (dt.getFullYear()) + '-' +
        (dt.getMonth() + 1 < 10 ? '0' : '') + (dt.getMonth() + 1) + '-' +
        (dt.getDate() < 10 ? '0' : '') + dt.getDate();
    }
  };

  H._calcAmortScheduleSimple = function (d) {
    if (!d) return [];
    var m = H.pf(d.montant);
    var taux = H.pf(d.taux);
    var duree = parseInt(d.duree, 10) || 0;
    if (m <= 0 || !d.debut) return [];

    var debut = new Date(d.debut);
    if (isNaN(debut.getTime())) return [];
    var rows = [];

    // Types non-emprunt : pas d'amortissement classique (pas besoin de duree)
    if (d.type === 'fournisseur') {
      rows.push({
        date: d.echeance || d.debut,
        monthKey: H._echeanceMonthKey(d.echeance || d.debut, 0),
        capital: m, interet: 0, mensualite: m, solde: 0, idx: 0
      });
      return rows;
    }
    if (d.type === 'decouvert') {
      var tauxMd = taux / 12 / 100;
      rows.push({
        date: d.debut,
        monthKey: H._echeanceMonthKey(d.debut, 0),
        capital: 0, interet: m * tauxMd, mensualite: m * tauxMd,
        solde: m, idx: 0, note: 'Intérêts mensuels'
      });
      return rows;
    }

    // À partir d'ici (leasing, emprunt) on a besoin d'une durée
    if (duree <= 0) return [];
    if (d.type === 'leasing') {
      var loyer = H.pf(d.loyer);
      for (var iL = 0; iL < duree; iL++) {
        var dtL = H._addMonths(debut, iL + 1);
        rows.push({
          date: H._displayDate(dtL),
          monthKey: H._echeanceMonthKey(debut, iL),
          capital: 0, interet: 0, mensualite: loyer,
          solde: m - (loyer * (iL + 1)), idx: iL
        });
      }
      return rows;
    }

    // Emprunt bancaire — différents amortissements
    var tauxM = taux / 12 / 100;
    var amort = d.amort || 'constant';

    // ─── In fine : intérêts seuls + capital au dernier mois ───
    if (amort === 'infine') {
      var intMI = m * tauxM;
      for (var iI = 0; iI < duree; iI++) {
        var dtI = H._addMonths(debut, iI + 1);
        var isLast = iI === duree - 1;
        rows.push({
          date: H._displayDate(dtI),
          monthKey: H._echeanceMonthKey(debut, iI),
          capital: isLast ? m : 0,
          interet: intMI,
          mensualite: isLast ? m + intMI : intMI,
          solde: isLast ? 0 : m,
          idx: iI
        });
      }
      return rows;
    }

    // ─── Capital constant (linéaire) ───
    if (amort === 'lineaire') {
      var capML = m / duree;
      var soldeL = m;
      for (var iLin = 0; iLin < duree; iLin++) {
        var interetL = soldeL * tauxM;
        var dtLin = H._addMonths(debut, iLin + 1);
        rows.push({
          date: H._displayDate(dtLin),
          monthKey: H._echeanceMonthKey(debut, iLin),
          capital: capML, interet: interetL,
          mensualite: capML + interetL,
          solde: Math.max(0, soldeL - capML), idx: iLin
        });
        soldeL -= capML;
      }
      return rows;
    }

    // ─── Intérêts fixes (prêt américain simplifié) ───
    if (amort === 'fixe') {
      var capMF = m / duree;
      var intMF = m * tauxM;
      var mensualiteF = capMF + intMF;
      var soldeF = m;
      for (var iF = 0; iF < duree; iF++) {
        var dtF = H._addMonths(debut, iF + 1);
        rows.push({
          date: H._displayDate(dtF),
          monthKey: H._echeanceMonthKey(debut, iF),
          capital: capMF, interet: intMF, mensualite: mensualiteF,
          solde: Math.max(0, soldeF - capMF), idx: iF
        });
        soldeF -= capMF;
      }
      return rows;
    }

    // ─── Mensualités constantes (par défaut, le plus courant) ───
    if (tauxM === 0) {
      var capMZ = m / duree;
      var soldeZ = m;
      for (var iZ = 0; iZ < duree; iZ++) {
        var dtZ = H._addMonths(debut, iZ + 1);
        rows.push({
          date: H._displayDate(dtZ),
          monthKey: H._echeanceMonthKey(debut, iZ),
          capital: capMZ, interet: 0, mensualite: capMZ,
          solde: Math.max(0, soldeZ - capMZ), idx: iZ
        });
        soldeZ -= capMZ;
      }
      return rows;
    }
    var mensualiteC = m * (tauxM * Math.pow(1 + tauxM, duree)) / (Math.pow(1 + tauxM, duree) - 1);
    var soldeC = m;
    for (var iC = 0; iC < duree; iC++) {
      var interetC = soldeC * tauxM;
      var capitalC = mensualiteC - interetC;
      var dtC = H._addMonths(debut, iC + 1);
      rows.push({
        date: H._displayDate(dtC),
        monthKey: H._echeanceMonthKey(debut, iC),
        capital: capitalC, interet: interetC, mensualite: mensualiteC,
        solde: Math.max(0, soldeC - capitalC), idx: iC
      });
      soldeC -= capitalC;
    }
    return rows;
  };

  /* ───────────────────────────────────────────────────────────────────────
   * H.calcAmortSchedule(d) — Échéancier prenant en compte les renégociations
   * ───────────────────────────────────────────────────────────────────────
   * Si `d.modifications` est un tableau non vide, on découpe l'échéancier
   * en phases :
   *   • Phase 0 : conditions originelles (d.montant, d.taux, d.duree, d.amort)
   *               jusqu'à la date d'effet de la 1ère modification (exclusive)
   *   • Phase k : conditions de la k-ième modification, à partir de sa
   *               date d'effet jusqu'à la date d'effet de la (k+1)-ième
   *
   * Format d'une modification :
   *   { dateEffet:'YYYY-MM-DD' (ou 'YYYY-MM'),
   *     capitalRestant: 32480.50,   // calculé auto et éventuellement édité
   *     taux: 2.8,                  // nouveau taux annuel %
   *     duree: 60,                  // nouvelle durée en mois (à partir de dateEffet)
   *     amort: 'constant',          // type d'amortissement (peut différer de l'origine)
   *     mensualite: 580.12,         // optionnel — informatif (recalculé)
   *     motif: 'Rachat de crédit',  // libre, pour audit
   *     _createdAt: 'ISO8601'       // posé à la création
   *   }
   *
   * Les `idx` des phases pré-existantes sont préservés (croissants 0,1,2,...)
   * → les paid.has(idx) restent corrects tant que la dateEffet est future
   *   ou contemporaine. Les utilisateurs ne peuvent pas créer de modif passée
   *   (vérifié côté UI dans dettes.html).
   * ─────────────────────────────────────────────────────────────────────── */
  H.calcAmortSchedule = function (d) {
    if (!d) return [];

    var mods = (d.modifications && d.modifications.length) ? d.modifications.slice() : [];
    // Pas de renégociation → comportement historique strict
    if (!mods.length) return H._calcAmortScheduleSimple(d);

    // Pour les types non-emprunt (fournisseur, decouvert, leasing) on ne supporte
    // pas les modifications → on retourne le calcul simple
    if (d.type && d.type !== 'emprunt') return H._calcAmortScheduleSimple(d);

    // Trier les modifications par dateEffet croissante
    mods.sort(function (a, b) {
      var ka = (a.dateEffet || '').slice(0, 10);
      var kb = (b.dateEffet || '').slice(0, 10);
      return ka < kb ? -1 : (ka > kb ? 1 : 0);
    });

    var rows = [];
    var globalIdx = 0;

    // ── Phase 0 : conditions originelles, tronquée à la 1ère dateEffet ──
    var firstMod = mods[0];
    var firstMonthKey = (firstMod.dateEffet || '').slice(0, 7);
    var phase0 = H._calcAmortScheduleSimple(d);
    for (var i0 = 0; i0 < phase0.length; i0++) {
      var r0 = phase0[i0];
      if (r0.monthKey >= firstMonthKey) break; // on s'arrête à la 1ère modif (exclusive)
      r0.idx = globalIdx++;
      rows.push(r0);
    }

    // ── Phases k ≥ 1 : pour chaque modification, recalculer à partir de cette date ──
    for (var k = 0; k < mods.length; k++) {
      var mod  = mods[k];
      var next = mods[k + 1] || null;
      var nextMonthKey = next ? (next.dateEffet || '').slice(0, 7) : null;

      // Construire une "dette virtuelle" pour cette phase
      var dPhase = {
        type:    'emprunt',
        montant: H.pf(mod.capitalRestant),
        taux:    (mod.taux !== undefined && mod.taux !== '') ? H.pf(mod.taux) : H.pf(d.taux),
        duree:   parseInt(mod.duree, 10) || 0,
        amort:   mod.amort || d.amort || 'constant',
        debut:   mod.dateEffet
      };
      if (dPhase.montant <= 0 || dPhase.duree <= 0 || !dPhase.debut) continue;

      var phaseSched = H._calcAmortScheduleSimple(dPhase);
      for (var j = 0; j < phaseSched.length; j++) {
        var rj = phaseSched[j];
        if (nextMonthKey && rj.monthKey >= nextMonthKey) break; // troncature pour la phase suivante
        rj.idx = globalIdx++;
        rows.push(rj);
      }
    }

    return rows;
  };

  /* ───────────────────────────────────────────────────────────────────────
   * H.getCapitalRestantAt(dette, monthKey)
   * ───────────────────────────────────────────────────────────────────────
   * Retourne le capital restant dû AU DÉBUT du mois `monthKey`, c'est-à-dire
   * juste avant que l'échéance de ce mois soit prélevée.
   *
   * Exemple : pour MATINAE (capital 900 €, début 2026-01) :
   *   getCapitalRestantAt(d, '2026-01') === 900     (avant 1ère échéance)
   *   getCapitalRestantAt(d, '2026-05') === 502.50  (juste avant celle de mai)
   *   getCapitalRestantAt(d, '2026-10') === 0       (après dernière)
   *
   * Mécanique : on cherche l'échéance précédant `monthKey` et on lit son `solde`.
   * Si `monthKey` est avant la 1ère échéance → on retourne `dette.montant` initial.
   * ─────────────────────────────────────────────────────────────────────── */
  H.getCapitalRestantAt = function (dette, monthKey) {
    if (!dette) return 0;
    if (!monthKey) return H.pf(dette.montant);
    var sched = H.calcAmortSchedule(dette);
    if (!sched || !sched.length) return H.pf(dette.montant);

    var lastBefore = null;
    for (var i = 0; i < sched.length; i++) {
      if (sched[i].monthKey < monthKey) lastBefore = sched[i];
      else break;
    }
    if (!lastBefore) return H.pf(dette.montant); // monthKey antérieur à toutes les échéances
    return Math.max(0, lastBefore.solde || 0);
  };

  /* ───────────────────────────────────────────────────────────────────────
   * H.calcMensualiteFromCapital(capital, taux, duree, amort)
   * ───────────────────────────────────────────────────────────────────────
   * Calcule la mensualité (totale, capital + intérêts) attendue pour un
   * emprunt donné. Pour `lineaire`, retourne la MOYENNE (la mensualité
   * varie chaque mois pour ce type).
   * Pour `infine`, retourne la mensualité d'intérêts seuls (la dernière
   * échéance contient en plus le capital total).
   * ─────────────────────────────────────────────────────────────────────── */
  H.calcMensualiteFromCapital = function (capital, taux, duree, amort) {
    var c = H.pf(capital), t = H.pf(taux), n = parseInt(duree, 10) || 0;
    if (c <= 0 || n <= 0) return 0;
    var i = (t / 100) / 12;
    if (i <= 0) return c / n;
    amort = amort || 'constant';
    if (amort === 'constant') {
      return c * (i * Math.pow(1 + i, n)) / (Math.pow(1 + i, n) - 1);
    }
    if (amort === 'lineaire') {
      // Mensualité moyenne : capital constant + intérêts moyens
      // intérêts moyens = c × i × (n+1) / (2n) → mensualité moyenne = c/n + c×i×(n+1)/(2n)
      return c / n + c * i * (n + 1) / (2 * n);
    }
    if (amort === 'fixe') {
      return c / n + c * i;
    }
    if (amort === 'infine') {
      return c * i;
    }
    return c / n;
  };

  /* ───────────────────────────────────────────────────────────────────────
   * H.calcDureeFromMensualite(capital, taux, mensualite, amort)
   * ───────────────────────────────────────────────────────────────────────
   * Inverse : trouve la durée (en mois) qui donne la mensualité saisie.
   * - constant : formule fermée n = -ln(1 - C×i/m) / ln(1+i)
   * - lineaire : approximation (la mensualité varie ; on cherche n tel que
   *              moyenne = m → n²×i + n×i = 2(m×n - C) → résolution quadratique)
   * - fixe     : m = C/n + C×i  →  n = C / (m - C×i)  si m > C×i, sinon impossible
   * - infine   : pas de durée pertinente ; retourne 0 (la durée est libre,
   *              car la mensualité est juste C×i quel que soit n)
   *
   * Retourne 0 si pas de solution réaliste (mensualité trop faible pour
   * couvrir les intérêts, par exemple).
   * ─────────────────────────────────────────────────────────────────────── */
  H.calcDureeFromMensualite = function (capital, taux, mensualite, amort) {
    var c = H.pf(capital), t = H.pf(taux), m = H.pf(mensualite);
    if (c <= 0 || m <= 0) return 0;
    var i = (t / 100) / 12;
    amort = amort || 'constant';

    if (i <= 0) {
      var n0 = c / m;
      return n0 > 0 ? Math.round(n0) : 0;
    }
    if (amort === 'constant') {
      // Pour avoir une solution, il faut m > C×i (sinon les intérêts dévorent la mensualité)
      if (m <= c * i) return 0;
      var n = -Math.log(1 - c * i / m) / Math.log(1 + i);
      return n > 0 && isFinite(n) ? Math.round(n) : 0;
    }
    if (amort === 'lineaire') {
      // Résolution : m_moyen = C/n + C×i×(n+1)/(2n)
      //   2n×m = 2C + C×i×(n+1)  →  n×(2m - C×i) = C×(2 + i)
      //   n = C×(2+i) / (2m - C×i)   (si 2m > C×i)
      if (2 * m <= c * i) return 0;
      var nL = c * (2 + i) / (2 * m - c * i);
      return nL > 0 && isFinite(nL) ? Math.round(nL) : 0;
    }
    if (amort === 'fixe') {
      // m = C/n + C×i  →  n = C / (m - C×i)
      if (m <= c * i) return 0;
      var nF = c / (m - c * i);
      return nF > 0 && isFinite(nF) ? Math.round(nF) : 0;
    }
    if (amort === 'infine') {
      return 0; // durée libre, la mensualité est constante et indépendante de n
    }
    return 0;
  };

  /* ───────────────────────────────────────────────────────────────────────
   * H.getMonthEcheance(dette, monthKey)
   * ───────────────────────────────────────────────────────────────────────
   * Retourne l'échéance correspondant au mois `monthKey` (format YYYY-MM)
   * pour la dette donnée, ou null si aucun match.
   *
   * Utilise calcAmortSchedule + matching mois/année sur la date de l'échéance.
   * ─────────────────────────────────────────────────────────────────────── */
  H.getMonthEcheance = function (dette, monthKey) {
    if (!dette || !monthKey) return null;
    var sched = H.calcAmortSchedule(dette);
    if (!sched || !sched.length) return null;
    for (var i = 0; i < sched.length; i++) {
      if (sched[i].monthKey === monthKey) return sched[i];
    }
    return null;
  };

  /* ───────────────────────────────────────────────────────────────────────
   * H.findDetteForCredit(credit, dettesList)
   * ───────────────────────────────────────────────────────────────────────
   * Trouve la dette correspondant à un crédit pilotage. Match en cascade :
   *   1) _pilotageRef === credit.fournisseur (lien fort, posé par sync)
   *   2) nom (insensible à la casse) === credit.fournisseur
   *   3) nom (insensible à la casse) === credit.nom
   *
   * Filtre type='emprunt' et active !== false.
   * Retourne null si rien trouvé.
   * ─────────────────────────────────────────────────────────────────────── */
  H.findDetteForCredit = function (credit, dettesList) {
    if (!credit || !dettesList || !dettesList.length) return null;
    var fournisseur = (credit.fournisseur || '').trim();
    var nom = (credit.nom || '').trim();
    var fournisseurLc = fournisseur.toLowerCase();
    var nomLc = nom.toLowerCase();

    // Pass 1 : lien fort _pilotageRef
    if (fournisseur) {
      for (var i = 0; i < dettesList.length; i++) {
        var d = dettesList[i];
        if (!d || d.type !== 'emprunt' || d.active === false) continue;
        if ((d._pilotageRef || '').trim() === fournisseur) return d;
      }
    }
    // Pass 2 : match par nom
    for (var j = 0; j < dettesList.length; j++) {
      var d2 = dettesList[j];
      if (!d2 || d2.type !== 'emprunt' || d2.active === false) continue;
      var dnom = (d2.nom || '').trim().toLowerCase();
      if (dnom && (dnom === fournisseurLc || dnom === nomLc)) return d2;
    }
    return null;
  };

  /* ───────────────────────────────────────────────────────────────────────
   * H.AMORT_LABELS — Libellés grand public + tooltip pédagogique
   * ───────────────────────────────────────────────────────────────────────
   * Pour les selects "type d'amortissement" exposés à l'utilisateur final.
   * Chaque entrée contient :
   *   • short : libellé court (option du select)
   *   • title : sous-titre 1 ligne (affiché en <small> ou tooltip)
   *   • help  : explication 2-3 phrases pour pédagogie
   * ─────────────────────────────────────────────────────────────────────── */
  H.AMORT_LABELS = {
    constant: {
      short: '🏦 Mensualités constantes',
      title: 'Le plus courant — emprunt classique en banque',
      help: 'Vous payez la même somme chaque mois (capital + intérêts confondus). La part d\'intérêts est plus élevée au début et diminue avec le temps. C\'est le mode par défaut de la quasi-totalité des prêts immobiliers et professionnels.'
    },
    lineaire: {
      short: '📉 Capital constant',
      title: 'Mensualités dégressives — coût total moins élevé',
      help: 'Vous remboursez la même part de capital chaque mois, mais les intérêts diminuent au fil du temps. Donc la mensualité globale baisse mois après mois. Plus rare, parfois proposé pour les prêts professionnels ou les rachats anticipés.'
    },
    fixe: {
      short: '📊 Intérêts fixes',
      title: 'Crédit conso ou financement matériel — coût total élevé',
      help: 'Les intérêts sont calculés une fois pour toutes sur le capital initial et répartis sur la durée. Mensualités constantes mais coût total des intérêts plus élevé qu\'un prêt classique. Souvent utilisé en crédit à la consommation ou financement de matériel.'
    },
    infine: {
      short: '🎯 In fine',
      title: 'Intérêts seuls puis capital à la fin',
      help: 'Vous ne payez que les intérêts chaque mois, et vous remboursez la totalité du capital au dernier mois. Utilisé pour les prêts patrimoniaux, prêts relais, ou montages avec assurance-vie en garantie.'
    }
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

    heures_hebdo_contrat: {
      title: 'Heures par semaine — durée contractuelle',
      short: 'Saisissez le TOTAL d\'heures par semaine inscrit au contrat — pas la base légale 35h.',
      long: 'Pour un temps plein classique : 35h. Pour un temps plein restauration (CCN HCR) : 39h = 35h de base + 4h supplémentaires structurelles. Pour un temps partiel : votre durée réelle (ex: 24h, 30h). Le système décompose ensuite automatiquement la base 35h et les heures sup avec les majorations de votre CCN (par ex. +10% HCR ou +25% droit commun).'
    },

    avantages_nature: {
      title: 'Avantages en nature',
      short: 'Ce que l\'employé reçoit au-delà du salaire cash (repas, logement, véhicule, transport).',
      long: 'Les avantages en nature s\'ajoutent au brut pour le calcul des cotisations — ils sont donc soumis aux charges sociales. Ils sont ensuite déduits du net imposable pour obtenir le net à payer, car ils ont déjà été consommés en nature. Exemple : 10 repas × 5,50€ = 55€ en nature → cotisations sur (salaire + 55€), puis on retire 55€ du net car le salarié a déjà eu ses repas.'
    },

    taux_horaire_base: {
      title: 'Taux horaire de base',
      short: 'Le taux payé pour la 1ère heure, AVANT toute majoration.',
      long: 'Saisissez le taux brut de base (celui qui figure au contrat, avant majoration des heures sup). Le système calcule le brut mensuel en appliquant les majorations de votre CCN : pour un 39h HCR à 12€/h, le brut mensuel sera 35h×12€ + 4h×12€×1.10 mensualisé = 2 049€. Personnalisez les majorations via le bouton à droite si votre accord d\'entreprise déroge à la CCN.'
    },

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
      title: 'Cashflow (mis à jour)',
      short: 'Le mouvement net de votre compte bancaire sur le mois.',
      long: 'Cashflow = tout ce qui entre sur votre compte (CA TTC + rentrées diverses) − tout ce qui en sort (fournisseurs TTC + salaires + échéances de crédit). Le calcul a été corrigé récemment pour utiliser les montants TTC (réalité bancaire) au lieu du HT — pour la plupart des clients, le cashflow affiché a augmenté. ⚠️ Ce chiffre n\'inclut pas le reversement de votre TVA à l\'État : pensez à la provisionner séparément en regardant votre "TVA due" chaque mois.'
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
    },

    tva_collectee_ca3: {
      title: 'TVA collectée — méthode CA3',
      short: 'Calcul officiel : base HT × taux. La valeur "CA3" en dessous est arrondie à l\'euro — c\'est ce que vous reportez sur votre déclaration aux impôts.',
      long: 'Votre caisse certifiée calcule la TVA ticket par ticket et arrondit au centime sur chaque ticket avant de sommer. Pilotage agrège votre CA et calcule la TVA sur le total — un seul arrondi final. Les deux méthodes sont valides comptablement, mais elles peuvent diverger de quelques centimes par jour (c\'est mathématiquement inévitable, l\'erreur d\'agrégation des arrondis). Pour votre déclaration de TVA (formulaire 3310-CA3 sur impots.gouv.fr), tous les montants se déclarent à l\'euro entier : l\'écart de centimes disparaît automatiquement. La caisse NF525 reste la référence légale pour la TVA réellement encaissée sur les tickets — Pilotage vous donne la vue consolidée mensuelle pour piloter votre marge et anticiper votre TVA à payer.'
    },

    remuneration_dirigeant_brut: {
      title: 'Rémunération brute du dirigeant',
      short: 'Saisis ton BRUT mensuel. Pilotage calcule TOUTES les cotisations automatiquement (patronales + salariales pour SAS, URSSAF total pour TNS) — tu n\'as rien à ajouter ailleurs.',
      long: 'Pour un dirigeant SAS/SASU (assimilé salarié) — exemple avec 2 000 € brut : (1) la société paie 42% de cotisations PATRONALES en plus = 840 €/mois (URSSAF, retraite Agirc-Arrco, AT/MP). Coût total société : 2 840 €. (2) 22% de cotisations SALARIALES = 440 €/mois sont prélevées sur le brut (URSSAF, retraite, CSG/CRDS). Net qui te reste : 1 560 €. Le taux affiché dans Pilotage (42%) est uniquement la part patronale qui s\'ajoute au coût — la part salariale est déjà incluse dans le brut. Le ratio "82%" qu\'on lit parfois sur internet (cotisations totales rapportées au net) décrit la même réalité autrement : 1 280 € de cotisations totales / 1 560 € net = 82%. Pour un dirigeant TNS (gérant majoritaire SARL/EURL/EI) — exemple avec 2 000 € brut à 40% : un seul bloc URSSAF de 800 €/mois (sécu, retraite, CSG, CRDS) qui s\'ajoute au coût. Coût société : 2 800 €. Net : 1 200 €. Pas de séparation patronal/salarial — c\'est plus simple, mais le taux est progressif selon le revenu. DANS LES DEUX CAS : tu rentres juste ton brut et toutes les cotisations URSSAF/retraite/CSG sont incluses. Mutuelle, prévoyance personnelle et sur-complémentaire retraite restent à ajouter en Charges fixes (contrats annexes facturés séparément).'
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
   * TOOLTIP UI — injection CSS automatique + helper tooltipIcon()
   * ───────────────────────────────────────────────────────────────────────
   * Le CSS est injecté une seule fois par page, dès que le helper est chargé.
   * Chaque page peut ensuite appeler CalcHelpers.tooltipIcon('resultat_economique')
   * pour obtenir un span HTML à insérer à côté d'un libellé KPI.
   *
   * ═══ IMPLÉMENTATION (corrigée post-déploiement Wave 2) ═══
   * Le popover est un ÉLÉMENT GLOBAL unique attaché directement à document.body.
   * Raison : les cartes KPI de pilotage (.sum-card) ont un `transform:translateY`
   * au hover, ce qui casse `position:fixed` pour les descendants (le transform
   * crée un nouveau containing block). En détachant le popover du .sum-card
   * et en l'appendant au body, on contourne ce problème.
   *
   * Chaque bouton ℹ️ contient un <span class="ch-tt-pop"> caché (display:none)
   * qui sert de "data carrier" : au hover/focus, son contenu est copié dans
   * l'élément global #ch-tt-global-pop, qui est positionné en fixed par rapport
   * au bouton déclencheur et affiché.
   *
   * UX :
   *   • Hover desktop → popover riche (titre + résumé + explication longue)
   *   • Focus clavier (Tab) → même popover
   *   • Mobile → tap active :focus, retap ailleurs désactive
   * ─────────────────────────────────────────────────────────────────────── */
  H._injectTooltipCSS = function () {
    if (typeof document === 'undefined') return;
    if (document.getElementById('ch-tooltip-css')) return;
    var css = [
      /* Bouton ℹ️ */
      '.ch-tt{display:inline-flex;align-items:center;justify-content:center;',
      'width:16px;height:16px;border-radius:50%;background:rgba(100,116,139,.15);',
      'color:#64748b;font-size:10px;font-weight:700;cursor:help;margin-left:6px;',
      'vertical-align:middle;position:relative;border:none;padding:0;',
      'font-family:inherit;line-height:1;transition:all .15s}',
      '.ch-tt:hover,.ch-tt:focus{background:rgba(37,99,235,.15);color:#2563eb;outline:none}',
      /* Span interne : caché, sert de data carrier */
      '.ch-tt-pop{display:none}',
      /* Popover global, attaché à body */
      '#ch-tt-global-pop{position:fixed;background:#0f172a;color:#f1f5f9;',
      'padding:12px 14px;border-radius:10px;font-size:12px;font-weight:500;',
      'white-space:normal;width:280px;max-width:90vw;z-index:2147483647;',
      'box-shadow:0 10px 40px rgba(0,0,0,.25),0 0 0 1px rgba(255,255,255,.06);',
      'line-height:1.5;text-align:left;text-transform:none;letter-spacing:normal;',
      'opacity:0;pointer-events:none;transition:opacity .12s;left:-9999px;top:-9999px}',
      '#ch-tt-global-pop.show{opacity:1}',
      '#ch-tt-global-pop .ch-tt-title{font-weight:700;font-size:12px;margin-bottom:4px;color:#fff}',
      '#ch-tt-global-pop .ch-tt-short{font-weight:500;color:#e2e8f0;margin-bottom:8px;font-size:11px}',
      '#ch-tt-global-pop .ch-tt-long{color:#cbd5e1;font-size:11px;font-weight:400}',
      '@media(max-width:640px){#ch-tt-global-pop{width:240px;font-size:11px;padding:10px 12px}}'
    ].join('');
    var s = document.createElement('style');
    s.id = 'ch-tooltip-css';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
    // Listeners globaux (capture phase pour être sûr qu'ils soient atteints)
    document.addEventListener('mouseover', H._showTooltip, true);
    document.addEventListener('mouseout',  H._hideTooltip, true);
    document.addEventListener('focusin',   H._showTooltip, true);
    document.addEventListener('focusout',  H._hideTooltip, true);
    // Cacher au scroll / resize pour éviter les positions obsolètes
    window.addEventListener('scroll',  H._hideTooltip, true);
    window.addEventListener('resize',  H._hideTooltip, true);
  };

  // Échappement HTML minimaliste pour les attributs
  H._esc = function (str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  // Récupère (ou crée) l'élément popover global attaché à body
  H._getGlobalPop = function () {
    var p = document.getElementById('ch-tt-global-pop');
    if (!p) {
      p = document.createElement('div');
      p.id = 'ch-tt-global-pop';
      p.setAttribute('role', 'tooltip');
      (document.body || document.documentElement).appendChild(p);
    }
    return p;
  };

  // Remonte dans les ancêtres jusqu'à trouver un .ch-tt (ou null)
  H._findTooltipBtn = function (target) {
    var el = target;
    var max = 5; // safety
    while (el && max-- > 0) {
      if (el.classList && el.classList.contains('ch-tt')) return el;
      el = el.parentNode;
    }
    return null;
  };

  H._showTooltip = function (evt) {
    var btn = H._findTooltipBtn(evt.target);
    if (!btn) return;
    var inner = btn.querySelector('.ch-tt-pop');
    if (!inner) return;
    var pop = H._getGlobalPop();
    // Copier le contenu du span interne (data carrier) dans le popover global
    pop.innerHTML = inner.innerHTML;
    // Mesurer à position provisoire (l'opacité 0 n'empêche pas la mesure)
    pop.style.left = '0px';
    pop.style.top = '0px';
    var popW = pop.offsetWidth || 280;
    var popH = pop.offsetHeight || 100;
    // Calculer la position définitive par rapport au bouton
    var rect = btn.getBoundingClientRect();
    var vw = window.innerWidth || document.documentElement.clientWidth;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var left = rect.left + rect.width / 2 - popW / 2;
    if (left < 8) left = 8;
    if (left + popW > vw - 8) left = vw - popW - 8;
    var top = rect.top - popH - 10;          // au-dessus par défaut
    if (top < 8) top = rect.bottom + 10;     // sinon en-dessous
    if (top + popH > vh - 8) top = Math.max(8, vh - popH - 8);
    pop.style.left = left + 'px';
    pop.style.top  = top + 'px';
    pop.classList.add('show');
  };

  H._hideTooltip = function (evt) {
    // Sur scroll/resize on masque systématiquement
    if (!evt || evt.type === 'scroll' || evt.type === 'resize') {
      var p0 = document.getElementById('ch-tt-global-pop');
      if (p0) p0.classList.remove('show');
      return;
    }
    var btn = H._findTooltipBtn(evt.target);
    if (!btn) return;
    var p = document.getElementById('ch-tt-global-pop');
    if (p) p.classList.remove('show');
  };

  /**
   * Retourne un bouton ℹ️ avec un span interne contenant l'explication d'une clé.
   * Le span interne est caché (display:none) et sert de data carrier : son
   * innerHTML est copié dans le popover global au moment du hover/focus.
   * Usage : element.innerHTML += CalcHelpers.tooltipIcon('resultat_economique');
   */
  H.tooltipIcon = function (key) {
    var e = H.EXPLANATIONS[key];
    if (!e) return '';
    H._injectTooltipCSS();
    return '<button type="button" class="ch-tt" tabindex="0" aria-label="' +
      H._esc(e.title) + '">i<span class="ch-tt-pop">' +
      '<div class="ch-tt-title">' + H._esc(e.title) + '</div>' +
      '<div class="ch-tt-short">' + H._esc(e.short) + '</div>' +
      '<div class="ch-tt-long">' + H._esc(e.long) + '</div>' +
      '</span></button>';
  };

  // Injecte le CSS dès que le DOM est prêt (si on est en contexte navigateur)
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', H._injectTooltipCSS);
    } else {
      H._injectTooltipCSS();
    }
  }

  /* ───────────────────────────────────────────────────────────────────────
   * META
   * ─────────────────────────────────────────────────────────────────────── */
  H.version = '1.0.0'; // Wave 1
  H.wave = 1;

  // Expose
  global.CalcHelpers = H;

})(typeof window !== 'undefined' ? window : this);
