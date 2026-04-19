// ────────────────────────────────────────────────────────────────
// admin-panel.js — Widget admin pour Alteore
// ────────────────────────────────────────────────────────────────
// S'injecte UNIQUEMENT pour les users avec role === 'admin'.
// Si le user n'est pas admin, ne fait strictement rien : pas de bouton,
// pas de CSS, zéro impact visuel ou fonctionnel.
//
// Affiche un bouton flottant 🛠️ en bas à droite (uniquement pour admin)
// qui ouvre un panneau latéral avec tous les liens de config, admin,
// debug et outils techniques regroupés par catégorie.
//
// Dépendances : window._db, window._uid, window._doc, window._getDoc
// Chargé depuis nav.js → dispo sur toutes les pages du dashboard.
// ────────────────────────────────────────────────────────────────

(function () {
  if (window.__alteoreAdminPanelInit) return;
  window.__alteoreAdminPanelInit = true;
  console.log('[admin-panel] 🚀 script exécuté, en attente de Firebase + sidebar…');

  // ══════════════════════════════════════════════════════════════
  // CATALOGUE DES LIENS ADMIN
  // ══════════════════════════════════════════════════════════════
  var ADMIN_LINKS = [
    {
      category: '📰 Contenu & communication',
      color: '#7c3aed',
      items: [
        { icon: '🔔', title: 'Gérer les nouveautés', desc: 'Créer, éditer, publier les news in-app (pop-up + historique)', href: '/admin-updates.html' },
        { icon: '✍️', title: 'Gérer le blog', desc: 'Articles, rédaction IA, publication GitHub', href: '/admin-blog.html' },
      ],
    },
    {
      category: '🩺 Debug & diagnostic',
      color: '#dc2626',
      items: [
        { icon: '🔍', title: 'Diagnostics admin', desc: 'Vue détaillée des comptes users, debug Firestore', href: '/admin-debug-view.html' },
        { icon: '🏥', title: 'Diagnostic général', desc: 'Test connexion, santé du système', href: '/diagnostic.html' },
        { icon: '🏦', title: 'Debug banque', desc: 'Log des connexions bancaires Bridge', href: '/api/bank-debug', note: 'API — ouvre en onglet' },
        { icon: '📧', title: 'Test email Resend', desc: 'Envoyer un email de test pour vérifier la config', href: '/api/send-debug-email', note: 'API — ouvre en onglet' },
      ],
    },
    {
      category: '💳 Crédits & facturation',
      color: '#059669',
      items: [
        { icon: '🔧', title: 'Correction crédits SMS', desc: 'Réinitialiser ou corriger les crédits SMS d\'un user', href: '/fix-credits.html' },
        { icon: '🧹', title: 'Cleanup crédits', desc: 'Nettoyage auto des crédits obsolètes', href: '/api/admin-cleanup-credits', note: 'API — ouvre en onglet' },
      ],
    },
    {
      category: '🌱 Seed & configuration',
      color: '#c48a1a',
      items: [
        { icon: '🌱', title: 'Seed nouveautés initiales', desc: 'Insère les 4 news pré-remplies (one-shot)', href: '/seed-updates.html', note: 'À supprimer après usage' },
      ],
    },
    {
      category: '🔗 Dashboards externes',
      color: '#1e40af',
      items: [
        { icon: '💳', title: 'Stripe Dashboard', desc: 'Abonnements, paiements, webhooks', href: 'https://dashboard.stripe.com/dashboard', external: true },
        { icon: '🔥', title: 'Firebase Console', desc: 'Firestore, Auth, rules, logs', href: 'https://console.firebase.google.com/project/altiora-70599', external: true },
        { icon: '▲', title: 'Vercel Dashboard', desc: 'Déploiements, logs, env vars, crons', href: 'https://vercel.com/dashboard', external: true },
        { icon: '📬', title: 'Resend Dashboard', desc: 'Logs emails envoyés, statut délivrabilité', href: 'https://resend.com/emails', external: true },
        { icon: '🌉', title: 'Bridge API', desc: 'Connexions bancaires en prod', href: 'https://dashboard.bridgeapi.io', external: true },
        { icon: '🤖', title: 'Anthropic Console', desc: 'Usage Claude API, logs, spend', href: 'https://console.anthropic.com/dashboard', external: true },
      ],
    },
  ];

  // ══════════════════════════════════════════════════════════════
  // CSS
  // ══════════════════════════════════════════════════════════════
  var css = `
    /* Bouton flottant admin */
    #alt-admin-fab {
      position: fixed;
      bottom: 22px; right: 22px;
      width: 52px; height: 52px;
      border-radius: 50%;
      background: linear-gradient(135deg, #111827 0%, #1e293b 100%);
      color: #fff;
      display: flex; align-items: center; justify-content: center;
      font-size: 22px;
      cursor: pointer;
      box-shadow: 0 6px 20px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,255,255,0.08);
      z-index: 9996;
      transition: transform 0.2s, box-shadow 0.2s;
      border: none;
      font-family: inherit;
    }
    #alt-admin-fab:hover {
      transform: scale(1.08) rotate(8deg);
      box-shadow: 0 10px 28px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.15);
    }
    #alt-admin-fab::after {
      content: 'ADMIN';
      position: absolute;
      top: -6px; right: -6px;
      background: #dc2626;
      color: #fff;
      font-size: 8px;
      font-weight: 800;
      padding: 2px 5px;
      border-radius: 6px;
      letter-spacing: 0.5px;
      border: 2px solid #0f172a;
    }

    /* Overlay */
    #alt-admin-overlay {
      position: fixed; inset: 0;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(4px);
      z-index: 9997;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.2s, visibility 0.2s;
    }
    #alt-admin-overlay.show { opacity: 1; visibility: visible; }

    /* Panneau */
    #alt-admin-panel {
      position: fixed;
      top: 0; right: 0; bottom: 0;
      width: 100%; max-width: 560px;
      background: #f8fafc;
      box-shadow: -12px 0 40px rgba(0,0,0,0.25);
      z-index: 9998;
      transform: translateX(100%);
      transition: transform 0.32s cubic-bezier(.2,.8,.2,1);
      display: flex; flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    #alt-admin-panel.show { transform: translateX(0); }
    #alt-admin-panel .head {
      padding: 24px 28px 18px;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      color: #fff;
      display: flex; align-items: center; justify-content: space-between;
      flex-shrink: 0;
    }
    #alt-admin-panel .head-title h2 {
      margin: 0; font-size: 20px; font-weight: 800; line-height: 1.2;
    }
    #alt-admin-panel .head-title p {
      margin: 4px 0 0; font-size: 12px; opacity: 0.65; font-weight: 500;
    }
    #alt-admin-panel .close {
      background: rgba(255,255,255,0.12);
      border: 1px solid rgba(255,255,255,0.2);
      color: #fff;
      width: 32px; height: 32px;
      border-radius: 8px;
      cursor: pointer; font-size: 16px;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.15s;
    }
    #alt-admin-panel .close:hover { background: rgba(255,255,255,0.22); }
    #alt-admin-panel .body {
      flex: 1; overflow-y: auto;
      padding: 8px 20px 28px;
    }
    #alt-admin-panel .category {
      margin-top: 22px;
    }
    #alt-admin-panel .cat-title {
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      padding: 6px 0 10px;
      margin: 0;
    }
    #alt-admin-panel .item-link {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 14px 16px;
      text-decoration: none;
      color: #0f172a;
      margin-bottom: 8px;
      transition: all 0.18s;
      cursor: pointer;
    }
    #alt-admin-panel .item-link:hover {
      border-color: #94a3b8;
      background: #fff;
      transform: translateX(-2px);
      box-shadow: 0 2px 8px rgba(0,0,0,0.05);
    }
    #alt-admin-panel .item-icon {
      font-size: 22px; line-height: 1; flex-shrink: 0;
      width: 32px; height: 32px;
      display: flex; align-items: center; justify-content: center;
    }
    #alt-admin-panel .item-body { flex: 1; min-width: 0; }
    #alt-admin-panel .item-title {
      font-size: 14px; font-weight: 700; color: #0f172a;
      line-height: 1.3; margin: 0;
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    }
    #alt-admin-panel .item-title .ext-ico {
      font-size: 11px; opacity: 0.5;
    }
    #alt-admin-panel .item-desc {
      font-size: 12px; color: #64748b;
      margin-top: 3px; line-height: 1.45;
    }
    #alt-admin-panel .item-note {
      display: inline-block;
      font-size: 10.5px;
      font-weight: 700;
      background: #fef3c7;
      color: #92400e;
      padding: 2px 7px;
      border-radius: 6px;
      margin-top: 5px;
    }

    /* Badge user info en bas */
    #alt-admin-panel .foot {
      padding: 14px 20px 18px;
      border-top: 1px solid #e2e8f0;
      background: #fff;
      font-size: 11px; color: #64748b;
      display: flex; justify-content: space-between; align-items: center;
      flex-shrink: 0;
    }
    #alt-admin-panel .foot code {
      background: #f1f5f9;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: ui-monospace, Menlo, monospace;
      font-size: 10.5px;
      color: #334155;
    }

    /* Mobile */
    @media (max-width: 640px) {
      #alt-admin-panel { max-width: 100%; }
      #alt-admin-fab { bottom: 16px; right: 16px; width: 46px; height: 46px; font-size: 18px; }
    }

    /* Section admin injectée dans la sidebar nav.js */
    #alt-admin-sidebar {
      margin: 12px 0 6px;
      padding: 10px 0 6px;
      border-top: 1px solid rgba(220, 38, 38, 0.18);
    }
    #alt-admin-sidebar .admin-label {
      font-size: 10px;
      font-weight: 800;
      color: #fca5a5;
      letter-spacing: 1.5px;
      padding: 4px 20px 8px;
      display: flex;
      align-items: center;
      gap: 6px;
      text-transform: uppercase;
    }
    #alt-admin-sidebar .admin-label::before {
      content: '🛠️';
      font-size: 11px;
    }
    #alt-admin-sidebar .admin-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 20px;
      color: rgba(254, 226, 226, 0.7);
      font-size: 12.5px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
      border-left: 3px solid transparent;
      user-select: none;
    }
    #alt-admin-sidebar .admin-item:hover {
      color: #fecaca;
      background: rgba(239, 68, 68, 0.08);
      border-left-color: #ef4444;
    }
    #alt-admin-sidebar .admin-item .admin-ico {
      font-size: 13px;
      width: 16px;
      text-align: center;
      flex-shrink: 0;
    }
    #alt-admin-sidebar .admin-item .admin-ext {
      margin-left: auto;
      font-size: 9px;
      opacity: 0.5;
    }
  `;
  var styleEl = document.createElement('style');
  styleEl.id = 'alt-admin-panel-style';
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ══════════════════════════════════════════════════════════════
  // Helpers
  // ══════════════════════════════════════════════════════════════
  function waitForFirebase(cb, tries) {
    tries = tries || 0;
    var fbReady = window._uid && window._getDoc && window._db && window._doc;
    var slotReady = !!document.getElementById('nav-admin-slot');
    if (fbReady && slotReady) {
      console.log('[admin-panel] ✓ ready after ' + tries + ' ticks');
      cb();
    } else if (tries < 200) {  // 200 × 150ms = 30 secondes max
      if (tries === 20) console.log('[admin-panel] ⏳ still waiting... fb:', fbReady, 'slot:', slotReady);
      if (tries === 100) console.warn('[admin-panel] ⏳ still waiting after 15s — fb:', fbReady, 'slot:', slotReady);
      setTimeout(function () { waitForFirebase(cb, tries + 1); }, 150);
    } else {
      console.warn('[admin-panel] ❌ TIMEOUT after 30s — fb:', fbReady, 'slot:', slotReady, '— widget NOT injected');
    }
  }

  async function isUserAdmin() {
    console.log('[admin-panel] check role for uid:', window._uid);
    try {
      var snap = await window._getDoc(window._doc(window._db, 'users', window._uid));
      if (!snap.exists()) {
        console.warn('[admin-panel] ❌ user doc does not exist');
        return false;
      }
      var data = snap.data();
      console.log('[admin-panel] user.role =', JSON.stringify(data.role), 'typeof:', typeof data.role);
      var isAdmin = data.role === 'admin';
      if (!isAdmin) {
        console.log('[admin-panel] ℹ️ not admin — widget will not be injected');
      }
      return isAdmin;
    } catch (e) {
      console.warn('[admin-panel] ❌ isAdmin check failed:', e && e.message, e);
      return false;
    }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ══════════════════════════════════════════════════════════════
  // UI
  // ══════════════════════════════════════════════════════════════
  function injectFab() {
    if (document.getElementById('alt-admin-fab')) return;
    var fab = document.createElement('button');
    fab.id = 'alt-admin-fab';
    fab.type = 'button';
    fab.title = 'Panneau admin';
    fab.innerHTML = '🛠️';
    fab.addEventListener('click', openPanel);
    document.body.appendChild(fab);
  }

  function renderPanel() {
    // Nettoyer ancien rendu
    var oldOverlay = document.getElementById('alt-admin-overlay');
    if (oldOverlay) oldOverlay.remove();
    var oldPanel = document.getElementById('alt-admin-panel');
    if (oldPanel) oldPanel.remove();

    var overlay = document.createElement('div');
    overlay.id = 'alt-admin-overlay';
    overlay.addEventListener('click', closePanel);
    document.body.appendChild(overlay);

    var panel = document.createElement('div');
    panel.id = 'alt-admin-panel';

    // Construire les catégories
    var categoriesHtml = ADMIN_LINKS.map(function (cat) {
      var itemsHtml = cat.items.map(function (item) {
        var target = item.external ? ' target="_blank" rel="noopener noreferrer"' : '';
        var extIco = item.external ? ' <span class="ext-ico">↗</span>' : '';
        return (
          '<a class="item-link" href="' + escapeHtml(item.href) + '"' + target + '>' +
            '<div class="item-icon">' + escapeHtml(item.icon) + '</div>' +
            '<div class="item-body">' +
              '<div class="item-title">' + escapeHtml(item.title) + extIco + '</div>' +
              '<div class="item-desc">' + escapeHtml(item.desc) + '</div>' +
              (item.note ? '<span class="item-note">' + escapeHtml(item.note) + '</span>' : '') +
            '</div>' +
          '</a>'
        );
      }).join('');
      return (
        '<div class="category">' +
          '<div class="cat-title" style="color:' + cat.color + ';">' + escapeHtml(cat.category) + '</div>' +
          itemsHtml +
        '</div>'
      );
    }).join('');

    var total = ADMIN_LINKS.reduce(function (acc, c) { return acc + c.items.length; }, 0);

    panel.innerHTML =
      '<div class="head">' +
        '<div class="head-title">' +
          '<h2>🛠️ Panneau admin</h2>' +
          '<p>' + total + ' outils · ' + ADMIN_LINKS.length + ' catégories</p>' +
        '</div>' +
        '<button class="close" title="Fermer">✕</button>' +
      '</div>' +
      '<div class="body">' + categoriesHtml + '</div>' +
      '<div class="foot">' +
        '<span>Connecté admin</span>' +
        '<code>uid: ' + (window._uid || '?').slice(0, 8) + '…</code>' +
      '</div>';

    document.body.appendChild(panel);

    panel.querySelector('.close').addEventListener('click', closePanel);

    // Animer
    setTimeout(function () {
      overlay.classList.add('show');
      panel.classList.add('show');
    }, 10);
  }

  function openPanel() {
    renderPanel();
  }

  function closePanel() {
    var overlay = document.getElementById('alt-admin-overlay');
    var panel = document.getElementById('alt-admin-panel');
    if (overlay) overlay.classList.remove('show');
    if (panel) panel.classList.remove('show');
    setTimeout(function () {
      if (overlay) overlay.remove();
      if (panel) panel.remove();
    }, 320);
  }

  // ══════════════════════════════════════════════════════════════
  // INJECTION DANS LA SIDEBAR (nav.js)
  // Remplit le slot #nav-admin-slot avec les principaux liens admin
  // La liste complète reste dans le panneau flottant (bouton 🛠️).
  // ══════════════════════════════════════════════════════════════
  function injectSidebarSection() {
    var slot = document.getElementById('nav-admin-slot');
    if (!slot) {
      // Pas de slot → la page ne charge pas nav.js, pas grave on reste silencieux
      return;
    }
    if (slot.querySelector('#alt-admin-sidebar')) return; // déjà injecté

    // Sélection des liens prioritaires pour la sidebar (pas tous)
    // Les autres restent accessibles via le bouton flottant 🛠️
    var sidebarLinks = [
      { icon: '🔔', title: 'Nouveautés', href: '/admin-updates.html' },
      { icon: '✍️', title: 'Blog', href: '/admin-blog.html' },
      { icon: '🩺', title: 'Diagnostics', href: '/admin-debug-view.html' },
      { icon: '🏥', title: 'Diagnostic général', href: '/diagnostic.html' },
      { icon: '🔧', title: 'Correction crédits', href: '/fix-credits.html' },
      { icon: '🛠️', title: 'Tous les outils', href: '#', onclick: 'openFloatingPanel' },
    ];

    var itemsHtml = sidebarLinks.map(function (link) {
      var onclick = link.onclick === 'openFloatingPanel'
        ? 'data-action="open-panel"'
        : 'onclick="location.href=\'' + link.href + '\'"';
      return (
        '<div class="admin-item" ' + onclick + ' title="' + escapeHtml(link.title) + '">' +
          '<span class="admin-ico">' + escapeHtml(link.icon) + '</span>' +
          '<span>' + escapeHtml(link.title) + '</span>' +
        '</div>'
      );
    }).join('');

    slot.innerHTML =
      '<div id="alt-admin-sidebar">' +
        '<div class="admin-label">Administration</div>' +
        itemsHtml +
      '</div>';

    // Wire l'action "ouvrir panneau flottant"
    var openBtn = slot.querySelector('[data-action="open-panel"]');
    if (openBtn) openBtn.addEventListener('click', openPanel);
  }

  // ══════════════════════════════════════════════════════════════
  // INIT
  // ══════════════════════════════════════════════════════════════
  async function init() {
    try {
      var admin = await isUserAdmin();
      if (!admin) return; // ne rien faire si pas admin
      injectFab();
      injectSidebarSection();
      // Re-tenter l'injection sidebar si nav.js injecte après nous (race condition)
      setTimeout(injectSidebarSection, 500);
      setTimeout(injectSidebarSection, 1500);
      console.log('[admin-panel] ✅ Initialized for admin (fab + sidebar)');
    } catch (e) {
      console.warn('[admin-panel] init failed:', e);
    }
  }

  waitForFirebase(init);
})();
