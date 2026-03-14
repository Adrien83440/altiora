// ── onboarding.js — Alteore ── v2
// Checklist dashboard + tours guidés TOUS modules + sous-modules RH & fidélisation
// 100% overlay — ne modifie AUCUN fichier existant
// Chargé via nav.js · Si crash → meurt silencieusement
try { (function () {

  var PAGE = location.pathname.split('/').pop() || 'dashboard.html';
  var CHECKLIST_DAYS = 7;

  // ════════════════════════════════════════════════
  // FIREBASE COMPAT
  // ════════════════════════════════════════════════
  function _gd() { return window._getDoc || window._fbGetDoc; }
  function _sd() { return window._setDoc || window._fbSetDoc; }
  function _dc() { return window._doc    || window._fbDoc; }

  // ════════════════════════════════════════════════
  // CHECKLIST
  // ════════════════════════════════════════════════
  var STEPS = [
    { id:'profil',   icon:'🏢', title:'Complétez votre profil entreprise',  desc:'Nom, secteur, ville — pour personnaliser votre espace.',   link:'profil.html',       cta:'Compléter →' },
    { id:'ca',       icon:'📈', title:'Saisissez votre CA du mois',         desc:'Entrez vos recettes journalières dans le pilotage.',       link:'pilotage.html',     cta:'Saisir →' },
    { id:'charges',  icon:'💰', title:'Ajoutez vos charges',                desc:'Charges fixes et variables pour calculer votre résultat.', link:'pilotage.html',     cta:'Ajouter →' },
    { id:'produit',  icon:'🧮', title:'Créez votre premier produit',        desc:'Calculez votre coût de revient et votre marge.',           link:'cout-revient.html', cta:'Créer →' },
    { id:'dashboard',icon:'📊', title:'Explorez votre tableau de bord',     desc:'Découvrez vos KPIs, graphiques et l\'analyse IA.',         link:'dashboard.html',    cta:'Explorer →' },
  ];

  // ════════════════════════════════════════════════
  // TOURS — TOUS LES MODULES
  // ════════════════════════════════════════════════
  var TOURS = {

    // ── CORE ──
    'dashboard.html':     { id:'tour_dashboard',    delay:5500, title:'📊 Tableau de bord', steps:[
      { target:'#copilote-widget',                title:'Copilote IA',              text:'Votre assistant intelligent analyse vos données et vous donne des conseils personnalisés chaque jour.', pos:'bottom' },
      { target:'.kpi-grid-5',                     title:'KPIs en un coup d\'œil',   text:'CA, charges, résultat, marge et cashflow. Tout se met à jour automatiquement à partir de vos saisies.', pos:'bottom' },
      { target:'.topbar-right .btn-primary',      title:'Commencez ici !',          text:'Cliquez ce bouton pour saisir vos premières données dans le pilotage.', pos:'bottom' },
    ]},

    'pilotage.html':      { id:'tour_pilotage',     delay:4500, title:'🧭 Pilotage financier', steps:[
      { target:'#kpi-summary',   title:'Vos 5 indicateurs clés',   text:'CA, charges, résultat, TVA collectée et TVA due. Ces 5 chiffres se mettent à jour en temps réel à chaque saisie. C\'est la synthèse de votre mois.', pos:'bottom' },
      { target:'#htTtcToggle',   title:'Mode HT ou TTC',           text:'Basculez entre Hors Taxes et Toutes Taxes Comprises selon votre habitude. Toute la page s\'adapte. La plupart des commerçants saisissent en TTC.', pos:'bottom' },
      { target:'#s-ca',          title:'Chiffre d\'affaires',       text:'Votre CA du mois se calcule automatiquement depuis vos saisies journalières dans le tableau ci-dessous. Il inclut le CA journalier et les factures pro.', pos:'bottom' },
      { target:'#ca-tbody tr:first-child,#tot-caHT', title:'Saisie jour par jour', text:'Chaque ligne correspond à un jour du mois. Saisissez votre CA par taux de TVA (5.5%, 10%, 20%). Les totaux se calculent automatiquement. Utilisez Tab pour aller vite.', pos:'bottom' },
      { target:'#s-ch',          title:'Vos charges',               text:'Le total de toutes vos dépenses : fixes (loyer, assurance…) + variables (achats, matières…) + crédits et leasing. Descendez pour les saisir.', pos:'bottom' },
      { target:'#tot-fixHT,#cf-tbody tr:first-child', title:'Charges fixes', text:'Loyer, assurances, salaires, abonnements… Les charges récurrentes chaque mois. Cliquez "+ Ligne" pour en ajouter. Elles se pré-remplissent le mois suivant.', pos:'top' },
      { target:'#tot-varHT,#cv-tbody tr:first-child', title:'Charges variables', text:'Achats de matières premières, frais ponctuels, sous-traitance… Tout ce qui varie. Ajoutez-les au fil de l\'eau.', pos:'top' },
      { target:'#s-res',         title:'Votre résultat',            text:'CA moins charges = résultat. Vert = bénéficiaire. Rouge = les charges dépassent les recettes. C\'est LE chiffre à surveiller chaque mois.', pos:'bottom' },
    ]},

    'suivi-ca.html':      { id:'tour_suivi',        delay:5500, title:'📈 Suivi CA & Résultats', steps:[
      { target:'#yearSelect',    title:'Sélection de l\'année',    text:'Naviguez entre les années pour comparer vos performances.', pos:'bottom' },
      { target:'#chartCA',       title:'Évolution du CA',          text:'Votre CA mois par mois. Survolez les barres pour les détails.', pos:'bottom' },
      { target:'#compCard',      title:'Comparaison N / N-1',      text:'Comparez deux mois ou années pour identifier vos tendances.', pos:'top' },
    ]},

    'cout-revient.html':  { id:'tour_cout',         delay:3000, title:'🧮 Coût de revient', steps:[
      { target:'.left-panel',    title:'Catalogue',                text:'Vos produits et fournisseurs. Cliquez sur un produit pour sa fiche détaillée.', pos:'bottom' },
      { target:'.lp-tabs',       title:'Produits & Fournisseurs',  text:'Basculez entre produits et fournisseurs. Chaque fournisseur peut être lié à des articles.', pos:'bottom' },
      { target:'.topbar-right .btn-primary', title:'Créer un produit', text:'Renseignez ingrédients, main d\'œuvre et charges pour calculer le coût exact.', pos:'bottom' },
    ]},

    'marges.html':        { id:'tour_marges',       delay:2000, title:'📊 Marges brute & nette', steps:[
      { target:'#productList',   title:'Vos produits',             text:'Les produits du coût de revient apparaissent ici. Sélectionnez-en un pour analyser ses marges.', pos:'bottom' },
      { target:'.topbar-right .btn-primary', title:'Ajouter un produit', text:'Créez un produit directement ici avec ses coûts pour calculer sa marge.', pos:'bottom' },
    ]},

    'panier-moyen.html':  { id:'tour_panier',       delay:2000, title:'🛒 Panier moyen', steps:[
      { target:'#monthStrip',    title:'Sélecteur de mois',        text:'Choisissez le mois à saisir ou consulter.', pos:'bottom' },
      { target:'.fields-grid',   title:'Saisie',                   text:'Nombre de clients, CA et ventes. Les calculs sont automatiques.', pos:'bottom' },
      { target:'.results-row',   title:'Résultats',                text:'Panier par vente, par client, valeur client et évolution.', pos:'top' },
    ]},

    'dettes.html':        { id:'tour_dettes',       delay:3000, title:'🏦 Dettes & Emprunts', steps:[
      { target:'.tb-r .btn-p, .topbar .btn-primary', title:'Ajouter une dette', text:'Emprunts, crédits, LOA… L\'échéancier se génère automatiquement.', pos:'bottom' },
      { target:'#calGrid',       title:'Calendrier échéances',     text:'Visualisez mois par mois. Les périodes critiques sont colorées.', pos:'bottom' },
      { target:'#detteGrid',     title:'Fiches dettes',            text:'Montant restant, progression et prochaine échéance pour chaque dette.', pos:'top' },
    ]},

    'cashflow.html':      { id:'tour_cashflow',     delay:3500, title:'💧 Cashflow', steps:[
      { target:'.kpi-row',       title:'Indicateurs trésorerie',   text:'Solde initial, entrées, sorties et solde final. Calculé depuis vos saisies pilotage.', pos:'bottom' },
      { target:'#prevChart',     title:'Graphique prévisionnel',   text:'Évolution mois par mois de votre trésorerie sur l\'année.', pos:'bottom' },
      { target:'#yearSelect',    title:'Navigation',               text:'Comparez les années pour anticiper les périodes difficiles.', pos:'bottom' },
    ]},

    'gestion-stock.html': { id:'tour_stock',        delay:3000, title:'📦 Gestion des stocks', steps:[
      { target:'#kpi-row',       title:'KPIs stock',               text:'Valeur du stock, références, alertes rupture et mouvements récents.', pos:'bottom' },
      { target:'#tabs',          title:'Onglets',                  text:'Catalogue produits, mouvements d\'entrée/sortie et historique.', pos:'bottom' },
      { target:'.tb-r .btn-primary, .topbar .btn-primary', title:'Ajouter un produit', text:'Créez vos références avec quantité, seuil d\'alerte et prix.', pos:'bottom' },
    ]},

    // ── FIDÉLISATION (page unique avec onglets) ──
    'fidelisation.html':  { id:'tour_fidelite',     delay:2500, title:'💎 Fidélisation client', steps:[
      { target:'[data-tab="dashboard"]', title:'Dashboard',         text:'Vue d\'ensemble : clients, points, coupons actifs et campagnes.', pos:'bottom' },
      { target:'[data-tab="clients"]',   title:'Clients',           text:'Ajoutez vos clients manuellement ou via tablette. Chaque client a sa fiche et son historique.', pos:'bottom' },
      { target:'[data-tab="carte"]',     title:'Carte fidélité',    text:'Configurez votre carte digitale : logo, couleurs, barème de points. Visible sur le téléphone.', pos:'bottom' },
      { target:'[data-tab="points"]',    title:'Points & Récompenses', text:'Définissez combien de points par euro dépensé, les bonus anniversaire et les paliers VIP.', pos:'bottom' },
      { target:'[data-tab="coupons"]',   title:'Coupons & Offres',  text:'Créez des coupons de réduction, offres limitées dans le temps pour inciter les achats.', pos:'bottom' },
      { target:'[data-tab="campagnes"]', title:'Campagnes SMS',     text:'Envoyez des SMS ciblés : promotions, anniversaires, relances. Achetez des crédits dans la boutique.', pos:'bottom' },
      { target:'[data-tab="config"]',    title:'Configuration',     text:'Nom de la boutique, expéditeur SMS, code tablette et lien d\'inscription client.', pos:'bottom' },
    ]},

    // ── RH : chaque sous-page a son tour ──
    'rh-dashboard.html':  { id:'tour_rh_dash',      delay:2500, title:'👥 Dashboard RH', steps:[
      { target:'#kpi-row',                          title:'KPIs Équipe',         text:'Effectif, masse salariale, congés en cours et alertes.', pos:'bottom' },
      { target:'button[onclick*="rh-employes"]',    title:'Fiches employés',     text:'Accédez aux fiches de chaque salarié pour gérer contrats, horaires et documents.', pos:'bottom' },
      { target:'button[onclick*="rh-conges"]',      title:'Congés',              text:'Validez les demandes de congés de vos employés en un clic.', pos:'bottom' },
      { target:'button[onclick*="rh-recrutement"]', title:'Recrutement',         text:'Publiez des offres et suivez les candidatures.', pos:'bottom' },
    ]},

    'rh-employes.html':   { id:'tour_rh_emp',       delay:2500, title:'👤 Employés & Fiches', steps:[
      { target:'#search-emp',               title:'Recherche',            text:'Recherchez un employé par nom, prénom ou poste.', pos:'bottom' },
      { target:'#filter-contrat',           title:'Filtres',              text:'Filtrez par type de contrat, département ou statut pour retrouver rapidement un salarié.', pos:'bottom' },
      { target:'#emp-list',                 title:'Liste des employés',   text:'Cliquez sur un employé pour ouvrir sa fiche complète : infos, contrat, salaire, documents.', pos:'bottom' },
      { target:'button[onclick*="openModalNouvelEmploye"]', title:'Ajouter un employé', text:'Créez une fiche pour un nouveau salarié. La CCN est recherchée automatiquement.', pos:'bottom' },
    ]},

    'rh-planning.html':   { id:'tour_rh_plan',      delay:3000, title:'📅 Planning', steps:[
      { target:'#week-label',               title:'Navigation semaine',   text:'Naviguez entre les semaines. Le planning se met à jour automatiquement.', pos:'bottom' },
      { target:'#vtab-mois',                title:'Vue mois',             text:'Basculez entre vue semaine, timeline et mois pour visualiser le planning.', pos:'bottom' },
      { target:'button[onclick*="openPolyPanel"]', title:'Créneaux polyvalents', text:'Créez des créneaux et assignez-les par glisser-déposer aux employés.', pos:'bottom' },
    ]},

    'rh-conges.html':     { id:'tour_rh_conges',    delay:2500, title:'🌴 Congés', steps:[
      { target:'#kpi-row',                  title:'Soldes & stats',       text:'Soldes de congés, jours pris, en attente et taux d\'absence en un coup d\'œil.', pos:'bottom' },
      { target:'#tab-soldes',               title:'Soldes par employé',   text:'Consultez les compteurs de chaque salarié : acquis, pris, restants.', pos:'bottom' },
      { target:'button[onclick*="openNewDemandeModal"]', title:'Nouvelle demande', text:'Créez une demande de congé pour un employé. Il sera notifié automatiquement.', pos:'bottom' },
    ]},

    'rh-temps.html':      { id:'tour_rh_temps',     delay:2500, title:'⏱ Temps de travail', steps:[
      { target:'#mois-label',               title:'Mois en cours',        text:'Naviguez entre les mois pour voir les heures travaillées par chaque salarié.', pos:'bottom' },
      { target:'#mois-stats',               title:'Statistiques',         text:'Heures réelles vs théoriques, heures supplémentaires et dépassements.', pos:'bottom' },
      { target:'button[onclick*="openSaisie"]', title:'Saisie manuelle', text:'Ajoutez des heures manuellement si le pointage automatique n\'est pas activé.', pos:'bottom' },
    ]},

    'rh-paie.html':       { id:'tour_rh_paie',      delay:2500, title:'💶 Paie & Salaires', steps:[
      { target:'#moisLabel',                title:'Mois de paie',         text:'Sélectionnez le mois pour voir les bulletins indicatifs de chaque salarié.', pos:'bottom' },
      { target:'#moisStats',                title:'Statistiques paie',    text:'Nombre de fiches payées, en attente et masse salariale totale du mois.', pos:'bottom' },
      { target:'button[onclick*="rh-dirigeant"]', title:'Rémunération dirigeant', text:'Accédez au simulateur de rémunération dirigeant (TNS, assimilé salarié…).', pos:'bottom' },
    ]},

    'rh-dirigeant.html':  { id:'tour_rh_dirig',     delay:2500, title:'👔 Rémunération dirigeant', steps:[
      { target:'#statutGrid',               title:'Statut juridique',     text:'Choisissez votre statut : TNS, assimilé salarié, auto-entrepreneur… Les cotisations s\'adaptent.', pos:'bottom' },
      { target:'#tab-mensuel',              title:'Simulation mensuelle', text:'Saisissez votre rémunération nette souhaitée. Le coût total employeur est calculé automatiquement.', pos:'bottom' },
      { target:'#tab-annuel',               title:'Vue annuelle',         text:'Projetez votre rémunération sur 12 mois avec le coût annuel total pour l\'entreprise.', pos:'bottom' },
    ]},

    'rh-objectifs.html':  { id:'tour_rh_obj',       delay:2500, title:'🎯 Objectifs & Primes', steps:[
      { target:'#kpi-row',                  title:'KPIs objectifs',       text:'Objectifs en cours, taux d\'atteinte moyen, primes à verser et coût pour l\'entreprise.', pos:'bottom' },
      { target:'button[onclick*="openCreateModal"]', title:'Créer un objectif', text:'Définissez un objectif avec critères, échéance et prime associée. Assignez-le à un ou plusieurs employés.', pos:'bottom' },
    ]},

    'rh-recrutement.html':{ id:'tour_rh_recru',     delay:2500, title:'📋 Recrutement', steps:[
      { target:'#tab-pipeline',             title:'Pipeline',             text:'Visualisez vos candidats par étape : candidature, entretien, test, offre, embauché.', pos:'bottom' },
      { target:'button[onclick*="modal-offre"]', title:'Nouvelle offre', text:'Créez une offre d\'emploi avec description, compétences requises et conditions.', pos:'bottom' },
      { target:'button[onclick*="modal-candidat"]', title:'Ajouter un candidat', text:'Enregistrez un candidat reçu spontanément ou depuis une annonce.', pos:'bottom' },
    ]},

    'rh-onboarding.html': { id:'tour_rh_onb',       delay:2500, title:'🚀 Onboarding / Offboarding', steps:[
      { target:'button[onclick*="modal-on"]',  title:'Nouvel onboarding',  text:'Lancez le processus d\'intégration d\'un nouveau salarié avec une checklist personnalisée.', pos:'bottom' },
      { target:'button[onclick*="modal-off"]', title:'Offboarding',        text:'Gérez le départ d\'un salarié : restitution matériel, documents, solde de tout compte.', pos:'bottom' },
      { target:'#right-panel',              title:'Suivi du dossier',     text:'Suivez l\'avancement de chaque dossier étape par étape.', pos:'bottom' },
    ]},

    'rh-entretiens.html': { id:'tour_rh_entretiens', delay:2500, title:'💬 Entretiens annuels', steps:[
      { target:'#emp-list',                 title:'Sélection employé',    text:'Choisissez un employé pour créer ou consulter son entretien annuel.', pos:'bottom' },
      { target:'button[onclick*="openNewEntretien"]', title:'Nouvel entretien', text:'Créez un entretien avec grille d\'évaluation, objectifs et commentaires.', pos:'bottom' },
    ]},

    'rh-conformite.html': { id:'tour_rh_conf',      delay:2500, title:'⚖️ Conformité & Légal', steps:[
      { target:'#main-content',             title:'Votre checklist légale', text:'Vérifiez point par point que votre entreprise est en règle : affichages, registres, documents obligatoires.', pos:'bottom' },
      { target:'#autosave-status',          title:'Sauvegarde auto',      text:'Vos réponses sont sauvegardées automatiquement. Reprenez à tout moment.', pos:'bottom' },
    ]},

    'rh-modeles.html':    { id:'tour_rh_modeles',   delay:2500, title:'📄 Modèles de documents', steps:[
      { target:'#themesGrid',               title:'Thèmes disponibles',   text:'Parcourez les modèles par catégorie : contrats, avenants, attestations, courriers…', pos:'bottom' },
      { target:'#searchInput',              title:'Recherche',            text:'Recherchez un modèle par mot-clé. Les modèles sont générés par IA avec vos données.', pos:'bottom' },
    ]},

    'rh-contrats.html':   { id:'tour_rh_contrats',  delay:2500, title:'📝 Contrats de travail', steps:[
      { target:'#histList',                 title:'Historique',           text:'Retrouvez tous les contrats déjà générés. Cliquez pour les consulter ou les modifier.', pos:'bottom' },
      { target:'button[onclick*="startNewContract"]', title:'Nouveau contrat', text:'L\'assistant IA vous guide en 6 étapes : type de contrat, infos salarié, clauses, génération.', pos:'bottom' },
    ]},

    'rh-pointages.html':  { id:'tour_rh_point',     delay:2500, title:'⏰ Pointages', steps:[
      { target:'#vt-jour',                  title:'Vue jour',             text:'Visualisez les pointages du jour : arrivées, départs, pauses pour chaque salarié.', pos:'bottom' },
      { target:'#vt-salarie',               title:'Vue salarié',         text:'Consultez l\'historique de pointage d\'un employé spécifique.', pos:'bottom' },
      { target:'#vt-recap',                 title:'Récapitulatif',        text:'Tableau synthétique des heures par employé sur la période.', pos:'bottom' },
    ]},

    'rh-emargements.html':{ id:'tour_rh_emarg',     delay:2500, title:'✍️ Émargements', steps:[
      { target:'#vt-daily',                 title:'Émargement quotidien', text:'Feuille d\'émargement du jour. Les employés signent depuis leur espace.', pos:'bottom' },
      { target:'#vt-fiches',                title:'Fiches mensuelles',    text:'Fiches d\'émargement mensuelles à faire signer. Valeur légale en cas de contrôle.', pos:'bottom' },
      { target:'#vt-audit',                 title:'Piste d\'audit',       text:'Historique horodaté de toutes les signatures. Preuve opposable en cas d\'inspection.', pos:'bottom' },
    ]},

    'rh-urgence.html':    { id:'tour_rh_urgence',   delay:2000, title:'🚨 Urgence Contrôle', steps:[
      { target:'#hero-stats',               title:'Score de préparation', text:'Nombre de documents prêts, points vérifiés et temps estimé de préparation.', pos:'bottom' },
      { target:'#ctrl-selector',            title:'Type de contrôle',     text:'Sélectionnez le type de contrôle (Inspection du travail, URSSAF…) pour voir la checklist adaptée.', pos:'bottom' },
    ]},

  };

  // ════════════════════════════════════════════════
  // FIREBASE HELPERS
  // ════════════════════════════════════════════════
  function waitReady(cb, n) {
    n = n || 0;
    if (window._uid && window._db && (_gd()) && (_sd())) { try { cb(); } catch(e) {} }
    else if (n < 40) setTimeout(function () { waitReady(cb, n + 1); }, 150);
  }

  function loadProgress(cb) {
    try { _gd()(_dc()(window._db, 'tuto_progress', window._uid))
      .then(function (s) { cb(s.exists() ? s.data() : {}); })
      .catch(function () { cb({}); });
    } catch(e) { cb({}); }
  }

  function saveField(k, v) {
    try { var d = {}; d[k] = v;
      _sd()(_dc()(window._db, 'tuto_progress', window._uid), d, { merge: true }).catch(function () {});
    } catch(e) {}
  }

  // ════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════
  waitReady(function () {
    loadProgress(function (progress) {
      try { if (PAGE === 'dashboard.html') injectChecklist(progress); } catch(e) {}
      try { if (TOURS[PAGE]) maybeTour(progress); } catch(e) {}
    });
  });

  // ════════════════════════════════════════════════
  // AUTO-CHECK
  // ════════════════════════════════════════════════
  waitReady(function () {
    try {
      if (PAGE === 'profil.html') _gd()(_dc()(window._db,'profil',window._uid,'data','profil'))
        .then(function(s){if(s.exists()&&s.data().nom)saveField('step_profil',true);}).catch(function(){});
      if (PAGE === 'pilotage.html') setTimeout(function(){saveField('step_ca',true);saveField('step_charges',true);},8000);
      if (PAGE === 'cout-revient.html') setTimeout(function(){saveField('step_produit',true);},5000);
      if (PAGE === 'dashboard.html') setTimeout(function(){saveField('step_dashboard',true);},8000);
    } catch(e) {}
  });

  // ════════════════════════════════════════════════
  // CHECKLIST (dashboard, sibling de mainContent)
  // ════════════════════════════════════════════════
  function injectChecklist(progress) {
    if (progress.checklistDismissed) return;
    _gd()(_dc()(window._db,'users',window._uid)).then(function(snap){
      if(!snap.exists())return;var d=snap.data(),created=d.createdAt;
      if(created){var cd=created.toDate?created.toDate():new Date(created);if((Date.now()-cd.getTime())/864e5>CHECKLIST_DAYS)return;}
      try{renderChecklist(progress);}catch(e){}
    }).catch(function(){});
  }

  function renderChecklist(progress) {
    var c=0;STEPS.forEach(function(s){if(progress['step_'+s.id])c++;});
    var done=c===STEPS.length,pct=Math.round(c/STEPS.length*100);
    var el=document.createElement('div');el.id='onboarding-checklist';
    el.style.cssText='padding:0 32px;animation:obFadeIn .4s ease';
    el.innerHTML=
      '<div style="margin:20px 0;background:#fff;border:2px solid '+(done?'#86efac':'#c7d2fe')+';border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(15,31,92,.06)">'+
        '<div style="padding:20px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;background:'+(done?'linear-gradient(135deg,#f0fdf4,#ecfdf5)':'linear-gradient(135deg,#f0f4ff,#f5f7ff)')+'">'+ '<div><div style="font-size:16px;font-weight:800;color:#0f1f5c;display:flex;align-items:center;gap:8px">'+(done?'🎉 Bravo, tout est configuré !':'🚀 Premiers pas avec Alteore')+'</div><div style="font-size:12px;color:#64748b;margin-top:3px">'+c+'/'+STEPS.length+' étapes'+(done?'':' · Suivez le guide')+'</div></div>'+
          '<div style="display:flex;align-items:center;gap:12px"><div style="width:80px;height:8px;background:#e2e8f0;border-radius:99px;overflow:hidden"><div style="height:100%;width:'+pct+'%;background:'+(done?'#10b981':'linear-gradient(90deg,#1a3dce,#4f7ef8)')+';border-radius:99px;transition:width .6s"></div></div><span style="font-size:13px;font-weight:800;color:'+(done?'#059669':'#1a3dce')+'">'+pct+'%</span><button onclick="document.getElementById(\'onboarding-checklist\').remove();window._obDismiss()" style="background:none;border:none;font-size:16px;color:#94a3b8;cursor:pointer;padding:4px" title="Masquer">✕</button></div>'+
        '</div>'+
        '<div style="padding:12px 16px;display:flex;flex-direction:column;gap:2px">'+
        STEPS.map(function(s,i){var d=!!progress['step_'+s.id];
          return '<div style="display:flex;align-items:center;gap:14px;padding:12px 10px;border-radius:10px;transition:background .15s;'+(d?'opacity:.6':'cursor:pointer;background:#fafbff')+'" '+(d?'':'onclick="location.href=\''+s.link+'\'" onmouseover="this.style.background=\'#f0f4ff\'" onmouseout="this.style.background=\'#fafbff\'"')+'><div style="width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;'+(d?'background:#dcfce7;color:#16a34a':'background:#f0f4ff;border:2px solid #c7d2fe;color:#6366f1')+'">'+(d?'✓':(i+1))+'</div><div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:700;color:'+(d?'#94a3b8':'#1e293b')+';'+(d?'text-decoration:line-through':'')+'">'+s.icon+' '+s.title+'</div><div style="font-size:12px;color:#94a3b8;margin-top:2px">'+s.desc+'</div></div>'+(d?'':'<div style="font-size:12px;font-weight:700;color:#1a3dce;white-space:nowrap">'+s.cta+'</div>')+'</div>';
        }).join('')+'</div></div>';
    var mc=document.getElementById('mainContent')||document.querySelector('.content');
    if(mc&&mc.parentNode)mc.parentNode.insertBefore(el,mc);
    if(!document.getElementById('ob-css')){var s=document.createElement('style');s.id='ob-css';
      s.textContent='@keyframes obFadeIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}@media(max-width:768px){#onboarding-checklist{padding:0 10px!important}}';
      document.head.appendChild(s);}
  }

  window._obDismiss=function(){saveField('checklistDismissed',true);};

  // ════════════════════════════════════════════════
  // TOUR GUIDÉ (overlay z-10000+)
  // ════════════════════════════════════════════════
  function maybeTour(p){var t=TOURS[PAGE];if(!t||p[t.id])return;
    setTimeout(function(){try{startTour(t);}catch(e){cleanup();}},t.delay||2500);}

  var _ov,_tt,_ix,_cf;

  function injectCSS(){if(document.getElementById('tour-css'))return;var s=document.createElement('style');s.id='tour-css';
    s.textContent='#tour-overlay{position:fixed;inset:0;z-index:10000;pointer-events:none;transition:opacity .3s}#tour-overlay.show{pointer-events:auto}#tour-spotlight{position:absolute;box-shadow:0 0 0 9999px rgba(15,31,92,.55);border-radius:10px;transition:all .4s cubic-bezier(.4,0,.2,1);pointer-events:none}#tour-tooltip{position:absolute;z-index:10001;background:#fff;border-radius:14px;padding:20px;width:340px;max-width:90vw;box-shadow:0 12px 40px rgba(15,31,92,.2);animation:tourIn .3s ease}@keyframes tourIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}#tour-tooltip .tt-title{font-size:15px;font-weight:800;color:#0f1f5c;margin-bottom:6px}#tour-tooltip .tt-text{font-size:13px;color:#64748b;line-height:1.6;margin-bottom:16px}#tour-tooltip .tt-footer{display:flex;align-items:center;justify-content:space-between}#tour-tooltip .tt-dots{display:flex;gap:6px}#tour-tooltip .tt-dot{width:8px;height:8px;border-radius:50%;background:#e2e8f0;transition:background .2s}#tour-tooltip .tt-dot.on{background:#1a3dce}#tour-tooltip .tt-btns{display:flex;gap:8px}.tt-btn{padding:8px 16px;border-radius:8px;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;border:none;transition:.2s}.tt-btn-skip{background:#f1f5f9;color:#64748b}.tt-btn-skip:hover{background:#e2e8f0}.tt-btn-next{background:linear-gradient(135deg,#1a3dce,#4f7ef8);color:#fff;box-shadow:0 3px 10px rgba(26,61,206,.25)}.tt-btn-next:hover{opacity:.9}@media(max-width:768px){#tour-tooltip{width:280px;padding:16px}}';
    document.head.appendChild(s);}

  function startTour(t){_cf=t;_ix=0;injectCSS();
    _ov=document.createElement('div');_ov.id='tour-overlay';_ov.innerHTML='<div id="tour-spotlight"></div>';
    _ov.addEventListener('click',function(e){if(e.target===_ov)close();});document.body.appendChild(_ov);
    _tt=document.createElement('div');_tt.id='tour-tooltip';document.body.appendChild(_tt);
    setTimeout(function(){_ov.classList.add('show');show(0);},100);}

  function find(sel){var parts=sel.split(',');for(var i=0;i<parts.length;i++){try{var el=document.querySelector(parts[i].trim());if(el)return el;}catch(e){}}return null;}

  function show(i){_ix=i;var steps=_cf.steps,step=steps[i];if(!step){close();return;}
    var el=find(step.target);if(!el){if(i<steps.length-1)show(i+1);else close();return;}
    var r=el.getBoundingClientRect(),p=8,sp=document.getElementById('tour-spotlight');
    if(sp){sp.style.top=(r.top+window.scrollY-p)+'px';sp.style.left=(r.left+window.scrollX-p)+'px';sp.style.width=(r.width+p*2)+'px';sp.style.height=(r.height+p*2)+'px';}
    var dots='';for(var j=0;j<steps.length;j++)dots+='<div class="tt-dot '+(j===i?'on':'')+'"></div>';
    _tt.innerHTML='<div style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">'+_cf.title+' · '+(i+1)+'/'+steps.length+'</div><div class="tt-title">'+step.title+'</div><div class="tt-text">'+step.text+'</div><div class="tt-footer"><div class="tt-dots">'+dots+'</div><div class="tt-btns"><button class="tt-btn tt-btn-skip" onclick="window._tourClose()">Quitter</button><button class="tt-btn tt-btn-next" onclick="window._tourNext()">'+(i===steps.length-1?'✅ Terminé':'Suivant →')+'</button></div></div>';
    var tw=340,gap=16,left=Math.max(10,Math.min(r.left+window.scrollX,window.innerWidth-tw-20));
    _tt.style.left=left+'px';
    _tt.style.top=(step.pos==='top'?Math.max(10,r.top+window.scrollY-gap-_tt.offsetHeight):(r.bottom+window.scrollY+gap))+'px';
    try{el.scrollIntoView({behavior:'smooth',block:'center'});}catch(e){}}

  function close(){try{if(_ov){_ov.remove();_ov=null;}}catch(e){}try{if(_tt){_tt.remove();_tt=null;}}catch(e){}if(_cf)saveField(_cf.id,true);_cf=null;}
  function cleanup(){try{var o=document.getElementById('tour-overlay');if(o)o.remove();}catch(e){}try{var t=document.getElementById('tour-tooltip');if(t)t.remove();}catch(e){}}

  window._tourNext=function(){try{if(_cf&&_ix<_cf.steps.length-1)show(_ix+1);else close();}catch(e){cleanup();}};
  window._tourClose=function(){try{close();}catch(e){cleanup();}};

})(); } catch(e) { /* silent */ }
