// ────────────────────────────────────────────────────────────────
// updates.js — Alteore News / Changelog in-app
// ────────────────────────────────────────────────────────────────
// Injecte une icône 🔔 à droite du logo Alteore dans la sidebar.
// Au login, affiche une pop-up avec la dernière news si non lue.
// Clic sur l'icône → panneau historique complet des updates.
//
// Dépendances :
//   - window._db, window._doc, window._getDoc, window._uid (Firebase déjà init)
//   - Chargé en fin de nav.js (le logo doit déjà être injecté)
//
// Collection Firestore utilisée :
//   updates/{updateId}
//     - title       : string (ex: "Léa sait maintenant corriger ton CA")
//     - emoji       : string (ex: "🛠️")
//     - date        : string ISO "YYYY-MM-DD" (date d'affichage)
//     - version     : string (ex: "Wave 3.9", optionnel)
//     - badge       : string (ex: "New" | "Fix" | "Amélioration")
//     - short       : string (résumé 1-2 phrases pour la pop-up)
//     - long_html   : string (description longue HTML pour le panneau)
//     - published   : boolean (true pour afficher, false pour masquer)
//     - order       : number (tri décroissant, plus grand = plus récent)
//     - createdAt   : timestamp
//
// État user :
//   users/{uid}.lastReadUpdateId : string | null (id de la news la plus récente lue)
// ────────────────────────────────────────────────────────────────

(function () {
  if (window.__alteoreUpdatesInit) return;
  window.__alteoreUpdatesInit = true;

  // ────────────────────────────────────────────────────────────
  // CSS — style des composants
  // ────────────────────────────────────────────────────────────
  var css = `
    /* Icône News dans la sidebar */
    #alt-updates-bell {
      position: relative;
      margin-left: auto;
      width: 32px; height: 32px;
      display: flex; align-items: center; justify-content: center;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px;
      cursor: pointer;
      font-size: 16px;
      transition: all 0.18s;
      flex-shrink: 0;
    }
    #alt-updates-bell:hover {
      background: rgba(255,255,255,0.15);
      border-color: rgba(255,255,255,0.25);
      transform: scale(1.05);
    }
    #alt-updates-bell .badge-count {
      position: absolute;
      top: -4px; right: -4px;
      background: #ef4444;
      color: #fff;
      font-size: 9px;
      font-weight: 800;
      min-width: 16px; height: 16px;
      border-radius: 99px;
      display: flex; align-items: center; justify-content: center;
      padding: 0 4px;
      border: 2px solid #162366;
      animation: alt-badge-pulse 2s infinite;
    }
    #alt-updates-bell .badge-count.hidden { display: none; }
    @keyframes alt-badge-pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.1); }
    }

    /* Mode fidé/rh : adapter la couleur du bord */
    nav#alteore-nav.rh-mode #alt-updates-bell { border-color: rgba(52,211,153,0.2); }
    nav#alteore-nav.fid-mode #alt-updates-bell { border-color: rgba(251,191,36,0.2); }

    /* Panneau historique (modal latéral) */
    #alt-updates-overlay {
      position: fixed; inset: 0;
      background: rgba(10, 14, 30, 0.6);
      backdrop-filter: blur(6px);
      z-index: 9998;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.2s, visibility 0.2s;
    }
    #alt-updates-overlay.show { opacity: 1; visibility: visible; }
    #alt-updates-panel {
      position: fixed;
      top: 0; right: 0; bottom: 0;
      width: 100%; max-width: 520px;
      background: #ffffff;
      box-shadow: -8px 0 30px rgba(0,0,0,0.15);
      z-index: 9999;
      transform: translateX(100%);
      transition: transform 0.28s cubic-bezier(.2,.8,.2,1);
      display: flex; flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    #alt-updates-panel.show { transform: translateX(0); }
    #alt-updates-panel .head {
      padding: 22px 24px 16px;
      border-bottom: 1px solid #e5e7eb;
      display: flex; align-items: center; justify-content: space-between;
      background: linear-gradient(135deg, #0f1f5c 0%, #1a3dce 100%);
      color: #fff;
    }
    #alt-updates-panel .head h2 {
      margin: 0; font-size: 18px; font-weight: 800;
    }
    #alt-updates-panel .head .close {
      background: rgba(255,255,255,0.15);
      border: 1px solid rgba(255,255,255,0.25);
      color: #fff;
      width: 32px; height: 32px;
      border-radius: 8px;
      cursor: pointer; font-size: 16px;
      display: flex; align-items: center; justify-content: center;
    }
    #alt-updates-panel .head .close:hover { background: rgba(255,255,255,0.25); }
    #alt-updates-panel .body {
      flex: 1;
      overflow-y: auto;
      padding: 8px 24px 24px;
    }
    #alt-updates-panel .empty {
      text-align: center; padding: 60px 20px;
      color: #6b7280; font-size: 14px;
    }
    #alt-updates-panel .item {
      border-bottom: 1px solid #f3f4f6;
      padding: 18px 0;
    }
    #alt-updates-panel .item:last-child { border-bottom: none; }
    #alt-updates-panel .item-head {
      display: flex; align-items: center; gap: 10px;
      margin-bottom: 8px;
    }
    #alt-updates-panel .item-emoji { font-size: 24px; flex-shrink: 0; }
    #alt-updates-panel .item-title-wrap { flex: 1; }
    #alt-updates-panel .item-title {
      font-size: 15px; font-weight: 700; color: #111827;
      line-height: 1.35;
    }
    #alt-updates-panel .item-meta {
      font-size: 11px; color: #9ca3af;
      margin-top: 2px;
      display: flex; align-items: center; gap: 8px;
    }
    #alt-updates-panel .item-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 99px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    #alt-updates-panel .badge-new { background: #dbeafe; color: #1e40af; }
    #alt-updates-panel .badge-fix { background: #fef3c7; color: #92400e; }
    #alt-updates-panel .badge-improvement { background: #d1fae5; color: #065f46; }
    #alt-updates-panel .item-short {
      font-size: 13px; color: #4b5563;
      line-height: 1.55;
      margin-top: 6px;
    }
    #alt-updates-panel .item-long {
      font-size: 13px; color: #4b5563;
      line-height: 1.6;
      margin-top: 10px;
      padding: 12px 14px;
      background: #f9fafb;
      border-radius: 8px;
      display: none;
    }
    #alt-updates-panel .item.open .item-long { display: block; }
    #alt-updates-panel .item-toggle {
      margin-top: 6px;
      background: none; border: none; padding: 0;
      color: #2563eb; font-size: 12px; font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    #alt-updates-panel .item-toggle:hover { text-decoration: underline; }
    #alt-updates-panel .item.open .item-toggle::after { content: ' ↑'; }
    #alt-updates-panel .item:not(.open) .item-toggle::after { content: ' ↓'; }

    /* Indicateur "nouveau" sur une news non lue */
    #alt-updates-panel .item.unread .item-title::after {
      content: '';
      display: inline-block;
      width: 8px; height: 8px;
      background: #ef4444;
      border-radius: 50%;
      margin-left: 8px;
      vertical-align: middle;
    }

    /* Pop-up au login */
    #alt-popup-overlay {
      position: fixed; inset: 0;
      background: rgba(10, 14, 30, 0.7);
      backdrop-filter: blur(8px);
      z-index: 10000;
      display: none;
      align-items: center; justify-content: center;
      padding: 20px;
      opacity: 0;
      transition: opacity 0.25s;
    }
    #alt-popup-overlay.show { display: flex; opacity: 1; }
    #alt-popup-card {
      background: #fff;
      border-radius: 20px;
      max-width: 440px; width: 100%;
      box-shadow: 0 25px 70px rgba(0,0,0,0.3);
      overflow: hidden;
      transform: translateY(20px) scale(0.96);
      transition: transform 0.3s cubic-bezier(.2,.8,.2,1);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    #alt-popup-overlay.show #alt-popup-card { transform: translateY(0) scale(1); }
    #alt-popup-card .hero {
      padding: 32px 28px 24px;
      background: linear-gradient(135deg, #1a3dce 0%, #0f1f5c 100%);
      color: #fff;
      text-align: center;
    }
    #alt-popup-card .hero-emoji { font-size: 52px; margin-bottom: 10px; line-height: 1; }
    #alt-popup-card .hero-label {
      font-size: 11px; font-weight: 700;
      letter-spacing: 1.5px; text-transform: uppercase;
      opacity: 0.75;
    }
    #alt-popup-card .hero-title {
      font-size: 20px; font-weight: 800;
      margin-top: 6px; line-height: 1.3;
    }
    #alt-popup-card .body {
      padding: 22px 28px 26px;
    }
    #alt-popup-card .body .version-badge {
      display: inline-flex; align-items: center; gap: 6px;
      background: #eef2ff;
      color: #4338ca;
      font-size: 11px;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 99px;
      text-transform: uppercase; letter-spacing: 0.5px;
      margin-bottom: 12px;
    }
    #alt-popup-card .body .description {
      font-size: 14px;
      color: #374151;
      line-height: 1.6;
    }
    #alt-popup-card .footer {
      padding: 0 28px 28px;
      display: flex; gap: 10px;
    }
    #alt-popup-card .btn {
      flex: 1;
      padding: 12px 16px;
      border-radius: 10px;
      border: none;
      cursor: pointer;
      font-family: inherit;
      font-size: 13px;
      font-weight: 700;
      transition: all 0.15s;
    }
    #alt-popup-card .btn-primary {
      background: #1a3dce; color: #fff;
    }
    #alt-popup-card .btn-primary:hover { background: #0f1f5c; }
    #alt-popup-card .btn-secondary {
      background: #f3f4f6; color: #4b5563;
    }
    #alt-popup-card .btn-secondary:hover { background: #e5e7eb; }

    /* Mobile */
    @media (max-width: 640px) {
      #alt-updates-panel { max-width: 100%; }
    }
  `;
  var styleEl = document.createElement('style');
  styleEl.id = 'alt-updates-style';
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ────────────────────────────────────────────────────────────
  // Helpers Firestore (utilise l'API modulaire chargée par la page)
  // ────────────────────────────────────────────────────────────

  // Attendre que nav.js ait fini et Firebase soit prêt
  function waitForReady(cb, tries) {
    tries = tries || 0;
    var logoEl = document.querySelector('nav#alteore-nav .logo');
    var fbReady = window._db && window._uid && window._getDoc && window._doc;
    if (logoEl && fbReady) {
      cb();
    } else if (tries < 60) {
      setTimeout(function () { waitForReady(cb, tries + 1); }, 150);
    }
    // Si timeout → on ne fait rien (page non-auth ou hors dashboard)
  }

  // getDocs via import dynamique
  async function listPublishedUpdates() {
    // On utilise le SDK déjà chargé par la page si dispo, sinon on importe
    var collection, query, where, orderBy, limit, getDocs;
    try {
      var firestoreMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      collection = firestoreMod.collection;
      query = firestoreMod.query;
      where = firestoreMod.where;
      orderBy = firestoreMod.orderBy;
      limit = firestoreMod.limit;
      getDocs = firestoreMod.getDocs;
    } catch (e) {
      console.warn('[updates] Firestore module import failed', e);
      return [];
    }
    try {
      var col = collection(window._db, 'updates');
      var q = query(col, where('published', '==', true), orderBy('order', 'desc'), limit(50));
      var snap = await getDocs(q);
      var arr = [];
      snap.forEach(function (d) {
        arr.push(Object.assign({ id: d.id }, d.data()));
      });
      return arr;
    } catch (e) {
      console.warn('[updates] Query failed, retry without orderBy:', e.message);
      // Fallback sans orderBy (si index manquant)
      try {
        var col2 = collection(window._db, 'updates');
        var q2 = query(col2, where('published', '==', true), limit(50));
        var snap2 = await getDocs(q2);
        var arr2 = [];
        snap2.forEach(function (d) {
          arr2.push(Object.assign({ id: d.id }, d.data()));
        });
        // Tri manuel
        arr2.sort(function (a, b) { return (b.order || 0) - (a.order || 0); });
        return arr2;
      } catch (e2) {
        console.warn('[updates] Fallback failed:', e2.message);
        return [];
      }
    }
  }

  async function getUserLastRead() {
    // 1. localStorage d'abord (instantané, fiable, survit aux reloads)
    var localId = null;
    try { localId = localStorage.getItem('alteoreLastReadUpdateId'); } catch (e) {}

    // 2. Firestore ensuite (sync cross-devices)
    var remoteId = null;
    try {
      var snap = await window._getDoc(window._doc(window._db, 'users', window._uid));
      if (snap.exists()) remoteId = snap.data().lastReadUpdateId || null;
    } catch (e) { /* silent */ }

    // 3. Politique de merge : on prend le plus récent des deux
    //    (si l'un est plus récent dans _allUpdates, c'est lui qui gagne)
    //    Si on ne peut pas comparer (index inconnu), on prend celui qui existe.
    if (!localId && !remoteId) return null;
    if (localId && !remoteId) return localId;
    if (!localId && remoteId) return remoteId;
    if (localId === remoteId) return localId;

    // Les deux sont différents → prendre le plus récent d'après _allUpdates
    var iLocal = _allUpdates.findIndex(function (u) { return u.id === localId; });
    var iRemote = _allUpdates.findIndex(function (u) { return u.id === remoteId; });
    if (iLocal === -1 && iRemote === -1) return localId; // arbitraire
    if (iLocal === -1) return remoteId;
    if (iRemote === -1) return localId;
    // index plus petit = plus récent (tri desc)
    return iLocal <= iRemote ? localId : remoteId;
  }

  async function setUserLastRead(updateId) {
    try {
      // updateDoc via import pour être sûr
      var firestoreMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      var updateDoc = firestoreMod.updateDoc;
      await updateDoc(window._doc(window._db, 'users', window._uid), {
        lastReadUpdateId: updateId,
        lastReadUpdateAt: new Date().toISOString(),
      });
    } catch (e) { console.warn('[updates] setUserLastRead failed (non-bloquant, localStorage gère):', e.message); }
  }

  // ────────────────────────────────────────────────────────────
  // UI : icône dans la sidebar
  // ────────────────────────────────────────────────────────────

  function injectBell() {
    var logoEl = document.querySelector('nav#alteore-nav .logo');
    if (!logoEl || document.getElementById('alt-updates-bell')) return;

    var bell = document.createElement('div');
    bell.id = 'alt-updates-bell';
    bell.title = 'Nouveautés';
    bell.innerHTML = '🔔<span class="badge-count hidden">0</span>';
    bell.addEventListener('click', function () { openPanel(); });
    logoEl.appendChild(bell);
  }

  function updateBellBadge(count) {
    var bell = document.getElementById('alt-updates-bell');
    if (!bell) return;
    var badge = bell.querySelector('.badge-count');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 9 ? '9+' : String(count);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  // ────────────────────────────────────────────────────────────
  // UI : Panneau historique
  // ────────────────────────────────────────────────────────────

  var _allUpdates = [];
  var _lastReadId = null;

  function badgeHtml(type) {
    var t = (type || '').toLowerCase();
    if (t === 'new' || t === 'nouveauté' || t === 'nouveaute') return '<span class="item-badge badge-new">Nouveau</span>';
    if (t === 'fix' || t === 'correctif' || t === 'bugfix') return '<span class="item-badge badge-fix">Correctif</span>';
    if (t === 'amélioration' || t === 'amelioration' || t === 'improvement') return '<span class="item-badge badge-improvement">Amélioration</span>';
    return '';
  }

  function formatDate(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso.length <= 10 ? iso + 'T12:00:00' : iso);
      if (isNaN(d.getTime())) return iso;
      var mois = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
      return d.getDate() + ' ' + mois[d.getMonth()] + ' ' + d.getFullYear();
    } catch (e) { return iso; }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderPanel() {
    var existing = document.getElementById('alt-updates-overlay');
    if (existing) existing.remove();
    var existingPanel = document.getElementById('alt-updates-panel');
    if (existingPanel) existingPanel.remove();

    var overlay = document.createElement('div');
    overlay.id = 'alt-updates-overlay';
    overlay.addEventListener('click', closePanel);
    document.body.appendChild(overlay);

    var panel = document.createElement('div');
    panel.id = 'alt-updates-panel';
    panel.innerHTML =
      '<div class="head">' +
        '<h2>🔔 Nouveautés Alteore</h2>' +
        '<button class="close" title="Fermer">✕</button>' +
      '</div>' +
      '<div class="body" id="alt-updates-body"></div>';
    document.body.appendChild(panel);

    panel.querySelector('.close').addEventListener('click', closePanel);

    var body = panel.querySelector('#alt-updates-body');
    if (!_allUpdates || _allUpdates.length === 0) {
      body.innerHTML = '<div class="empty">🎉 Aucune nouveauté pour l\'instant.<br>Reviens bientôt, on travaille dur !</div>';
    } else {
      var itemsHtml = _allUpdates.map(function (u) {
        var isUnread = _lastReadId === null
          ? false   // premier login : ne pas tout marquer comme non lu (sinon gros badge rouge)
          : (u.order && u.id !== _lastReadId && isMoreRecent(u.id, _lastReadId));
        return (
          '<div class="item ' + (isUnread ? 'unread' : '') + '" data-id="' + escapeHtml(u.id) + '">' +
            '<div class="item-head">' +
              '<div class="item-emoji">' + escapeHtml(u.emoji || '📣') + '</div>' +
              '<div class="item-title-wrap">' +
                '<div class="item-title">' + escapeHtml(u.title || 'Sans titre') + '</div>' +
                '<div class="item-meta">' +
                  formatDate(u.date) +
                  (u.version ? ' · ' + escapeHtml(u.version) : '') +
                  (badgeHtml(u.badge) ? ' · ' + badgeHtml(u.badge) : '') +
                '</div>' +
              '</div>' +
            '</div>' +
            (u.short ? '<div class="item-short">' + escapeHtml(u.short) + '</div>' : '') +
            (u.long_html ? '<button class="item-toggle">Voir le détail</button><div class="item-long">' + u.long_html + '</div>' : '') +
          '</div>'
        );
      }).join('');
      body.innerHTML = itemsHtml;

      // Toggles expand/collapse
      body.querySelectorAll('.item-toggle').forEach(function (btn) {
        btn.addEventListener('click', function () {
          btn.closest('.item').classList.toggle('open');
        });
      });
    }

    // Animer
    setTimeout(function () {
      overlay.classList.add('show');
      panel.classList.add('show');
    }, 10);
  }

  function isMoreRecent(idA, idB) {
    // Cherche l'index : plus petit index = plus récent (liste triée desc)
    var iA = _allUpdates.findIndex(function (x) { return x.id === idA; });
    var iB = _allUpdates.findIndex(function (x) { return x.id === idB; });
    if (iA === -1 || iB === -1) return false;
    return iA < iB;
  }

  function openPanel() {
    renderPanel();
    // Marquer comme lu : le plus récent devient lastReadUpdateId
    if (_allUpdates.length > 0) {
      var newestId = _allUpdates[0].id;
      if (newestId !== _lastReadId) {
        _lastReadId = newestId;
        try { localStorage.setItem('alteoreLastReadUpdateId', newestId); } catch (e) {}
        setUserLastRead(newestId);
        updateBellBadge(0);
      }
    }
  }

  function closePanel() {
    var overlay = document.getElementById('alt-updates-overlay');
    var panel = document.getElementById('alt-updates-panel');
    if (overlay) overlay.classList.remove('show');
    if (panel) panel.classList.remove('show');
    setTimeout(function () {
      if (overlay) overlay.remove();
      if (panel) panel.remove();
    }, 300);
  }

  // ────────────────────────────────────────────────────────────
  // UI : Pop-up au login (dernière news non lue)
  // ────────────────────────────────────────────────────────────

  function showPopup(update) {
    var existing = document.getElementById('alt-popup-overlay');
    if (existing) existing.remove();

    // ── IMPORTANT : marquer comme lu IMMÉDIATEMENT à l'affichage ──
    // Même si l'user ferme l'onglet sans cliquer sur Plus tard / Voir tout,
    // la news ne reviendra pas au prochain chargement.
    // - localStorage : fix instantané et durable côté navigateur
    // - Firestore : écriture en background (peut échouer, pas grave grâce à localStorage)
    _lastReadId = update.id;
    try { localStorage.setItem('alteoreLastReadUpdateId', update.id); } catch (e) { /* quota / private mode */ }
    setUserLastRead(update.id); // fire-and-forget, localStorage compense si échec
    updateBellBadge(0);

    var overlay = document.createElement('div');
    overlay.id = 'alt-popup-overlay';
    overlay.innerHTML =
      '<div id="alt-popup-card" role="dialog" aria-modal="true">' +
        '<div class="hero">' +
          '<div class="hero-emoji">' + escapeHtml(update.emoji || '🎉') + '</div>' +
          '<div class="hero-label">Nouveauté' + (update.badge ? ' · ' + escapeHtml(update.badge) : '') + '</div>' +
          '<div class="hero-title">' + escapeHtml(update.title || '') + '</div>' +
        '</div>' +
        '<div class="body">' +
          (update.version ? '<span class="version-badge">' + escapeHtml(update.version) + '</span>' : '') +
          '<div class="description">' + escapeHtml(update.short || '') + '</div>' +
        '</div>' +
        '<div class="footer">' +
          '<button class="btn btn-secondary" id="alt-popup-dismiss">Plus tard</button>' +
          '<button class="btn btn-primary" id="alt-popup-see-all">Voir tout</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    setTimeout(function () { overlay.classList.add('show'); }, 10);

    overlay.querySelector('#alt-popup-dismiss').addEventListener('click', function () {
      closePopup();
    });
    overlay.querySelector('#alt-popup-see-all').addEventListener('click', function () {
      closePopup();
      setTimeout(openPanel, 250);
    });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closePopup();
    });
  }

  function closePopup() {
    var overlay = document.getElementById('alt-popup-overlay');
    if (!overlay) return;
    overlay.classList.remove('show');
    setTimeout(function () { overlay.remove(); }, 300);
    // NB : le marquage "lu" a déjà été fait à l'affichage (showPopup).
    // Pas besoin de réécrire ici.
  }

  // ────────────────────────────────────────────────────────────
  // INIT
  // ────────────────────────────────────────────────────────────

  async function init() {
    try {
      // 1. Injecter la cloche (même si pas d'updates)
      injectBell();

      // 2. Charger les updates
      _allUpdates = await listPublishedUpdates();
      if (_allUpdates.length === 0) return;

      // 3. Charger le lastReadUpdateId du user
      _lastReadId = await getUserLastRead();

      // 4. Compter les non lues
      var unreadCount = 0;
      if (_lastReadId === null) {
        // Premier login — on ne les marque pas toutes comme non lues (ce serait trop)
        // On considère qu'il a "déjà lu" toutes sauf la plus récente
        unreadCount = 1;
      } else {
        for (var i = 0; i < _allUpdates.length; i++) {
          if (_allUpdates[i].id === _lastReadId) break;
          unreadCount++;
        }
      }
      updateBellBadge(unreadCount);

      // 5. Si la dernière news n'est pas lue → pop-up auto (une seule pop-up, la plus récente)
      var newest = _allUpdates[0];
      if (newest && newest.id !== _lastReadId) {
        // Délai pour laisser la page charger avant de popup
        setTimeout(function () { showPopup(newest); }, 1200);
      }
    } catch (e) {
      console.warn('[updates] init failed:', e);
    }
  }

  waitForReady(init);
})();
