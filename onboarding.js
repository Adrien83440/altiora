// ── onboarding.js — Alteore ── v1.1
// Checklist dashboard + tours guidés par module
// 100% overlay — ne modifie AUCUN fichier existant
// Chargé via nav.js · Si crash → meurt silencieusement
try { (function () {

  var PAGE = location.pathname.split('/').pop() || 'dashboard.html';
  var CHECKLIST_DAYS = 7;

  // ════════════════════════════════════════════════
  // FIREBASE COMPAT — certaines pages utilisent _fbGetDoc au lieu de _getDoc
  // ════════════════════════════════════════════════
  function fbGetDoc() { return window._getDoc || window._fbGetDoc; }
  function fbSetDoc() { return window._setDoc || window._fbSetDoc; }
  function fbDoc()    { return window._doc    || window._fbDoc; }

  // ════════════════════════════════════════════════
  // CHECKLIST — ÉTAPES
  // ════════════════════════════════════════════════
  var STEPS = [
    { id: 'profil',    icon: '🏢', title: 'Complétez votre profil entreprise',     desc: 'Nom, secteur, ville — pour personnaliser votre espace.',                     link: 'profil.html',       cta: 'Compléter →' },
    { id: 'ca',        icon: '📈', title: 'Saisissez votre CA du mois',            desc: 'Entrez vos recettes journalières dans le pilotage financier.',                link: 'pilotage.html',     cta: 'Saisir →' },
    { id: 'charges',   icon: '💰', title: 'Ajoutez vos charges',                   desc: 'Charges fixes et variables pour calculer votre résultat.',                    link: 'pilotage.html',     cta: 'Ajouter →' },
    { id: 'produit',   icon: '🧮', title: 'Créez votre premier produit',           desc: 'Calculez votre coût de revient et votre marge.',                              link: 'cout-revient.html', cta: 'Créer →' },
    { id: 'dashboard', icon: '📊', title: 'Explorez votre tableau de bord',        desc: 'Découvrez vos KPIs, graphiques et l\'analyse de votre activité.',             link: 'dashboard.html',    cta: 'Explorer →' },
  ];

  // ════════════════════════════════════════════════
  // TOURS PAR MODULE
  // ════════════════════════════════════════════════
  var TOURS = {
    'pilotage.html': {
      id: 'tour_pilotage',
      title: '🧭 Découverte du Pilotage',
      delay: 4000,
      steps: [
        { target: '#kpi-summary',  title: 'Résumé mensuel',          text: 'Vos 5 KPIs essentiels : CA, charges, résultat, TVA collectée et TVA due. Ils se mettent à jour en temps réel.', pos: 'bottom' },
        { target: '#ca-tbody',     title: 'Saisie du CA journalier', text: 'Entrez votre chiffre d\'affaires jour par jour, réparti par taux de TVA. Toggle HT/TTC disponible en haut.', pos: 'bottom' },
        { target: '#cf-tbody',     title: 'Charges fixes',           text: 'Loyer, assurances, salaires, abonnements… Cliquez "+ Ligne" pour ajouter vos charges récurrentes.', pos: 'top' },
        { target: '#cv-tbody',     title: 'Charges variables',       text: 'Achats, matières premières, frais ponctuels. Le résultat se recalcule automatiquement.', pos: 'top' },
      ]
    },
    'fidelisation.html': {
      id: 'tour_fidelite',
      title: '💎 Découverte de la Fidélisation',
      delay: 2500,
      steps: [
        { target: '[data-tab="dashboard"]', title: 'Dashboard fidélité',    text: 'Vue d\'ensemble : clients, points distribués, coupons actifs et campagnes envoyées.', pos: 'bottom' },
        { target: '[data-tab="clients"]',   title: 'Vos clients',          text: 'Ajoutez vos clients manuellement ou via la tablette en magasin. Chaque client a sa fiche.', pos: 'bottom' },
        { target: '[data-tab="carte"]',     title: 'Carte de fidélité',    text: 'Configurez votre carte digitale : logo, couleurs, barème de points. Visible sur le téléphone de vos clients.', pos: 'bottom' },
        { target: '[data-tab="campagnes"]', title: 'Campagnes SMS',        text: 'Envoyez des SMS ciblés : promotions, anniversaires, relances. Achetez des crédits dans la boutique.', pos: 'bottom' },
      ]
    },
    'rh-dashboard.html': {
      id: 'tour_rh',
      title: '👥 Découverte du Module RH',
      delay: 2500,
      steps: [
        { target: '#kpi-row',                          title: 'KPIs Équipe',        text: 'Effectif, masse salariale, congés en cours et alertes. Un résumé instantané de votre équipe.', pos: 'bottom' },
        { target: 'button[onclick*="rh-employes"]',    title: 'Fiches employés',    text: 'Créez la fiche de chaque salarié : contrat, horaires, salaire, documents. Tout est centralisé.', pos: 'bottom' },
        { target: 'button[onclick*="rh-conges"]',      title: 'Gestion des congés', text: 'Vos employés peuvent demander des congés depuis leur espace. Vous validez en un clic.', pos: 'bottom' },
        { target: 'button[onclick*="rh-recrutement"]', title: 'Recrutement',        text: 'Publiez des offres, suivez les candidatures et planifiez les entretiens.', pos: 'bottom' },
      ]
    },
  };

  // ════════════════════════════════════════════════
  // FIREBASE HELPERS (fail-safe)
  // ════════════════════════════════════════════════
  function waitReady(cb, n) {
    n = n || 0;
    // Accepte _getDoc OU _fbGetDoc (fidelisation utilise le 2e)
    if (window._uid && window._db && (window._getDoc || window._fbGetDoc) && (window._setDoc || window._fbSetDoc)) {
      try { cb(); } catch(e) {}
    }
    else if (n < 40) setTimeout(function () { waitReady(cb, n + 1); }, 150);
  }

  function loadProgress(cb) {
    try {
      fbGetDoc()(fbDoc()(window._db, 'tuto_progress', window._uid))
        .then(function (snap) { cb(snap.exists() ? snap.data() : {}); })
        .catch(function () { cb({}); });
    } catch(e) { cb({}); }
  }

  function saveField(field, val) {
    try {
      var data = {}; data[field] = val;
      fbSetDoc()(fbDoc()(window._db, 'tuto_progress', window._uid), data, { merge: true }).catch(function () {});
    } catch(e) {}
  }

  // ════════════════════════════════════════════════
  // INIT (fail-safe)
  // ════════════════════════════════════════════════
  waitReady(function () {
    loadProgress(function (progress) {
      try { if (PAGE === 'dashboard.html') injectChecklist(progress); } catch(e) {}
      try { if (TOURS[PAGE]) maybeTour(progress); } catch(e) {}
    });
  });

  // ════════════════════════════════════════════════
  // AUTO-CHECK (visite page = étape cochée)
  // ════════════════════════════════════════════════
  waitReady(function () {
    try {
      if (PAGE === 'profil.html') {
        fbGetDoc()(fbDoc()(window._db, 'profil', window._uid, 'data', 'profil'))
          .then(function (s) { if (s.exists() && s.data().nom) saveField('step_profil', true); })
          .catch(function () {});
      }
      if (PAGE === 'pilotage.html')     setTimeout(function () { saveField('step_ca', true); saveField('step_charges', true); }, 8000);
      if (PAGE === 'cout-revient.html') setTimeout(function () { saveField('step_produit', true); }, 5000);
      if (PAGE === 'dashboard.html')    setTimeout(function () { saveField('step_dashboard', true); }, 8000);
    } catch(e) {}
  });

  // ════════════════════════════════════════════════
  // CHECKLIST (dashboard.html uniquement)
  // Injecté AVANT #mainContent (pas dedans — car le dashboard
  // fait mainContent.innerHTML= qui écraserait tout)
  // ════════════════════════════════════════════════
  function injectChecklist(progress) {
    if (progress.checklistDismissed) return;

    fbGetDoc()(fbDoc()(window._db, 'users', window._uid))
      .then(function (snap) {
        if (!snap.exists()) return;
        var d = snap.data();
        var created = d.createdAt;
        if (created) {
          var createdDate = created.toDate ? created.toDate() : new Date(created);
          var daysSince = (Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24);
          if (daysSince > CHECKLIST_DAYS) return;
        }
        try { renderChecklist(progress); } catch(e) {}
      })
      .catch(function () {});
  }

  function renderChecklist(progress) {
    var completed = 0;
    STEPS.forEach(function (s) { if (progress['step_' + s.id]) completed++; });
    var allDone = completed === STEPS.length;
    var pct = Math.round(completed / STEPS.length * 100);

    var el = document.createElement('div');
    el.id = 'onboarding-checklist';
    el.style.cssText = 'padding:0 32px;animation:obFadeIn .4s ease';

    el.innerHTML =
      '<div style="margin:20px 0;background:white;border:2px solid ' + (allDone ? '#86efac' : '#c7d2fe') + ';border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(15,31,92,.06)">' +
        '<div style="padding:20px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;background:' + (allDone ? 'linear-gradient(135deg,#f0fdf4,#ecfdf5)' : 'linear-gradient(135deg,#f0f4ff,#f5f7ff)') + '">' +
          '<div>' +
            '<div style="font-size:16px;font-weight:800;color:#0f1f5c;display:flex;align-items:center;gap:8px">' + (allDone ? '🎉 Bravo, tout est configuré !' : '🚀 Premiers pas avec Alteore') + '</div>' +
            '<div style="font-size:12px;color:#64748b;margin-top:3px">' + completed + '/' + STEPS.length + ' étapes complétées' + (allDone ? '' : ' · Suivez le guide pour bien démarrer') + '</div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:12px">' +
            '<div style="width:80px;height:8px;background:#e2e8f0;border-radius:99px;overflow:hidden"><div style="height:100%;width:' + pct + '%;background:' + (allDone ? '#10b981' : 'linear-gradient(90deg,#1a3dce,#4f7ef8)') + ';border-radius:99px;transition:width .6s"></div></div>' +
            '<span style="font-size:13px;font-weight:800;color:' + (allDone ? '#059669' : '#1a3dce') + '">' + pct + '%</span>' +
            '<button onclick="document.getElementById(\'onboarding-checklist\').remove();window._obDismiss()" style="background:none;border:none;font-size:16px;color:#94a3b8;cursor:pointer;padding:4px" title="Masquer">✕</button>' +
          '</div>' +
        '</div>' +
        '<div style="padding:12px 16px;display:flex;flex-direction:column;gap:2px">' +
          STEPS.map(function (s, i) {
            var done = !!progress['step_' + s.id];
            return '<div style="display:flex;align-items:center;gap:14px;padding:12px 10px;border-radius:10px;transition:background .15s;' + (done ? 'opacity:.6' : 'cursor:pointer;background:#fafbff') + '" ' +
              (done ? '' : 'onclick="location.href=\'' + s.link + '\'" onmouseover="this.style.background=\'#f0f4ff\'" onmouseout="this.style.background=\'#fafbff\'"') + '>' +
              '<div style="width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;' + (done ? 'background:#dcfce7;color:#16a34a' : 'background:#f0f4ff;border:2px solid #c7d2fe;color:#6366f1') + '">' + (done ? '✓' : (i + 1)) + '</div>' +
              '<div style="flex:1;min-width:0">' +
                '<div style="font-size:13px;font-weight:700;color:' + (done ? '#94a3b8' : '#1e293b') + ';' + (done ? 'text-decoration:line-through' : '') + '">' + s.icon + ' ' + s.title + '</div>' +
                '<div style="font-size:12px;color:#94a3b8;margin-top:2px">' + s.desc + '</div>' +
              '</div>' +
              (done ? '' : '<div style="font-size:12px;font-weight:700;color:#1a3dce;white-space:nowrap">' + s.cta + '</div>') +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>';

    // Injecter ENTRE la topbar et le contenu (sibling, pas enfant de mainContent)
    // Comme ça, mainContent.innerHTML= ne l'écrase pas
    var mainContent = document.getElementById('mainContent') || document.querySelector('.content');
    if (mainContent && mainContent.parentNode) {
      mainContent.parentNode.insertBefore(el, mainContent);
    }

    if (!document.getElementById('ob-css')) {
      var style = document.createElement('style');
      style.id = 'ob-css';
      style.textContent = '@keyframes obFadeIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}} @media(max-width:768px){#onboarding-checklist{padding:0 10px !important}}';
      document.head.appendChild(style);
    }
  }

  window._obDismiss = function () { saveField('checklistDismissed', true); };

  // ════════════════════════════════════════════════
  // TOUR GUIDÉ (overlay pur — z-index 10000+)
  // ════════════════════════════════════════════════
  function maybeTour(progress) {
    var tour = TOURS[PAGE];
    if (!tour || progress[tour.id]) return;
    var delay = tour.delay || 2500;
    setTimeout(function () { try { startTour(tour); } catch(e) { cleanupTour(); } }, delay);
  }

  var _tourOv, _tourTt, _tourIdx, _tourCfg;

  function injectTourCSS() {
    if (document.getElementById('tour-css')) return;
    var s = document.createElement('style');
    s.id = 'tour-css';
    s.textContent =
      '#tour-overlay{position:fixed;inset:0;z-index:10000;pointer-events:none;transition:opacity .3s}' +
      '#tour-overlay.show{pointer-events:auto}' +
      '#tour-spotlight{position:absolute;box-shadow:0 0 0 9999px rgba(15,31,92,.55);border-radius:10px;transition:all .4s cubic-bezier(.4,0,.2,1);pointer-events:none}' +
      '#tour-tooltip{position:absolute;z-index:10001;background:white;border-radius:14px;padding:20px;width:340px;max-width:90vw;box-shadow:0 12px 40px rgba(15,31,92,.2);animation:tourIn .3s ease}' +
      '@keyframes tourIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}' +
      '#tour-tooltip .tt-title{font-size:15px;font-weight:800;color:#0f1f5c;margin-bottom:6px}' +
      '#tour-tooltip .tt-text{font-size:13px;color:#64748b;line-height:1.6;margin-bottom:16px}' +
      '#tour-tooltip .tt-footer{display:flex;align-items:center;justify-content:space-between}' +
      '#tour-tooltip .tt-dots{display:flex;gap:6px}' +
      '#tour-tooltip .tt-dot{width:8px;height:8px;border-radius:50%;background:#e2e8f0;transition:background .2s}' +
      '#tour-tooltip .tt-dot.on{background:#1a3dce}' +
      '#tour-tooltip .tt-btns{display:flex;gap:8px}' +
      '.tt-btn{padding:8px 16px;border-radius:8px;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;border:none;transition:.2s}' +
      '.tt-btn-skip{background:#f1f5f9;color:#64748b}.tt-btn-skip:hover{background:#e2e8f0}' +
      '.tt-btn-next{background:linear-gradient(135deg,#1a3dce,#4f7ef8);color:white;box-shadow:0 3px 10px rgba(26,61,206,.25)}.tt-btn-next:hover{opacity:.9}' +
      '@media(max-width:768px){#tour-tooltip{width:280px;padding:16px}}';
    document.head.appendChild(s);
  }

  function startTour(tour) {
    _tourCfg = tour;
    _tourIdx = 0;
    injectTourCSS();

    _tourOv = document.createElement('div');
    _tourOv.id = 'tour-overlay';
    _tourOv.innerHTML = '<div id="tour-spotlight"></div>';
    _tourOv.addEventListener('click', function (e) { if (e.target === _tourOv) closeTour(); });
    document.body.appendChild(_tourOv);

    _tourTt = document.createElement('div');
    _tourTt.id = 'tour-tooltip';
    document.body.appendChild(_tourTt);

    setTimeout(function () { _tourOv.classList.add('show'); showStep(0); }, 100);
  }

  function showStep(idx) {
    _tourIdx = idx;
    var steps = _tourCfg.steps;
    var step = steps[idx];
    if (!step) { closeTour(); return; }

    var target = null;
    try { target = document.querySelector(step.target); } catch(e) {}
    if (!target) {
      if (idx < steps.length - 1) showStep(idx + 1);
      else closeTour();
      return;
    }

    var rect = target.getBoundingClientRect();
    var pad = 8;
    var spot = document.getElementById('tour-spotlight');
    if (spot) {
      spot.style.top = (rect.top + window.scrollY - pad) + 'px';
      spot.style.left = (rect.left + window.scrollX - pad) + 'px';
      spot.style.width = (rect.width + pad * 2) + 'px';
      spot.style.height = (rect.height + pad * 2) + 'px';
    }

    var dots = '';
    for (var i = 0; i < steps.length; i++) dots += '<div class="tt-dot ' + (i === idx ? 'on' : '') + '"></div>';
    var isLast = idx === steps.length - 1;

    _tourTt.innerHTML =
      '<div style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">' + _tourCfg.title + ' · ' + (idx + 1) + '/' + steps.length + '</div>' +
      '<div class="tt-title">' + step.title + '</div>' +
      '<div class="tt-text">' + step.text + '</div>' +
      '<div class="tt-footer">' +
        '<div class="tt-dots">' + dots + '</div>' +
        '<div class="tt-btns">' +
          '<button class="tt-btn tt-btn-skip" onclick="window._tourClose()">Quitter</button>' +
          '<button class="tt-btn tt-btn-next" onclick="window._tourNext()">' + (isLast ? '✅ Terminé' : 'Suivant →') + '</button>' +
        '</div>' +
      '</div>';

    var ttW = 340, gap = 16;
    var left = Math.max(10, Math.min(rect.left + window.scrollX, window.innerWidth - ttW - 20));
    if (step.pos === 'top') {
      _tourTt.style.top = Math.max(10, rect.top + window.scrollY - gap - _tourTt.offsetHeight) + 'px';
    } else {
      _tourTt.style.top = (rect.bottom + window.scrollY + gap) + 'px';
    }
    _tourTt.style.left = left + 'px';

    try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(e) {}
  }

  function closeTour() {
    try { if (_tourOv) { _tourOv.remove(); _tourOv = null; } } catch(e) {}
    try { if (_tourTt) { _tourTt.remove(); _tourTt = null; } } catch(e) {}
    if (_tourCfg) saveField(_tourCfg.id, true);
    _tourCfg = null;
  }

  function cleanupTour() {
    try { var ov = document.getElementById('tour-overlay'); if (ov) ov.remove(); } catch(e) {}
    try { var tt = document.getElementById('tour-tooltip'); if (tt) tt.remove(); } catch(e) {}
  }

  window._tourNext = function () {
    try {
      if (_tourCfg && _tourIdx < _tourCfg.steps.length - 1) showStep(_tourIdx + 1);
      else closeTour();
    } catch(e) { cleanupTour(); }
  };
  window._tourClose = function () { try { closeTour(); } catch(e) { cleanupTour(); } };

})(); } catch(e) { /* onboarding crash — silencieux */ }
