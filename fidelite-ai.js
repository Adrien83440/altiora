/**
 * ═══════════════════════════════════════════════════════════════
 *  ALTEORE — Fidélisation AI — Wave 1 (scoring local)
 *  v1.0.0
 * ═══════════════════════════════════════════════════════════════
 *
 *  Lib JS autonome. Zéro API externe. Zéro dépendance. Zéro stockage.
 *  Tous les calculs à la volée, lecture seule du modèle client.
 *
 *  Expose sur window._FidAI :
 *    - computeChurn(client)             → { score, level, factors }
 *    - computeLTV(client, churnScore)   → { value, trend, confidence, avgBasket, yearlyVisits }
 *    - computeNBA(client, cfg, churn, ltv) → { id, icon, label, desc, urgency, action }
 *    - computeAll(client, cfg)          → { churn, ltv, nba }
 *    - rankByRisk(clients, cfg)         → [{ client, churn, ltv, nba, priorityScore }] (trié desc)
 *
 *  Urgency levels : 'critical' | 'important' | 'normal' | 'low'
 *  Churn levels   : 'high' (≥61) | 'medium' (31-60) | 'low' (≤30)
 *
 *  RÈGLE ABSOLUE : ce module ne modifie JAMAIS le client, n'écrit rien en base,
 *  ne déclenche aucun effet de bord. Lecture seule pure.
 * ═══════════════════════════════════════════════════════════════
 */

(function(){
  'use strict';

  // ═══════════════════════════════════════════════════════════
  //  UTILS PRIVÉS
  // ═══════════════════════════════════════════════════════════

  function toDate(d){
    if(!d) return null;
    if(d instanceof Date) return isNaN(d.getTime()) ? null : d;
    var dt = new Date(d);
    return isNaN(dt.getTime()) ? null : dt;
  }

  function daysSince(d){
    var dt = toDate(d);
    if(!dt) return 9999;
    return Math.floor((Date.now() - dt.getTime()) / 86400000);
  }

  function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

  function mean(arr){
    if(!arr || !arr.length) return 0;
    var s = 0;
    for(var i=0;i<arr.length;i++) s += arr[i];
    return s / arr.length;
  }

  function median(arr){
    if(!arr || !arr.length) return 0;
    var s = arr.slice().sort(function(a,b){return a-b});
    var m = Math.floor(s.length/2);
    return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
  }

  function stdDev(arr){
    if(!arr || arr.length < 2) return 0;
    var m = mean(arr);
    var sq = [];
    for(var i=0;i<arr.length;i++) sq.push((arr[i]-m)*(arr[i]-m));
    return Math.sqrt(mean(sq));
  }

  /**
   * Extrait les visites réelles (événements 'tampon') avec date valide et montant.
   * Retourne un tableau chronologique (ancien → récent).
   */
  function getVisits(client){
    var h = (client && client.history) || [];
    var out = [];
    for(var i=0;i<h.length;i++){
      var e = h[i];
      if(!e || e.type !== 'tampon') continue;
      var d = toDate(e.date);
      if(!d) continue;
      out.push({ date: d, montant: parseFloat(e.montant) || 0 });
    }
    out.sort(function(a,b){ return a.date - b.date; });
    return out;
  }

  /**
   * Intervalle moyen/médian entre visites, en jours.
   * Retourne null si moins de 2 visites.
   */
  function avgInterval(visits){
    if(!visits || visits.length < 2) return null;
    var intervals = [];
    for(var i=1;i<visits.length;i++){
      intervals.push(Math.floor((visits[i].date - visits[i-1].date)/86400000));
    }
    return { mean: mean(intervals), median: median(intervals), intervals: intervals };
  }

  // ═══════════════════════════════════════════════════════════
  //  1. SCORE DE CHURN (risque de perte)
  // ═══════════════════════════════════════════════════════════

  /**
   * Retourne { score: 0-100, level: 'low'|'medium'|'high', factors: [string] }
   *
   * Pondération :
   *   A. Retard vs fréquence habituelle .......... 45 pts
   *   B. Tendance panier (récent vs ancien) ...... 20 pts
   *   C. Régularité (coefficient de variation) ... 15 pts
   *   D. Ancienneté × profondeur historique ...... 15 pts
   *   E. Inactivité absolue (signal brut) ........ 10 pts
   *   F. Bonus combiné retard+panier baisse ......  5 pts
   */
  function computeChurn(client){
    if(!client) return { score: 0, level: 'low', factors: [] };

    var visits = getVisits(client);
    var factors = [];

    // ─── Cas 1 : aucune visite ───
    if(visits.length === 0){
      var ageCreation = daysSince(client.createdAt);
      if(ageCreation < 14){
        return { score: 20, level: 'low', factors: ['Nouveau client, pas encore jugeable'] };
      } else if(ageCreation < 60){
        return { score: 60, level: 'medium', factors: ['Inscrit depuis ' + ageCreation + ' jours sans aucune visite'] };
      } else {
        return { score: 85, level: 'high', factors: ['Inscrit depuis plus de ' + ageCreation + ' jours, jamais venu'] };
      }
    }

    // ─── Cas 2 : une seule visite ───
    if(visits.length === 1){
      var d1 = Math.floor((Date.now() - visits[0].date.getTime())/86400000);
      if(d1 < 30){
        return { score: 35, level: 'medium', factors: ['Une seule visite il y a ' + d1 + ' jours — retour à observer'] };
      } else if(d1 < 90){
        return { score: 70, level: 'high', factors: ['Une seule visite il y a ' + d1 + ' jours — à relancer rapidement'] };
      } else {
        return { score: 88, level: 'high', factors: ['Une seule visite il y a plus de ' + d1 + ' jours — probablement perdu'] };
      }
    }

    // ─── Cas 3 : 2+ visites (cas général) ───
    var interval = avgInterval(visits);
    var medianInt = interval && interval.median ? interval.median : 30;
    if(medianInt < 1) medianInt = 1;
    var lastVisit = visits[visits.length-1].date;
    var daysSinceLast = Math.floor((Date.now() - lastVisit.getTime())/86400000);

    // ── A. Retard (0-45) ──
    var retardRatio = daysSinceLast / medianInt;
    var scoreA = 0;
    if(retardRatio < 0.8){
      scoreA = 0;
      factors.push('Rythme habituel respecté (médiane ' + Math.round(medianInt) + 'j)');
    } else if(retardRatio < 1.2){
      scoreA = 5;
      factors.push('À peu près dans les temps');
    } else if(retardRatio < 2){
      scoreA = 15;
      factors.push('Léger retard (×' + retardRatio.toFixed(1) + ' la norme de ' + Math.round(medianInt) + 'j)');
    } else if(retardRatio < 3){
      scoreA = 28;
      factors.push('Retard important (' + daysSinceLast + 'j vs ' + Math.round(medianInt) + 'j habituel)');
    } else if(retardRatio < 4){
      scoreA = 36;
      factors.push('Absent depuis ' + daysSinceLast + 'j (×' + retardRatio.toFixed(1) + ' la norme)');
    } else if(retardRatio < 6){
      scoreA = 42;
      factors.push('Absent depuis ' + daysSinceLast + 'j (×' + retardRatio.toFixed(1) + ' la norme) — très au-delà des habitudes');
    } else {
      scoreA = 45;
      factors.push('Absent depuis ' + daysSinceLast + 'j — ×' + retardRatio.toFixed(1) + ' la norme, client probablement perdu');
    }

    // ── B. Tendance panier (0-20) ──
    var scoreB = 0;
    var withMontant = [];
    for(var i=0;i<visits.length;i++){
      if(visits[i].montant > 0) withMontant.push(visits[i]);
    }
    if(withMontant.length >= 4){
      var n = withMontant.length;
      var midB = Math.floor(n/2);
      var firstHalf = withMontant.slice(0, midB);
      var secondHalf = withMontant.slice(midB);
      var avg1 = mean(firstHalf.map(function(v){return v.montant}));
      var avg2 = mean(secondHalf.map(function(v){return v.montant}));
      if(avg1 > 0){
        var pct = (avg2 - avg1) / avg1;
        if(pct < -0.25){
          scoreB = 20;
          factors.push('Panier en chute libre (' + Math.round(pct*100) + '%)');
        } else if(pct < -0.10){
          scoreB = 12;
          factors.push('Panier moyen en baisse (' + Math.round(pct*100) + '%)');
        } else if(pct < 0.10){
          scoreB = 3;
        } else {
          scoreB = 0;
          factors.push('Panier en hausse (+' + Math.round(pct*100) + '%)');
        }
      }
    }

    // ── C. Régularité (0-15) ──
    var scoreC = 0;
    if(interval && interval.intervals && interval.intervals.length >= 3){
      var cv = stdDev(interval.intervals) / Math.max(1, interval.mean);
      if(cv > 1.2){
        scoreC = 12;
        factors.push('Visites très irrégulières');
      } else if(cv > 0.8){
        scoreC = 6;
      }
    }

    // ── D. Ancienneté × profondeur (0-15) ──
    var scoreD = 0;
    var ageMonths = daysSince(client.createdAt) / 30.4;
    if(visits.length < 3 && ageMonths > 2){
      scoreD = 10;
      factors.push('Peu de visites (' + visits.length + ') après ' + Math.round(ageMonths) + ' mois');
    } else if(visits.length >= 10 && retardRatio > 1.5){
      scoreD = 15;
      factors.push('Fidèle de longue date (' + visits.length + ' visites) qui décroche');
    } else if(visits.length >= 5 && retardRatio > 2){
      scoreD = 8;
      factors.push('Client établi qui s\u2019éloigne');
    }

    // ── E. Inactivité absolue (0-10) ──
    var scoreE = 0;
    if(daysSinceLast > 180){
      scoreE = 10;
      factors.push('Plus de 6 mois sans visite');
    } else if(daysSinceLast > 120){
      scoreE = 6;
    } else if(daysSinceLast > 90){
      scoreE = 3;
    }

    // ── F. Bonus combiné : retard + panier en baisse (signal très fort, 0-5) ──
    var scoreF = 0;
    if(scoreA >= 28 && scoreB >= 12){
      scoreF = 5;
    }

    var total = clamp(Math.round(scoreA + scoreB + scoreC + scoreD + scoreE + scoreF), 0, 100);
    var level = total >= 61 ? 'high' : total >= 31 ? 'medium' : 'low';

    return { score: total, level: level, factors: factors };
  }

  // ═══════════════════════════════════════════════════════════
  //  2. LTV PRÉDITE (Customer Lifetime Value sur 12 mois)
  // ═══════════════════════════════════════════════════════════

  /**
   * Retourne { value: €, trend: 'up'|'stable'|'down', confidence: 'low'|'medium'|'high', avgBasket, yearlyVisits }
   *
   * Formule : LTV12 = panierMoyen × fréquenceAnnuelle × (1 - churn/100)
   * Bornée à 2× le CA réalisé sur les 12 derniers mois pour éviter projections folles.
   */
  function computeLTV(client, churnScore){
    if(!client) return { value: 0, trend: 'stable', confidence: 'low', avgBasket: 0, yearlyVisits: 0 };

    var visits = getVisits(client);
    if(visits.length === 0) return { value: 0, trend: 'stable', confidence: 'low', avgBasket: 0, yearlyVisits: 0 };

    var withMontant = [];
    for(var i=0;i<visits.length;i++){
      if(visits[i].montant > 0) withMontant.push(visits[i]);
    }
    if(withMontant.length === 0) return { value: 0, trend: 'stable', confidence: 'low', avgBasket: 0, yearlyVisits: 0 };

    var panierMoyen = mean(withMontant.map(function(v){return v.montant}));

    // Fréquence annuelle estimée
    var freqAnnuelle;
    if(visits.length >= 2){
      var interval = avgInterval(visits);
      var med = interval && interval.median ? interval.median : 30;
      if(med < 7) med = 7;
      freqAnnuelle = 365 / med;
    } else {
      freqAnnuelle = 2;
    }

    // Rétention basée sur churn
    var churn = (churnScore != null) ? churnScore : 50;
    var retention = (100 - churn) / 100;

    // LTV brute
    var ltv = panierMoyen * freqAnnuelle * retention;

    // Bornage : pas plus que 2× ce qu'il a dépensé sur les 12 derniers mois
    var oneYearAgo = new Date(Date.now() - 365*86400000);
    var spent12mo = 0;
    for(var j=0;j<withMontant.length;j++){
      if(withMontant[j].date >= oneYearAgo) spent12mo += withMontant[j].montant;
    }
    if(spent12mo > 0){
      ltv = Math.min(ltv, spent12mo * 2);
    }

    // Trend
    var trend = 'stable';
    if(withMontant.length >= 4){
      var n2 = withMontant.length;
      var midT = Math.floor(n2/2);
      var avg1 = mean(withMontant.slice(0, midT).map(function(v){return v.montant}));
      var avg2 = mean(withMontant.slice(midT).map(function(v){return v.montant}));
      if(avg1 > 0){
        var pct = (avg2 - avg1) / avg1;
        if(pct > 0.12) trend = 'up';
        else if(pct < -0.12) trend = 'down';
      }
    }

    var confidence = visits.length >= 5 ? 'high' : visits.length >= 2 ? 'medium' : 'low';

    return {
      value: Math.max(0, Math.round(ltv)),
      trend: trend,
      confidence: confidence,
      avgBasket: Math.round(panierMoyen*100)/100,
      yearlyVisits: Math.round(freqAnnuelle*10)/10
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  3. NEXT BEST ACTION (moteur de règles expert)
  // ═══════════════════════════════════════════════════════════

  /**
   * Retourne { id, icon, label, desc, urgency, action }
   *
   * Urgency :
   *   'critical'  → rouge vif, action urgente (risque de perte forte valeur)
   *   'important' → orange, action à planifier (anniv, welcome-back, palier)
   *   'normal'    → bleu, action opportune (remerciement, upsell)
   *   'low'       → gris, pas d'action ou veille passive
   *
   * Action : { type: 'sms_coupon'|'sms_welcome'|'sms_soft'|'sms_thanks'|'sms_last_stamp'|'sms_milestone'|'sms_anniv_inscription'|'bday_bonus'|'none', ... }
   */
  function computeNBA(client, cfg, churn, ltv){
    if(!client) return { id:'veille', icon:'👀', label:'Veille', desc:'', urgency:'low', action:{type:'none'} };

    var visits = getVisits(client);
    var now = Date.now();
    var daysSinceLast = visits.length
      ? Math.floor((now - visits[visits.length-1].date.getTime())/86400000)
      : 9999;
    var ageDays = daysSince(client.createdAt);
    var nbVisits = visits.length;
    var ltvVal = ltv ? ltv.value : 0;
    var churnScore = churn ? churn.score : 50;

    // Proximité anniversaire
    var daysToBday = null;
    if(client.birthday){
      var bday = toDate(client.birthday);
      if(bday){
        var nowD = new Date();
        var nextBday = new Date(nowD.getFullYear(), bday.getMonth(), bday.getDate());
        if(nextBday < nowD) nextBday.setFullYear(nowD.getFullYear()+1);
        daysToBday = Math.floor((nextBday - nowD)/86400000);
      }
    }

    var cfgT = parseInt(cfg && cfg.tampons) || 10;
    var currentT = parseInt(client.tampons) || 0;
    var tamponsToReward = cfgT - currentT;

    // ═══ PRIORITÉ 1 — CRITIQUES (rouge) ═══

    if(churnScore >= 70 && ltvVal >= 200){
      return {
        id: 'reconquete_vip',
        icon: '🚨',
        label: 'Reconquête VIP urgente',
        desc: 'Client à forte valeur (' + ltvVal + '€/an) en train de décrocher. Action rapide recommandée.',
        urgency: 'critical',
        action: { type: 'sms_coupon', pct: 30, template: 'reconquete_vip' }
      };
    }

    if(churnScore >= 70 && ltvVal >= 50){
      return {
        id: 'reconquete',
        icon: '⚠️',
        label: 'À relancer',
        desc: 'Risque élevé de perte. Un SMS + coupon ciblé peut inverser la tendance.',
        urgency: 'critical',
        action: { type: 'sms_coupon', pct: 20, template: 'reconquete' }
      };
    }

    // ═══ PRIORITÉ 2 — IMPORTANTES (orange) ═══

    if(daysToBday !== null && daysToBday <= 7 && daysToBday >= 0){
      return {
        id: 'anniversaire',
        icon: '🎂',
        label: daysToBday === 0 ? 'Anniversaire aujourd\u2019hui' : 'Anniversaire dans ' + daysToBday + 'j',
        desc: 'Bonus anniversaire de ' + ((cfg && cfg.bdayPts) || 200) + ' points prêt à offrir.',
        urgency: 'important',
        action: { type: 'bday_bonus', pts: parseInt(cfg && cfg.bdayPts) || 200 }
      };
    }

    if(ageDays >= 14 && ageDays <= 45 && nbVisits <= 1){
      return {
        id: 'welcome_back',
        icon: '👋',
        label: 'Inviter à revenir',
        desc: 'Inscrit il y a ' + ageDays + 'j, ' + (nbVisits === 0 ? 'jamais venu' : 'une seule visite') + '. SMS welcome-back avec bonus découverte.',
        urgency: 'important',
        action: { type: 'sms_welcome', pts: 100 }
      };
    }

    if(tamponsToReward === 1 && cfgT > 1 && daysSinceLast < 45){
      return {
        id: 'palier_proche',
        icon: '🎯',
        label: 'Plus qu\u2019un tampon !',
        desc: 'Un SMS qui rappelle qu\u2019un passage suffit pour ' + ((cfg && cfg.reward) || 'la récompense') + '.',
        urgency: 'important',
        action: { type: 'sms_last_stamp' }
      };
    }

    if(churnScore >= 45 && churnScore < 70 && ltvVal >= 80){
      return {
        id: 'prevention',
        icon: '🔔',
        label: 'Prévention',
        desc: 'Début de décrochage détecté. Un SMS chaleureux sans coupon peut suffire.',
        urgency: 'important',
        action: { type: 'sms_soft' }
      };
    }

    // ═══ PRIORITÉ 3 — NORMALES (bleu) ═══

    if(churnScore < 30 && ltvVal >= 300 && nbVisits >= 8){
      return {
        id: 'fideliser_vip',
        icon: '🤝',
        label: 'Remercier / Fidéliser',
        desc: 'Excellent client fidèle. Un remerciement ou une attention surprise entretient la relation.',
        urgency: 'normal',
        action: { type: 'sms_thanks' }
      };
    }

    if(tamponsToReward === 2 && cfgT > 2 && daysSinceLast < 30){
      return {
        id: 'palier_bientot',
        icon: '🎁',
        label: 'Bientôt récompensé',
        desc: 'Plus que 2 tampons avant ' + ((cfg && cfg.reward) || 'la récompense') + '. Rappel doux possible.',
        urgency: 'normal',
        action: { type: 'sms_soft' }
      };
    }

    if(nbVisits > 0 && (nbVisits === 25 || nbVisits === 50 || nbVisits === 100 || nbVisits === 200)){
      return {
        id: 'milestone',
        icon: '🏆',
        label: nbVisits + 'e visite !',
        desc: 'Moment de vie à célébrer — SMS ou attention personnalisée.',
        urgency: 'normal',
        action: { type: 'sms_milestone', count: nbVisits }
      };
    }

    // Anniversaire d'inscription (± 7j autour de la date)
    if(ageDays >= 358){
      var anniMod = ageDays % 365;
      if(anniMod <= 7 || anniMod >= 358){
        var years = Math.max(1, Math.round(ageDays/365));
        return {
          id: 'anciennete',
          icon: '📅',
          label: years + ' an' + (years>1?'s':'') + ' avec vous',
          desc: 'Date anniversaire d\u2019inscription — moment idéal pour remercier.',
          urgency: 'normal',
          action: { type: 'sms_anniv_inscription', years: years }
        };
      }
    }

    // ═══ PRIORITÉ 4 — LOW (gris) ═══

    if(churnScore >= 70 && ltvVal < 50){
      return {
        id: 'laisser',
        icon: '💤',
        label: 'Laisser respirer',
        desc: 'Faible valeur et peu de chances de retour rentable. Pas d\u2019action recommandée.',
        urgency: 'low',
        action: { type: 'none' }
      };
    }

    if(churnScore < 35){
      return {
        id: 'sain',
        icon: '✅',
        label: 'Tout va bien',
        desc: 'Client régulier, aucune action nécessaire pour l\u2019instant.',
        urgency: 'low',
        action: { type: 'none' }
      };
    }

    return {
      id: 'veille',
      icon: '👀',
      label: 'Veille',
      desc: 'Surveiller l\u2019évolution sur les prochaines visites.',
      urgency: 'low',
      action: { type: 'none' }
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  4. COMPUTE ALL (helper pratique, try/catch)
  // ═══════════════════════════════════════════════════════════

  function computeAll(client, cfg){
    var churn, ltv, nba;
    try { churn = computeChurn(client); }
    catch(e){ churn = { score:0, level:'low', factors:['Erreur calcul'] }; }

    try { ltv = computeLTV(client, churn.score); }
    catch(e){ ltv = { value:0, trend:'stable', confidence:'low', avgBasket:0, yearlyVisits:0 }; }

    try { nba = computeNBA(client, cfg, churn, ltv); }
    catch(e){ nba = { id:'error', icon:'❓', label:'—', desc:'', urgency:'low', action:{type:'none'} }; }

    return { churn: churn, ltv: ltv, nba: nba };
  }

  // ═══════════════════════════════════════════════════════════
  //  5. RANK BY RISK (tri par priorité d'action)
  // ═══════════════════════════════════════════════════════════

  /**
   * priorityScore = churn × log(LTV+10) × urgencyMultiplier
   * Un client à churn 80 + LTV 300€ + critical ressort devant un churn 90 + LTV 20€ + low.
   */
  function rankByRisk(clients, cfg){
    if(!clients || !clients.length) return [];
    var urgencyMult = { critical: 3.0, important: 1.8, normal: 1.0, low: 0.3 };
    var out = [];
    for(var i=0;i<clients.length;i++){
      var c = clients[i];
      var all = computeAll(c, cfg);
      var mult = urgencyMult[all.nba.urgency] || 1;
      var priority = (all.churn.score * Math.log(all.ltv.value + 10)) * mult;
      out.push({
        client: c,
        churn: all.churn,
        ltv: all.ltv,
        nba: all.nba,
        priorityScore: priority
      });
    }
    out.sort(function(a,b){ return b.priorityScore - a.priorityScore; });
    return out;
  }

  // ═══════════════════════════════════════════════════════════
  //  EXPORT
  // ═══════════════════════════════════════════════════════════

  window._FidAI = {
    computeChurn: computeChurn,
    computeLTV: computeLTV,
    computeNBA: computeNBA,
    computeAll: computeAll,
    rankByRisk: rankByRisk,
    version: '1.0.0'
  };

  if(typeof console !== 'undefined' && console.log){
    console.log('[FidAI] v1.0.0 loaded — scoring ready');
  }
})();
