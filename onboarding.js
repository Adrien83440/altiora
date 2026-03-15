// ── onboarding.js — Alteore ── v3 (tours ultra-complets)
// Checklist dashboard + tours guidés TOUS modules
// 100% overlay — ne modifie AUCUN fichier existant
// Chargé via nav.js · Si crash → meurt silencieusement
try { (function () {

  var PAGE = location.pathname.split('/').pop() || 'dashboard.html';
  var CHECKLIST_DAYS = 7;

  function _gd() { return window._getDoc || window._fbGetDoc; }
  function _sd() { return window._setDoc || window._fbSetDoc; }
  function _dc() { return window._doc    || window._fbDoc; }

  var STEPS = [
    { id:'profil',   icon:'🏢', title:'Complétez votre profil entreprise',  desc:'Nom, secteur, ville — pour personnaliser votre espace.',   link:'profil.html',       cta:'Compléter →' },
    { id:'ca',       icon:'📈', title:'Saisissez votre CA du mois',         desc:'Entrez vos recettes journalières dans le pilotage.',       link:'pilotage.html',     cta:'Saisir →' },
    { id:'charges',  icon:'💰', title:'Ajoutez vos charges',                desc:'Charges fixes et variables pour calculer votre résultat.', link:'pilotage.html',     cta:'Ajouter →' },
    { id:'produit',  icon:'🧮', title:'Créez votre premier produit',        desc:'Calculez votre coût de revient et votre marge.',           link:'cout-revient.html', cta:'Créer →' },
    { id:'dashboard',icon:'📊', title:'Explorez votre tableau de bord',     desc:'Découvrez vos KPIs, graphiques et l\'analyse IA.',         link:'dashboard.html',    cta:'Explorer →' },
  ];

  // ══════════════════════════════════════════════════════════════
  // TOURS ULTRA-COMPLETS — TOUS LES MODULES
  // ══════════════════════════════════════════════════════════════
  var TOURS = {

    // ────────────────────────────
    // DASHBOARD (7 étapes)
    // ────────────────────────────
    'dashboard.html': { id:'tour_dashboard', delay:5500, title:'📊 Tableau de bord', steps:[
      { target:'#copilote-widget',                title:'Copilote IA',                  text:'Votre assistant intelligent analyse vos données chaque jour et vous donne des conseils personnalisés : alertes, tendances, opportunités. Il apprend de votre activité.', pos:'bottom' },
      { target:'.kpi-grid-5',                     title:'Vos KPIs essentiels',          text:'CA du mois, charges totales, résultat (bénéfice ou perte), taux de marge et cashflow. Ces 5 indicateurs se mettent à jour automatiquement dès que vous saisissez des données.', pos:'bottom' },
      { target:'#caChart,#resultatChart',         title:'Graphiques mensuels',          text:'Visualisez l\'évolution de votre CA et de votre résultat mois par mois sur l\'année. Survolez les barres pour voir les montants exacts.', pos:'bottom' },
      { target:'#cashflowChart,#cumulChart',      title:'Cashflow & cumul',             text:'Le graphique cashflow montre vos entrées/sorties de trésorerie. Le cumul affiche votre résultat cumulé depuis le début de l\'année.', pos:'bottom' },
      { target:'#widgets-row',                    title:'Widgets météo & fidélité',     text:'La météo de votre ville et un aperçu de vos stats fidélité (si activé). Personnalisable dans votre profil.', pos:'bottom' },
      { target:'#vocalFab',                       title:'Assistant vocal IA',           text:'Cliquez ici pour poser une question à votre assistant par la voix ou par texte. Demandez-lui une analyse, un conseil ou des chiffres.', pos:'top' },
      { target:'.topbar-right .btn-primary',      title:'Commencez ici !',              text:'Ce bouton vous amène directement au pilotage pour saisir votre CA et vos charges. C\'est la première chose à faire pour alimenter tous vos indicateurs.', pos:'bottom' },
    ]},

    // ────────────────────────────
    // PILOTAGE (9 étapes)
    // ────────────────────────────
    'pilotage.html': { id:'tour_pilotage', delay:4500, title:'🧭 Pilotage financier', steps:[
      { target:'#kpi-summary',          title:'Vos 5 indicateurs clés',     text:'CA, charges, résultat, TVA collectée et TVA due. Ces 5 chiffres se recalculent en temps réel à chaque saisie. C\'est la synthèse complète de votre mois.', pos:'bottom' },
      { target:'#htTtcToggle',          title:'Mode HT ou TTC',            text:'Basculez entre Hors Taxes et Toutes Taxes Comprises. Toute la page s\'adapte instantanément : tableaux, KPIs, totaux. La plupart des commerçants saisissent en TTC.', pos:'bottom' },
      { target:'#s-ca',                 title:'Chiffre d\'affaires',        text:'Votre CA du mois. Il se calcule automatiquement depuis le tableau journalier ci-dessous + les factures professionnelles. C\'est votre indicateur de recettes principal.', pos:'bottom' },
      { target:'#ca-tbody tr:first-child,#tot-caHT', title:'Saisie jour par jour', text:'Chaque ligne = un jour. Saisissez votre CA par taux de TVA (5.5%, 10%, 20%). Les totaux HT, TTC et TVA collectée se calculent automatiquement. Astuce : utilisez Tab pour aller vite.', pos:'bottom' },
      { target:'#s-ch',                 title:'Total de vos charges',       text:'La somme de toutes vos dépenses : charges fixes + variables + crédits + leasing + masse salariale. Descendez dans la page pour les renseigner section par section.', pos:'bottom' },
      { target:'#tot-fixHT,#cf-tbody tr:first-child', title:'Charges fixes mensuelles', text:'Loyer, assurances, comptable, salaires, abonnements… Les charges qui reviennent chaque mois. Cliquez "+ Ligne" pour ajouter. Elles sont pré-remplies automatiquement le mois suivant.', pos:'top' },
      { target:'#tot-varHT,#cv-tbody tr:first-child', title:'Charges variables',       text:'Achats matières premières, frais ponctuels, sous-traitance, fournitures… Tout ce qui varie d\'un mois à l\'autre. Ajoutez-les au fur et à mesure.', pos:'top' },
      { target:'#s-res',               title:'Votre résultat mensuel',      text:'CA moins toutes les charges = résultat. Vert = bénéficiaire. Rouge = déficitaire. C\'est LE chiffre à surveiller. Il alimente aussi votre dashboard et vos rapports.', pos:'bottom' },
      { target:'#s-tvad',              title:'TVA due ou crédit TVA',       text:'TVA collectée (sur vos ventes) moins TVA déductible (sur vos achats). Si positif = TVA à reverser au Trésor. Si négatif = crédit de TVA récupérable.', pos:'bottom' },
    ]},

    // ────────────────────────────
    // SUIVI CA (7 étapes)
    // ────────────────────────────
    'suivi-ca.html': { id:'tour_suivi', delay:5500, title:'📈 Suivi CA & Résultats', steps:[
      { target:'#yearSelect',           title:'Sélection de l\'année',      text:'Naviguez entre les années pour comparer vos performances. Les données viennent directement de ce que vous avez saisi dans le Pilotage.', pos:'bottom' },
      { target:'.kpi-grid',             title:'KPIs annuels',               text:'CA total, charges totales, résultat annuel, cashflow et taux de marge. Un résumé de votre année en 5 chiffres clés.', pos:'bottom' },
      { target:'#chartCA',              title:'Évolution du CA',            text:'Votre chiffre d\'affaires mois par mois en barres. Survolez pour les montants exacts. Identifiez vos mois forts et faibles.', pos:'bottom' },
      { target:'#chartResultat',        title:'Résultat mensuel',           text:'Votre bénéfice ou perte mois par mois. Les barres rouges = les mois déficitaires. L\'objectif est de réduire les mois rouges.', pos:'bottom' },
      { target:'#chartCharges',         title:'Détail des charges',         text:'Répartition visuelle de vos charges : fixes vs variables vs crédits. Identifiez vos postes de dépenses les plus lourds.', pos:'bottom' },
      { target:'#compCard',             title:'Comparaison mois à mois',    text:'Comparez deux mois entre eux : CA, charges, résultat, marge. Idéal pour voir votre progression ou l\'impact d\'un changement.', pos:'top' },
      { target:'#fournCard',            title:'Analyse fournisseurs',       text:'Si vous avez renseigné des fournisseurs dans le coût de revient, retrouvez ici le volume d\'achats par fournisseur sur l\'année.', pos:'top' },
    ]},

    // ────────────────────────────
    // COÛT DE REVIENT (7 étapes)
    // ────────────────────────────
    'cout-revient.html': { id:'tour_cout', delay:3000, title:'🧮 Coût de revient', steps:[
      { target:'.left-panel',           title:'Votre catalogue',            text:'Tous vos produits et fournisseurs sont listés ici. Cliquez sur un produit pour voir sa fiche détaillée avec le calcul complet du coût.', pos:'bottom' },
      { target:'.lp-tabs',              title:'Produits & Fournisseurs',    text:'Deux onglets : "Produits" pour vos recettes/articles, "Fournisseurs" pour gérer vos fournisseurs et leurs tarifs. Les fournisseurs sont liés aux ingrédients.', pos:'bottom' },
      { target:'.topbar-right .btn-primary', title:'Créer un produit',     text:'Cliquez ici pour créer votre premier produit. Ajoutez les ingrédients (avec quantités et prix), la main d\'œuvre, les emballages et les charges. Le coût se calcule automatiquement.', pos:'bottom' },
      { target:'button[onclick*="marges.html"],.topbar-right .btn-outline', title:'Lien vers les marges', text:'Une fois vos produits créés ici, retrouvez-les dans le module "Marges" pour analyser votre marge brute et nette avec clé de répartition.', pos:'bottom' },
      { target:'#catList,.fiche-cat-input', title:'Catégories',             text:'Organisez vos produits par catégories (ex: Pâtisseries, Boissons, Services…). Les catégories se créent automatiquement à la saisie.', pos:'bottom' },
    ]},

    // ────────────────────────────
    // MARGES (6 étapes)
    // ────────────────────────────
    'marges.html': { id:'tour_marges', delay:2000, title:'📊 Marges brute & nette', steps:[
      { target:'#productList',              title:'Liste des produits',         text:'Vos produits apparaissent ici avec leur taux de marge. Vert = bonne marge (>30%). Orange = moyenne. Rouge = trop faible (<10%). Cliquez pour analyser.', pos:'bottom' },
      { target:'.topbar-right .btn-primary',title:'Ajouter un produit',         text:'Créez un produit directement ici ou importez-le depuis le Coût de revient. Les deux modules sont synchronisés.', pos:'bottom' },
      { target:'button[onclick*="cout-revient"],.topbar-right .btn-outline', title:'Retour au coût de revient', text:'Basculez vers le coût de revient pour modifier les ingrédients, prix ou quantités d\'un produit. Les changements se reflètent ici automatiquement.', pos:'bottom' },
      { target:'.search-input',             title:'Recherche & filtres',        text:'Recherchez un produit par nom ou catégorie. Pratique quand votre catalogue grandit.', pos:'bottom' },
      { target:'#select-all-btn',           title:'Sélection multiple',         text:'Cochez plusieurs produits pour les supprimer en lot. Le bouton ☐ sélectionne/désélectionne tous les produits.', pos:'bottom' },
    ]},

    // ────────────────────────────
    // PANIER MOYEN (7 étapes)
    // ────────────────────────────
    'panier-moyen.html': { id:'tour_panier', delay:2000, title:'🛒 Panier moyen', steps:[
      { target:'#yrBar',                    title:'Sélection de l\'année',      text:'Choisissez l\'année à analyser. Les données sont indépendantes du pilotage — c\'est un module de suivi commercial.', pos:'bottom' },
      { target:'#monthStrip',               title:'Sélecteur de mois',          text:'Chaque pastille = un mois. Cliquez pour saisir ou consulter les données de ce mois. Les mois renseignés sont colorés.', pos:'bottom' },
      { target:'#f-cli',                    title:'Nombre de clients',          text:'Combien de clients distincts avez-vous eu ce mois ? Même si un client vient 3 fois, comptez-le une seule fois.', pos:'bottom' },
      { target:'#f-ca',                     title:'Chiffre d\'affaires HT',     text:'Le CA total HT du mois. Si vous l\'avez déjà renseigné dans le pilotage, reportez le même montant ici.', pos:'bottom' },
      { target:'#f-txn',                    title:'Nombre de transactions',     text:'Le nombre total de ventes/tickets de caisse du mois. Un client qui achète 3 fois = 3 transactions.', pos:'bottom' },
      { target:'.results-row',              title:'Résultats automatiques',     text:'Panier par vente (CA÷ventes), panier par client (CA÷clients), valeur client et évolution par rapport au mois précédent. Tout est calculé automatiquement.', pos:'top' },
      { target:'.btn-primary',              title:'Sauvegarde',                 text:'N\'oubliez pas de sauvegarder ! Les données sont enregistrées dans votre espace sécurisé.', pos:'bottom' },
    ]},

    // ────────────────────────────
    // DETTES (7 étapes)
    // ────────────────────────────
    'dettes.html': { id:'tour_dettes', delay:3000, title:'🏦 Dettes & Emprunts', steps:[
      { target:'.tb-r .btn-p,.topbar .btn-primary', title:'Ajouter une dette',   text:'Créez un emprunt, crédit, LOA, leasing ou dette fournisseur. Renseignez le montant, le taux, la durée et la date de début. L\'échéancier se génère automatiquement.', pos:'bottom' },
      { target:'#alertBar',                 title:'Alertes échéances',          text:'Les échéances à venir dans les 7 prochains jours s\'affichent ici en rouge. Ne ratez plus aucun paiement.', pos:'bottom' },
      { target:'#calGrid',                  title:'Calendrier annuel',          text:'Vue mois par mois de vos échéances. Les mois avec des paiements importants sont colorés. Cliquez sur un mois pour voir le détail.', pos:'bottom' },
      { target:'#filterTabs',               title:'Filtrer par type',           text:'Filtrez vos dettes par catégorie : tout, emprunts, leasings, fournisseurs ou découverts. Chaque type a son icône.', pos:'bottom' },
      { target:'#detteGrid',                title:'Vos dettes',                 text:'Chaque carte = une dette avec montant restant, progression, mensualité et prochaine échéance. Cliquez pour voir le détail et l\'échéancier complet.', pos:'top' },
      { target:'#cSolde',                   title:'Solde total',                text:'Le graphique en anneau montre le montant total restant à rembourser tous types de dettes confondus.', pos:'bottom' },
    ]},

    // ────────────────────────────
    // CASHFLOW (7 étapes)
    // ────────────────────────────
    'cashflow.html': { id:'tour_cashflow', delay:3500, title:'💧 Cashflow', steps:[
      { target:'.kpi-row',                  title:'Indicateurs trésorerie',     text:'Trésorerie disponible, total des entrées, total des sorties, solde net et variation mensuelle. Le cashflow se calcule automatiquement depuis vos saisies pilotage.', pos:'bottom' },
      { target:'#cfChart',                  title:'Graphique mensuel',          text:'Entrées (vert) vs sorties (rouge) mois par mois. Identifiez rapidement les mois où vous dépensez plus que vous ne gagnez.', pos:'bottom' },
      { target:'#prevChart',                title:'Prévisionnel annuel',        text:'L\'évolution de votre trésorerie sur 12 mois. La ligne montre si votre solde augmente ou diminue au fil de l\'année.', pos:'bottom' },
      { target:'#cumulChart',               title:'Cumul de trésorerie',        text:'Le cumul progressif de votre cashflow depuis le début de l\'année. Permet de voir la tendance générale.', pos:'bottom' },
      { target:'#prevDoughnut',             title:'Répartition entrées/sorties', text:'Visualisation en anneau de la proportion entrées vs sorties. Idéal pour voir d\'un coup d\'œil l\'équilibre de votre trésorerie.', pos:'bottom' },
      { target:'#yearSelect',               title:'Navigation par année',       text:'Comparez votre cashflow entre les années. Utile pour anticiper les périodes creuses saisonnières.', pos:'bottom' },
      { target:'#btnCivil,#btnExerc',       title:'Année civile ou exercice',   text:'Affichez votre cashflow en année civile (jan-déc) ou en exercice comptable (début personnalisable dans le profil).', pos:'bottom' },
    ]},

    // ────────────────────────────
    // STOCK (8 étapes)
    // ────────────────────────────
    'gestion-stock.html': { id:'tour_stock', delay:3000, title:'📦 Gestion des stocks', steps:[
      { target:'#kpi-row',                  title:'KPIs stock',                 text:'Nombre de références, valeur totale du stock, alertes de rupture (seuil configurable), mouvements récents et taux de rotation.', pos:'bottom' },
      { target:'#tabs',                     title:'Vos onglets',                text:'Catalogue (vos produits), Produits (détail), Mouvements (entrées/sorties), Valorisation (valeur financière), Inventaire, Analyse ABC et Graphiques.', pos:'bottom' },
      { target:'button[onclick*="openProdModal"],.tb-r .btn-primary', title:'Ajouter un produit', text:'Créez une référence stock : nom, catégorie, quantité initiale, seuil d\'alerte et prix unitaire. Vous pouvez aussi scanner le code-barres.', pos:'bottom' },
      { target:'button[onclick*="openMovModal"]',  title:'Enregistrer un mouvement', text:'Entrées (réception fournisseur) ou sorties (vente, perte, casse). Chaque mouvement met à jour les quantités et la valorisation automatiquement.', pos:'bottom' },
      { target:'button[onclick*="openScanModal"]', title:'Scanner un produit',  text:'Utilisez la caméra de votre téléphone ou tablette pour scanner un code-barres EAN. Le produit est reconnu automatiquement.', pos:'bottom' },
      { target:'button[onclick*="openImportModal"]',title:'Import IA',          text:'Importez votre stock depuis une photo de facture ou un document. L\'IA reconnaît les produits, quantités et prix automatiquement.', pos:'bottom' },
      { target:'button[onclick*="openSettings"]',   title:'Paramètres',         text:'Configurez les seuils d\'alerte, les catégories par défaut, la méthode de valorisation (FIFO, CUMP, dernier prix) et les unités.', pos:'bottom' },
      { target:'[data-tab="analyse"]',       title:'Analyse ABC',              text:'Classement de vos produits par importance : A (80% de la valeur), B (15%) et C (5%). Concentrez vos efforts sur les produits A.', pos:'bottom' },
    ]},

    // ────────────────────────────
    // FIDÉLISATION (9 étapes — tous les onglets)
    // ────────────────────────────
    'fidelisation.html': { id:'tour_fidelite', delay:2500, title:'💎 Fidélisation client', steps:[
      { target:'[data-tab="dashboard"]',    title:'Dashboard fidélité',         text:'Vue d\'ensemble : nombre de clients, points distribués, coupons utilisés, campagnes envoyées. Les graphiques montrent l\'évolution et la segmentation.', pos:'bottom' },
      { target:'[data-tab="clients"]',      title:'Base clients',               text:'Ajoutez vos clients manuellement ou via la tablette en magasin. Chaque client a une fiche avec historique d\'achats, points cumulés et segment (VIP, fidèle, occasionnel…).', pos:'bottom' },
      { target:'[data-tab="carte"]',        title:'Carte de fidélité digitale', text:'Configurez votre carte : logo, couleurs, nombre de tampons. Vos clients la consultent sur leur téléphone via un lien unique. Fini les cartes papier perdues.', pos:'bottom' },
      { target:'[data-tab="points"]',       title:'Points & Récompenses',      text:'Définissez combien de points par euro, les bonus anniversaire, parrainage et VIP. Créez des paliers de récompenses (ex: 100 pts = -5€).', pos:'bottom' },
      { target:'[data-tab="coupons"]',      title:'Coupons & Offres',          text:'Créez des coupons à usage unique ou multiple : % de réduction, montant fixe, offre gratuite. Définissez une date d\'expiration et les conditions.', pos:'bottom' },
      { target:'[data-tab="campagnes"]',    title:'Campagnes SMS',             text:'Envoyez des SMS ciblés à vos clients : promotions, anniversaires, relances inactifs. Choisissez le segment cible et rédigez votre message. Nécessite des crédits SMS.', pos:'bottom' },
      { target:'#smsCreditsDisplay',        title:'Crédits SMS',               text:'Votre solde de crédits SMS. Chaque SMS envoyé consomme 1 crédit. Achetez des packs dans la boutique intégrée (paiement Stripe sécurisé).', pos:'bottom' },
      { target:'[data-tab="config"]',       title:'Configuration',             text:'Nom de la boutique (affiché sur la carte), nom de l\'expéditeur SMS, code PIN tablette pour la borne en magasin, et lien d\'inscription client.', pos:'bottom' },
      { target:'#cfg-inscription-link',     title:'Lien d\'inscription',       text:'Partagez ce lien à vos clients (QR code, réseaux sociaux, email). Ils s\'inscrivent eux-mêmes et apparaissent dans votre base automatiquement.', pos:'bottom' },
    ]},

    // ══════════════════════════════════
    // RH — Dashboard (5 étapes)
    // ══════════════════════════════════
    'rh-dashboard.html': { id:'tour_rh_dash', delay:2500, title:'👥 Dashboard RH', steps:[
      { target:'#kpi-row',                          title:'KPIs Équipe',             text:'Effectif total, masse salariale mensuelle, congés en cours et alertes. Ces indicateurs se mettent à jour automatiquement depuis les fiches employés.', pos:'bottom' },
      { target:'#chartMasse',                       title:'Évolution masse salariale', text:'Graphique de votre masse salariale sur les 12 derniers mois. Inclut salaires bruts, charges patronales et primes si configurées.', pos:'bottom' },
      { target:'#chartContrats',                    title:'Répartition contrats',    text:'CDI, CDD, alternance, stage… Visualisez la composition de votre équipe par type de contrat.', pos:'bottom' },
      { target:'button[onclick*="rh-employes"]',    title:'Fiches employés',         text:'Accédez à la liste complète de vos salariés. Chaque fiche contient : infos personnelles, contrat, horaires, salaire, documents et historique.', pos:'bottom' },
      { target:'button[onclick*="rh-conges"]',      title:'Gestion des congés',      text:'Validez les demandes en attente, consultez les soldes de chaque salarié et visualisez le calendrier des absences.', pos:'bottom' },
    ]},

    // ── RH Employés (7 étapes) ──
    'rh-employes.html': { id:'tour_rh_emp', delay:2500, title:'👤 Employés & Fiches', steps:[
      { target:'button[onclick*="openModalNouvelEmploye"]', title:'Ajouter un employé', text:'Créez une fiche pour un nouveau salarié. La convention collective (CCN) est recherchée automatiquement par l\'IA à partir du SIRET ou du secteur.', pos:'bottom' },
      { target:'#search-emp',               title:'Recherche',                  text:'Recherchez un employé par nom, prénom, poste ou département. Pratique quand votre équipe grandit.', pos:'bottom' },
      { target:'#filter-contrat',           title:'Filtres par contrat',        text:'Filtrez par type de contrat (CDI, CDD, alternance…), département ou statut (actif, en congé, parti). Combinables.', pos:'bottom' },
      { target:'#emp-list',                 title:'Liste des employés',         text:'Cliquez sur un employé pour ouvrir sa fiche complète. Vous y trouverez toutes ses informations, son contrat, ses horaires et ses documents.', pos:'bottom' },
      { target:'#btn-show-archived',        title:'Employés archivés',          text:'Les anciens salariés (départs, fins de CDD) sont archivés ici. Vous conservez leur historique pour vos obligations légales.', pos:'bottom' },
      { target:'#autosave-status',          title:'Sauvegarde automatique',     text:'Toutes les modifications sont sauvegardées automatiquement après 1.5 secondes d\'inactivité. Le statut s\'affiche en haut.', pos:'bottom' },
      { target:'#btn-ccn-ai',              title:'Recherche CCN par IA',       text:'L\'IA recherche la convention collective applicable à votre entreprise via la base DILA/Légifrance. Les grilles salariales et règles s\'appliquent automatiquement.', pos:'bottom' },
    ]},

    // ── RH Planning (6 étapes) ──
    'rh-planning.html': { id:'tour_rh_plan', delay:3000, title:'📅 Planning', steps:[
      { target:'#week-label',               title:'Navigation semaine',         text:'Naviguez entre les semaines avec les flèches. Le planning affiche les créneaux de chaque employé jour par jour.', pos:'bottom' },
      { target:'#vtab-mois',                title:'Vues disponibles',           text:'Basculez entre vue semaine (détaillée), timeline (Gantt), vue mois (calendrier) et vue jour. Chaque vue a ses avantages.', pos:'bottom' },
      { target:'button[onclick*="openPolyPanel"]', title:'Créneaux polyvalents', text:'Créez des créneaux types (ex: "Matin 8h-14h", "Soir 17h-22h") puis glissez-déposez-les sur les jours et employés. Gain de temps énorme.', pos:'bottom' },
      { target:'button[onclick*="openParamsEntreprise"]', title:'Paramètres horaires', text:'Configurez les horaires d\'ouverture de votre établissement, les jours de fermeture et les règles de planification (durée max, repos…).', pos:'bottom' },
      { target:'button[onclick*="exportPDF"]', title:'Export PDF',              text:'Exportez le planning de la semaine en PDF pour affichage en salle de pause ou envoi aux employés. Obligation légale d\'affichage.', pos:'bottom' },
      { target:'#ai-gen-btn',              title:'Génération IA',              text:'L\'IA peut générer un planning optimisé automatiquement en tenant compte des disponibilités, compétences et contraintes légales.', pos:'bottom' },
    ]},

    // ── RH Congés (6 étapes) ──
    'rh-conges.html': { id:'tour_rh_conges', delay:2500, title:'🌴 Congés & Absences', steps:[
      { target:'#kpi-row',                  title:'Indicateurs congés',         text:'Jours pris ce mois, demandes en attente, taux d\'absence et solde moyen. Vue d\'ensemble rapide de la situation.', pos:'bottom' },
      { target:'#tab-soldes',               title:'Soldes par employé',         text:'Consultez les compteurs détaillés : congés acquis, pris, restants, RTT et récupération pour chaque salarié.', pos:'bottom' },
      { target:'#badge-pending',            title:'Demandes en attente',        text:'Le badge indique le nombre de demandes à traiter. Cliquez pour voir et valider/refuser chaque demande en un clic.', pos:'bottom' },
      { target:'button[onclick*="openNewDemandeModal"]', title:'Créer une demande', text:'Créez une demande de congé au nom d\'un employé. Choisissez le type (CP, RTT, maladie…), les dates et ajoutez un justificatif si besoin.', pos:'bottom' },
      { target:'button[onclick*="openAjustModal"]', title:'Ajuster les soldes', text:'Modifiez manuellement les soldes de congés d\'un employé : ajouter des jours, corriger une erreur, initialiser en début d\'année.', pos:'bottom' },
      { target:'#cal-content',              title:'Calendrier des absences',    text:'Visualisez sur un calendrier qui est absent et quand. Évitez les sous-effectifs en repérant les chevauchements.', pos:'bottom' },
    ]},

    // ── RH Temps de travail (5 étapes) ──
    'rh-temps.html': { id:'tour_rh_temps', delay:2500, title:'⏱ Temps de travail', steps:[
      { target:'#mois-label',               title:'Mois en cours',             text:'Naviguez entre les mois. Chaque mois affiche le détail des heures par salarié.', pos:'bottom' },
      { target:'#stat-h',                   title:'Heures réalisées',          text:'Total des heures travaillées sur le mois. Comparé au théorique (durée légale × jours ouvrés) pour détecter les écarts.', pos:'bottom' },
      { target:'#stat-sup',                 title:'Heures supplémentaires',    text:'Heures au-delà de la durée légale. Elles sont majorées selon votre CCN (généralement 25% puis 50%). Important pour la paie.', pos:'bottom' },
      { target:'button[onclick*="openSaisie"]', title:'Saisie manuelle',       text:'Si les pointages automatiques ne sont pas activés, saisissez les heures manuellement pour chaque salarié.', pos:'bottom' },
      { target:'button[onclick*="openExport"]', title:'Export données',         text:'Exportez les données de temps de travail pour votre expert-comptable ou pour vos archives. Format CSV ou PDF.', pos:'bottom' },
    ]},

    // ── RH Paie (6 étapes) ──
    'rh-paie.html': { id:'tour_rh_paie', delay:2500, title:'💶 Paie & Salaires', steps:[
      { target:'#moisLabel',                title:'Mois de paie',              text:'Sélectionnez le mois pour voir les bulletins indicatifs. Rappel : Alteore fournit une estimation, pas un bulletin officiel.', pos:'bottom' },
      { target:'#stat-payes',               title:'Fiches payées',             text:'Nombre de fiches de paie traitées vs en attente. Validez chaque fiche après vérification.', pos:'bottom' },
      { target:'#stat-masse',               title:'Masse salariale',           text:'Coût total employeur : salaires bruts + cotisations patronales. Ce montant est automatiquement intégré dans vos charges du pilotage.', pos:'bottom' },
      { target:'#coutReelSection',          title:'Coût réel complet',         text:'Au-delà du salaire : mutuelle, prévoyance, médecine du travail, formation, EPI… Tous les coûts cachés d\'un salarié.', pos:'bottom' },
      { target:'button[onclick*="rh-dirigeant"]', title:'Rémunération dirigeant', text:'Simulez votre propre rémunération en tant que dirigeant : TNS, assimilé salarié, dividendes. Comparez le coût pour l\'entreprise.', pos:'bottom' },
      { target:'#btn-recap',                title:'Récapitulatif mensuel',     text:'Générez un récapitulatif PDF du mois avec tous les salariés, salaires et cotisations. À transmettre à votre expert-comptable.', pos:'bottom' },
    ]},

    // ── RH Dirigeant (6 étapes) ──
    'rh-dirigeant.html': { id:'tour_rh_dirig', delay:2500, title:'👔 Rémunération dirigeant', steps:[
      { target:'#statutGrid',               title:'Votre statut juridique',    text:'TNS (SARL gérant majoritaire), assimilé salarié (SAS/SASU), auto-entrepreneur… Chaque statut a ses propres taux de cotisations. Sélectionnez le vôtre.', pos:'bottom' },
      { target:'#inp-net',                  title:'Rémunération nette souhaitée', text:'Entrez le montant net que vous souhaitez vous verser. Le simulateur calcule automatiquement le brut, les cotisations et le coût total entreprise.', pos:'bottom' },
      { target:'#cotTable',                 title:'Détail des cotisations',    text:'Chaque ligne détaille une cotisation : maladie, retraite, CSG/CRDS, allocations familiales… Avec le taux et le montant calculé.', pos:'bottom' },
      { target:'#compSection',              title:'Comparaison URSSAF',        text:'Comparez votre estimation avec le simulateur officiel mon-entreprise.urssaf.fr. Les écarts sont affichés en pourcentage.', pos:'bottom' },
      { target:'#tab-annuel',               title:'Projection annuelle',       text:'Votre rémunération projetée sur 12 mois : net annuel, cotisations annuelles et coût total pour l\'entreprise.', pos:'bottom' },
      { target:'#chartDirigeant',           title:'Graphique de répartition',  text:'Visualisez la répartition net/cotisations/charges de votre rémunération. Identifiez le poids de chaque poste.', pos:'bottom' },
    ]},

    // ── RH Objectifs (5 étapes) ──
    'rh-objectifs.html': { id:'tour_rh_obj', delay:2500, title:'🎯 Objectifs & Primes', steps:[
      { target:'#kpi-row',                  title:'Tableau de bord objectifs',  text:'Objectifs en cours, taux d\'atteinte moyen, montant total des primes à verser et coût pour l\'entreprise (charges comprises).', pos:'bottom' },
      { target:'button[onclick*="openCreateModal"]', title:'Créer un objectif', text:'Définissez un objectif : titre, description, critères mesurables, échéance et prime associée. Assignez-le à un ou plusieurs employés.', pos:'bottom' },
      { target:'button[onclick*="rh-employes"]', title:'Lien vers les fiches',  text:'Les objectifs sont aussi visibles dans la fiche de chaque employé. L\'employé peut suivre sa progression depuis son espace.', pos:'bottom' },
      { target:'button[onclick*="rh-entretiens"]', title:'Lien entretiens',     text:'Les objectifs alimentent automatiquement les entretiens annuels. Le manager retrouve le bilan des objectifs dans la grille d\'évaluation.', pos:'bottom' },
      { target:'#kpi-primes',               title:'Budget primes',             text:'Le montant total des primes à verser si tous les objectifs sont atteints. Ce montant est intégré dans la masse salariale prévisionnelle.', pos:'bottom' },
    ]},

    // ── RH Recrutement (6 étapes) ──
    'rh-recrutement.html': { id:'tour_rh_recru', delay:2500, title:'📋 Recrutement', steps:[
      { target:'#tab-pipeline',             title:'Pipeline visuel',           text:'Vos candidats organisés par étape : candidature reçue, présélection, entretien, test technique, offre envoyée, embauché. Glissez-déposez pour changer d\'étape.', pos:'bottom' },
      { target:'button[onclick*="modal-offre"]', title:'Publier une offre',    text:'Créez une offre d\'emploi : titre, description, compétences requises, type de contrat, salaire. Générez un lien de candidature à partager.', pos:'bottom' },
      { target:'button[onclick*="modal-candidat"]', title:'Ajouter un candidat', text:'Enregistrez un candidat reçu par email, en personne ou via une annonce. Attachez son CV et ses notes.', pos:'bottom' },
      { target:'#kpi-offres',               title:'Offres actives',            text:'Nombre d\'offres actuellement publiées. Cliquez pour voir le détail et le nombre de candidatures par offre.', pos:'bottom' },
      { target:'#kpi-entretiens',           title:'Entretiens planifiés',      text:'Nombre d\'entretiens à venir cette semaine. Chaque entretien peut être noté et commenté directement dans la fiche candidat.', pos:'bottom' },
      { target:'#kpi-taux',                 title:'Taux de conversion',        text:'Pourcentage de candidats passés de la candidature à l\'embauche. Un indicateur clé de l\'efficacité de votre processus de recrutement.', pos:'bottom' },
    ]},

    // ── RH Onboarding (5 étapes) ──
    'rh-onboarding.html': { id:'tour_rh_onb', delay:2500, title:'🚀 Onboarding / Offboarding', steps:[
      { target:'button[onclick*="switchTab"][onclick*="onboarding"]', title:'Onglet Onboarding', text:'Intégration des nouveaux salariés : checklist personnalisée par poste, suivi étape par étape, collecte de documents.', pos:'bottom' },
      { target:'button[onclick*="switchTab"][onclick*="offboarding"]', title:'Onglet Offboarding', text:'Départ d\'un salarié : restitution du matériel, remise des documents (certificat de travail, solde de tout compte), entretien de sortie.', pos:'bottom' },
      { target:'button[onclick*="modal-on"]', title:'Nouvel onboarding',      text:'Lancez le processus pour un nouveau salarié. Alteore génère une checklist adaptée au type de poste et au contrat.', pos:'bottom' },
      { target:'#right-panel',               title:'Suivi du dossier',         text:'Suivez l\'avancement de chaque dossier : tâches complétées, documents reçus, étapes restantes. Tout est centralisé.', pos:'bottom' },
      { target:'button[onclick*="switchTab"][onclick*="archives"]', title:'Archives', text:'Retrouvez tous les dossiers terminés. Utile pour les audits ou pour vérifier qu\'un ancien onboarding a été complété.', pos:'bottom' },
    ]},

    // ── RH Entretiens (5 étapes) ──
    'rh-entretiens.html': { id:'tour_rh_entretiens', delay:2500, title:'💬 Entretiens annuels', steps:[
      { target:'#emp-list',                  title:'Sélection employé',        text:'Choisissez un employé pour créer ou consulter son entretien annuel. Les employés avec un entretien en retard sont signalés.', pos:'bottom' },
      { target:'button[onclick*="openNewEntretien"]', title:'Nouvel entretien', text:'Créez un entretien avec grille d\'évaluation personnalisable, bilan des objectifs passés, nouveaux objectifs et commentaires manager/salarié.', pos:'bottom' },
      { target:'#stat-done',                title:'Entretiens réalisés',       text:'Nombre d\'entretiens complétés vs total à faire. L\'entretien professionnel est obligatoire tous les 2 ans (Code du travail).', pos:'bottom' },
      { target:'#emp-search',               title:'Recherche & filtres',       text:'Filtrez par département, statut d\'entretien (à faire, en cours, terminé) ou recherchez par nom.', pos:'bottom' },
      { target:'#f-dept',                   title:'Filtre département',        text:'Si vous avez plusieurs départements (cuisine, salle, administration…), filtrez pour traiter les entretiens service par service.', pos:'bottom' },
    ]},

    // ── RH Conformité (5 étapes) ──
    'rh-conformite.html': { id:'tour_rh_conf', delay:2500, title:'⚖️ Conformité & Légal', steps:[
      { target:'#main-content',              title:'Checklist obligatoire',     text:'Vérifiez point par point que votre entreprise respecte les obligations légales : affichages, registres, documents, déclarations.', pos:'bottom' },
      { target:'#topbar-ccn-sub',           title:'Convention collective',      text:'Votre CCN est affichée ici. Elle détermine les règles spécifiques : grille salariale, congés supplémentaires, préavis, indemnités.', pos:'bottom' },
      { target:'#autosave-status',          title:'Progression sauvegardée',   text:'Vos réponses sont sauvegardées automatiquement. Vous pouvez quitter et reprendre à tout moment sans perdre votre progression.', pos:'bottom' },
      { target:'button[onclick*="print"]',  title:'Impression',                text:'Imprimez votre checklist complète en PDF. Utile pour la préparer avant un contrôle de l\'inspection du travail.', pos:'bottom' },
      { target:'button[onclick*="saveAll"]',title:'Sauvegarde manuelle',       text:'En plus de la sauvegarde automatique, vous pouvez forcer une sauvegarde à tout moment avec ce bouton.', pos:'bottom' },
    ]},

    // ── RH Modèles de documents (5 étapes) ──
    'rh-modeles.html': { id:'tour_rh_modeles', delay:2500, title:'📄 Modèles de documents', steps:[
      { target:'#themesGrid',               title:'Thèmes disponibles',        text:'Parcourez les catégories : contrats, avenants, attestations, courriers, convocations, certificats… Des dizaines de modèles prêts à l\'emploi.', pos:'bottom' },
      { target:'#searchInput',              title:'Recherche',                 text:'Tapez un mot-clé (ex: "attestation", "rupture", "avertissement") pour trouver le modèle adapté à votre situation.', pos:'bottom' },
      { target:'#stat-total',               title:'Statistiques',              text:'Nombre total de modèles disponibles, nombre de documents générés et vos favoris. Les modèles les plus utilisés remontent en priorité.', pos:'bottom' },
      { target:'button[onclick*="showHistory"]', title:'Historique',           text:'Retrouvez tous les documents que vous avez déjà générés. Téléchargez-les à nouveau ou réutilisez-les comme base.', pos:'bottom' },
      { target:'#docsSection',              title:'Vos documents générés',     text:'Les documents sont générés par l\'IA avec les données de votre entreprise et du salarié. Ils sont au format Word (DOCX) modifiable.', pos:'bottom' },
    ]},

    // ── RH Contrats (6 étapes) ──
    'rh-contrats.html': { id:'tour_rh_contrats', delay:2500, title:'📝 Contrats de travail', steps:[
      { target:'button[onclick*="startNewContract"]', title:'Nouveau contrat', text:'L\'assistant IA vous guide en 6 étapes : type de contrat, infos salarié, conditions (horaires, salaire, période d\'essai), clauses particulières, génération et export.', pos:'bottom' },
      { target:'#histList',                 title:'Historique des contrats',    text:'Retrouvez tous les contrats déjà générés. Cliquez pour les consulter, les modifier ou les exporter à nouveau.', pos:'bottom' },
      { target:'#step-1,#wizardWrap',       title:'Étape 1 : Type de contrat', text:'CDI temps plein, CDI temps partiel, CDD, alternance ou stage. Chaque type adapte automatiquement les clauses obligatoires.', pos:'bottom' },
      { target:'#cond-debut',              title:'Conditions de travail',      text:'Date de début, durée (pour CDD), période d\'essai, horaires hebdomadaires et salaire. Tout est pré-rempli depuis la fiche employé si elle existe.', pos:'bottom' },
      { target:'#altFields',               title:'Clauses particulières',      text:'Non-concurrence, mobilité, confidentialité, dédit-formation… Activez uniquement les clauses nécessaires. L\'IA rédige le contenu juridique.', pos:'bottom' },
      { target:'#hist-count',              title:'Compteur',                   text:'Nombre total de contrats générés. Chaque contrat est horodaté et archivé pour traçabilité légale.', pos:'bottom' },
    ]},

    // ── RH Pointages (6 étapes) ──
    'rh-pointages.html': { id:'tour_rh_point', delay:2500, title:'⏰ Pointages', steps:[
      { target:'#vt-jour',                  title:'Vue jour',                  text:'Les pointages du jour en temps réel : arrivées, départs, pauses. Chaque salarié a sa ligne avec les heures exactes.', pos:'bottom' },
      { target:'#vt-salarie',               title:'Vue salarié',              text:'Consultez l\'historique de pointage d\'un employé spécifique : régularité, retards, heures sup. Utile pour les entretiens.', pos:'bottom' },
      { target:'#vt-recap',                 title:'Récapitulatif',            text:'Tableau synthétique : heures par employé sur la période, écart avec le théorique, heures sup à payer. Exportable.', pos:'bottom' },
      { target:'#vt-alertes',               title:'Alertes',                   text:'Retards, dépassements horaires, oublis de pointage. Les anomalies sont détectées automatiquement et listées ici.', pos:'bottom' },
      { target:'button[onclick*="openConfig"]', title:'Configuration',         text:'Choisissez la méthode de pointage : QR code, code PIN ou géolocalisation mobile. Configurez les tolérances de retard et les pauses.', pos:'bottom' },
      { target:'#cfg-link',                 title:'Lien de pointage',          text:'Partagez ce lien à vos employés. Ils pointent depuis leur téléphone en arrivant et en partant. Le lien peut être affiché en QR code.', pos:'bottom' },
    ]},

    // ── RH Émargements (6 étapes) ──
    'rh-emargements.html': { id:'tour_rh_emarg', delay:2500, title:'✍️ Émargements', steps:[
      { target:'#vt-daily',                 title:'Émargement quotidien',      text:'Feuille d\'émargement du jour. Chaque employé signe numériquement sa présence. Valeur probante en cas de contrôle.', pos:'bottom' },
      { target:'#vt-fiches',                title:'Fiches mensuelles',         text:'Récapitulatif mensuel signé par chaque salarié. Conforme aux exigences de l\'inspection du travail. Exportable en PDF.', pos:'bottom' },
      { target:'#vt-planning',              title:'Émargements planning',      text:'Émargement spécifique au planning affiché. Le salarié confirme avoir pris connaissance de ses horaires. Obligatoire légalement.', pos:'bottom' },
      { target:'#vt-audit',                 title:'Piste d\'audit',            text:'Historique horodaté et infalsifiable de toutes les signatures. Chaque action est tracée : qui, quand, depuis quelle IP. Preuve opposable.', pos:'bottom' },
      { target:'#selType',                  title:'Type d\'émargement',        text:'Basculez entre quotidien, hebdomadaire ou mensuel selon votre organisation. Le format s\'adapte automatiquement.', pos:'bottom' },
      { target:'button[onclick*="generateFiches"]', title:'Générer les fiches', text:'Générez automatiquement les fiches d\'émargement pour tous les employés. Elles sont envoyées dans leur espace pour signature.', pos:'bottom' },
    ]},

    // ── RH Urgence Contrôle (5 étapes) ──
    'rh-urgence.html': { id:'tour_rh_urgence', delay:2000, title:'🚨 Urgence Contrôle', steps:[
      { target:'#hero-stats',               title:'Score de préparation',      text:'En un coup d\'œil : combien de documents sont prêts, combien de points sont vérifiés et le temps estimé pour tout préparer.', pos:'bottom' },
      { target:'#ctrl-selector',            title:'Type de contrôle',          text:'Inspection du travail, URSSAF, contrôle fiscal, DIRECCTE… Chaque type a sa checklist spécifique avec les documents à fournir.', pos:'bottom' },
      { target:'#stat-docs',                title:'Documents prêts',           text:'Nombre de documents obligatoires déjà disponibles dans Alteore vs ceux qui manquent. Les manquants sont listés avec un lien pour les créer.', pos:'bottom' },
      { target:'#stat-checks',              title:'Points de conformité',      text:'Chaque obligation légale est vérifiée : affichages, registre du personnel, DUERP, règlement intérieur, CCN affichée…', pos:'bottom' },
      { target:'button[onclick*="print"]',  title:'Imprimer le dossier',       text:'Imprimez votre dossier complet de préparation au contrôle. Inclut la checklist cochée et les documents à fournir.', pos:'bottom' },
    ]},

  };

  // ══════════════════════════════════════════════════
  // ENGINE (identique — ne pas modifier)
  // ══════════════════════════════════════════════════
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
  waitReady(function () {
    loadProgress(function (progress) {
      if (progress.tutoDisabled) return;
      try { if (PAGE === 'dashboard.html') injectChecklist(progress); } catch(e) {}
      try { if (TOURS[PAGE]) maybeTour(progress); } catch(e) {}
    });
  });
  waitReady(function () {
    try {
      if (PAGE === 'profil.html') _gd()(_dc()(window._db,'profil',window._uid,'data','profil'))
        .then(function(s){if(s.exists()&&s.data().nom)saveField('step_profil',true);}).catch(function(){});
      if (PAGE === 'pilotage.html') setTimeout(function(){saveField('step_ca',true);saveField('step_charges',true);},8000);
      if (PAGE === 'cout-revient.html') setTimeout(function(){saveField('step_produit',true);},5000);
      if (PAGE === 'dashboard.html') setTimeout(function(){saveField('step_dashboard',true);},8000);
    } catch(e) {}
  });
  function injectChecklist(progress) {
    if (progress.checklistDismissed) return;
    _gd()(_dc()(window._db,'users',window._uid)).then(function(snap){
      if(!snap.exists())return;var d=snap.data(),created=d.createdAt;
      if(!created)return;
      var cd=created.toDate?created.toDate():new Date(created);if((Date.now()-cd.getTime())/864e5>CHECKLIST_DAYS)return;
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
        '<div style="padding:20px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;background:'+(done?'linear-gradient(135deg,#f0fdf4,#ecfdf5)':'linear-gradient(135deg,#f0f4ff,#f5f7ff)')+'">'+'<div><div style="font-size:16px;font-weight:800;color:#0f1f5c;display:flex;align-items:center;gap:8px">'+(done?'🎉 Bravo, tout est configuré !':'🚀 Premiers pas avec Alteore')+'</div><div style="font-size:12px;color:#64748b;margin-top:3px">'+c+'/'+STEPS.length+' étapes'+(done?'':' · Suivez le guide')+'</div></div>'+
          '<div style="display:flex;align-items:center;gap:12px"><div style="width:80px;height:8px;background:#e2e8f0;border-radius:99px;overflow:hidden"><div style="height:100%;width:'+pct+'%;background:'+(done?'#10b981':'linear-gradient(90deg,#1a3dce,#4f7ef8)')+';border-radius:99px;transition:width .6s"></div></div><span style="font-size:13px;font-weight:800;color:'+(done?'#059669':'#1a3dce')+'">'+pct+'%</span><button onclick="document.getElementById(\'onboarding-checklist\').remove();window._obDismiss()" style="background:none;border:none;font-size:16px;color:#94a3b8;cursor:pointer;padding:4px" title="Masquer">✕</button></div>'+
        '</div>'+
        '<div style="padding:12px 16px;display:flex;flex-direction:column;gap:2px">'+
        STEPS.map(function(s,i){var d=!!progress['step_'+s.id];
          return '<div style="display:flex;align-items:center;gap:14px;padding:12px 10px;border-radius:10px;transition:background .15s;'+(d?'opacity:.6':'cursor:pointer;background:#fafbff')+'" '+(d?'':'onclick="location.href=\''+s.link+'\'" onmouseover="this.style.background=\'#f0f4ff\'" onmouseout="this.style.background=\'#fafbff\'"')+'><div style="width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;'+(d?'background:#dcfce7;color:#16a34a':'background:#f0f4ff;border:2px solid #c7d2fe;color:#6366f1')+'">'+(d?'✓':(i+1))+'</div><div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:700;color:'+(d?'#94a3b8':'#1e293b')+';'+(d?'text-decoration:line-through':'')+'">'+s.icon+' '+s.title+'</div><div style="font-size:12px;color:#94a3b8;margin-top:2px">'+s.desc+'</div></div>'+(d?'':'<div style="font-size:12px;font-weight:700;color:#1a3dce;white-space:nowrap">'+s.cta+'</div>')+'</div>';
        }).join('')+'</div><div style="text-align:center;padding:8px 16px 14px"><button onclick="if(confirm(\'Désactiver définitivement les tutoriels et tours guidés ?\')){window._obDisableAll();}" style="background:none;border:none;font-size:11px;color:#94a3b8;cursor:pointer;text-decoration:underline">Ne plus afficher les tutoriels</button></div></div>';
    var mc=document.getElementById('mainContent')||document.querySelector('.content');
    if(mc&&mc.parentNode)mc.parentNode.insertBefore(el,mc);
    if(!document.getElementById('ob-css')){var s=document.createElement('style');s.id='ob-css';
      s.textContent='@keyframes obFadeIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}@media(max-width:768px){#onboarding-checklist{padding:0 10px!important}}';
      document.head.appendChild(s);}
  }
  window._obDismiss=function(){saveField('checklistDismissed',true);};
  window._obDisableAll=function(){saveField('tutoDisabled',true);var el=document.getElementById('onboarding-checklist');if(el)el.remove();try{close();}catch(e){}try{cleanup();}catch(e){}};
  function maybeTour(p){var t=TOURS[PAGE];if(!t||p[t.id])return;
    setTimeout(function(){try{startTour(t);}catch(e){cleanup();}},t.delay||2500);}
  var _ov,_tt,_ix,_cf;
  function injectCSS(){if(document.getElementById('tour-css'))return;var s=document.createElement('style');s.id='tour-css';
    s.textContent='#tour-overlay{position:fixed;inset:0;z-index:10000;pointer-events:none;transition:opacity .3s}#tour-overlay.show{pointer-events:auto}#tour-spotlight{position:absolute;box-shadow:0 0 0 9999px rgba(15,31,92,.55);border-radius:10px;transition:all .4s cubic-bezier(.4,0,.2,1);pointer-events:none}#tour-tooltip{position:absolute;z-index:10001;background:#fff;border-radius:14px;padding:20px;width:360px;max-width:90vw;box-shadow:0 12px 40px rgba(15,31,92,.2);animation:tourIn .3s ease}@keyframes tourIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}#tour-tooltip .tt-title{font-size:15px;font-weight:800;color:#0f1f5c;margin-bottom:6px}#tour-tooltip .tt-text{font-size:13px;color:#64748b;line-height:1.6;margin-bottom:16px}#tour-tooltip .tt-footer{display:flex;align-items:center;justify-content:space-between}#tour-tooltip .tt-dots{display:flex;gap:5px;flex-wrap:wrap}#tour-tooltip .tt-dot{width:7px;height:7px;border-radius:50%;background:#e2e8f0;transition:background .2s}#tour-tooltip .tt-dot.on{background:#1a3dce}#tour-tooltip .tt-btns{display:flex;gap:8px}.tt-btn{padding:8px 16px;border-radius:8px;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;border:none;transition:.2s}.tt-btn-skip{background:#f1f5f9;color:#64748b}.tt-btn-skip:hover{background:#e2e8f0}.tt-btn-next{background:linear-gradient(135deg,#1a3dce,#4f7ef8);color:#fff;box-shadow:0 3px 10px rgba(26,61,206,.25)}.tt-btn-next:hover{opacity:.9}@media(max-width:768px){#tour-tooltip{width:300px;padding:16px}}';
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
    _tt.innerHTML='<div style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">'+_cf.title+' · '+(i+1)+'/'+steps.length+'</div><div class="tt-title">'+step.title+'</div><div class="tt-text">'+step.text+'</div><div class="tt-footer"><div class="tt-dots">'+dots+'</div><div class="tt-btns"><button class="tt-btn tt-btn-skip" onclick="window._tourClose()">Quitter</button><button class="tt-btn tt-btn-next" onclick="window._tourNext()">'+(i===steps.length-1?'✅ Terminé':'Suivant →')+'</button></div></div><div style="text-align:center;margin-top:10px"><button onclick="window._obDisableAll()" style="background:none;border:none;font-size:10px;color:#94a3b8;cursor:pointer;text-decoration:underline">Ne plus afficher les tutos</button></div>';
    var tw=360,gap=16,left=Math.max(10,Math.min(r.left+window.scrollX,window.innerWidth-tw-20));
    _tt.style.left=left+'px';
    _tt.style.top=(step.pos==='top'?Math.max(10,r.top+window.scrollY-gap-_tt.offsetHeight):(r.bottom+window.scrollY+gap))+'px';
    try{el.scrollIntoView({behavior:'smooth',block:'center'});}catch(e){}}
  function close(){try{if(_ov){_ov.remove();_ov=null;}}catch(e){}try{if(_tt){_tt.remove();_tt=null;}}catch(e){}if(_cf)saveField(_cf.id,true);_cf=null;}
  function cleanup(){try{var o=document.getElementById('tour-overlay');if(o)o.remove();}catch(e){}try{var t=document.getElementById('tour-tooltip');if(t)t.remove();}catch(e){}}
  window._tourNext=function(){try{if(_cf&&_ix<_cf.steps.length-1)show(_ix+1);else close();}catch(e){cleanup();}};
  window._tourClose=function(){try{close();}catch(e){cleanup();}};

})(); } catch(e) { /* silent */ }
