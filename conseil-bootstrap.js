/* ═══════════════════════════════════════════════════════════════════
   conseil-bootstrap.js — Alteore Conseil
   ═══════════════════════════════════════════════════════════════════
   Active le mode "viewAs" sur les pages financières quand un conseiller
   consulte le compte d'un client.

   Comment ça marche :
   1. Le conseiller, depuis son dashboard (conseil/dashboard.html), clique
      "Consulter" sur un client. Cela écrit dans sessionStorage :
        - conseil_viewAs        : UID du client à consulter
        - conseil_viewAsName    : nom du client (pour le banner)
        - conseil_viewAsEmail   : email du client (pour le bouton message)
   2. Il est redirigé vers une page financière (ex: dashboard.html).
   3. Ce script s'exécute en premier (chargé en haut du <head>) et :
        - lit le sessionStorage
        - inject un banner orange en haut de page
        - applique la classe body.conseil-view (CSS lockdown)
        - patch les fonctions Firestore globales (_setDoc, _deleteDoc...)
          pour bloquer toute écriture en mode conseil
   4. Quand onAuthStateChanged appelle ConseilBootstrap.applyAuth(user),
      ce script écrase window._uid avec l'UID du client → toutes les
      requêtes Firestore lisent les données du client.

   Aucun effet en mode normal : si sessionStorage vide, le script ne
   fait STRICTEMENT RIEN et n'a aucun impact sur l'expérience normale.
   ═══════════════════════════════════════════════════════════════════ */

(function() {
  'use strict';

  // ── Détection du mode conseil ────────────────────────────────────
  var viewAsUid;
  var viewAsName;
  var viewAsEmail;
  try {
    viewAsUid   = sessionStorage.getItem('conseil_viewAs');
    viewAsName  = sessionStorage.getItem('conseil_viewAsName')  || 'Client';
    viewAsEmail = sessionStorage.getItem('conseil_viewAsEmail') || '';
  } catch (e) {
    // sessionStorage indisponible (mode privé strict, etc.) → pas de mode conseil
    return;
  }

  if (!viewAsUid) {
    // Pas en mode conseil → ne rien faire du tout
    window.ConseilBootstrap = {
      applyAuth: function() { return false; },
      isActive: false
    };
    return;
  }

  // ── Whitelist des pages accessibles au conseiller ────────────────
  // Si le conseiller atterrit sur une page hors périmètre, on le
  // redirige vers le dashboard du client.
  var ALLOWED_PAGES = [
    'dashboard.html', 'pilotage.html', 'marges.html', 'panier-moyen.html',
    'dettes.html', 'cashflow.html', 'bilan.html', 'profil.html',
    'cout-revient.html', 'suivi-ca.html', 'previsions.html', 'scenarios.html',
    'rapport-annuel.html'
  ];
  var currentPage = (location.pathname.split('/').pop() || 'dashboard.html').toLowerCase();
  if (ALLOWED_PAGES.indexOf(currentPage) === -1) {
    // Page hors périmètre → redirection vers dashboard
    location.replace('/dashboard.html');
    return;
  }

  // ── Drapeau immédiat (avant même le DOM) ─────────────────────────
  window._isConseillerView = true;
  window._conseilViewAsUid = viewAsUid;

  // Force la classe sur <html> dès que possible pour éviter le flash
  // (le <body> n'existe peut-être pas encore au moment du chargement)
  if (document.documentElement) {
    document.documentElement.classList.add('conseil-view');
  }

  // ══════════════════════════════════════════════════════════════════
  // INTERCEPTION DES ÉCRITURES FIRESTORE
  // ══════════════════════════════════════════════════════════════════
  // window._setDoc, _deleteDoc, _addDoc, _updateDoc sont exposés par
  // les pages dans leur module Firebase. Ils sont assignés APRÈS
  // l'exécution de ce script (le module Firebase est chargé après).
  //
  // Stratégie : on installe un getter/setter sur window pour ces
  // propriétés, qui wrap automatiquement la fonction quand elle est
  // assignée. Ainsi, peu importe quand elles sont exposées, elles
  // sont toujours interceptées.
  // ══════════════════════════════════════════════════════════════════

  function makeReadOnlyWrapper(name, originalFn) {
    return function() {
      console.warn('[Conseil] Écriture bloquée (' + name + ') — mode lecture seule');
      // Retourner une promise résolue pour que les .catch() existants
      // ne lèvent pas d'erreurs intempestives
      return Promise.resolve();
    };
  }

  // Interceptions des propriétés Firestore exposées sur window.
  // On utilise defineProperty pour intercepter même les assignations
  // qui n'ont pas encore eu lieu.
  ['_setDoc', '_deleteDoc', '_addDoc', '_updateDoc'].forEach(function(propName) {
    var realFn = window[propName]; // peut être undefined à ce stade
    Object.defineProperty(window, propName, {
      configurable: true,
      get: function() {
        // Toujours retourner le wrapper read-only
        return makeReadOnlyWrapper(propName, realFn);
      },
      set: function(v) {
        // Quand le module Firebase assigne la vraie fonction, on la
        // mémorise mais on continue d'exposer le wrapper.
        realFn = v;
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // INTERCEPTION DES ERREURS PERMISSION_DENIED
  // ══════════════════════════════════════════════════════════════════
  // Certaines pages (dashboard, pilotage, cashflow) lisent des
  // collections non autorisées au conseiller (rh/, stock/, fidelite/).
  // Ces lectures échouent en silence côté Firestore, mais affichent
  // des erreurs disgracieuses dans la console. On les filtre.
  var origConsoleError = console.error;
  console.error = function() {
    var args = Array.prototype.slice.call(arguments);
    var msg = args.map(function(a) {
      try { return typeof a === 'string' ? a : (a && a.message) || JSON.stringify(a); }
      catch(_) { return ''; }
    }).join(' ');
    if (/permission|insufficient|PERMISSION_DENIED/i.test(msg)) {
      // Silencieux en mode conseil
      return;
    }
    origConsoleError.apply(console, args);
  };

  // ══════════════════════════════════════════════════════════════════
  // API PUBLIQUE
  // ══════════════════════════════════════════════════════════════════
  window.ConseilBootstrap = {
    isActive: true,
    viewAsUid: viewAsUid,
    viewAsName: viewAsName,
    viewAsEmail: viewAsEmail,

    // Appelée par chaque page financière dans son onAuthStateChanged.
    // Écrase window._uid avec l'UID du client après que la page l'ait
    // initialisée avec user.uid (l'UID du conseiller).
    applyAuth: function(user) {
      if (!user) return false;
      window._authUid    = user.uid;
      window._authEmail  = user.email || '';
      window._uid        = viewAsUid;
      // _firebaseReady est déjà setté par la page, on ne touche pas
      return true;
    },

    // Sortie du mode viewAs → retour au dashboard conseiller
    exitView: function() {
      try {
        sessionStorage.removeItem('conseil_viewAs');
        sessionStorage.removeItem('conseil_viewAsName');
        sessionStorage.removeItem('conseil_viewAsEmail');
      } catch(e) {}
      // L'espace conseiller est sur le path /conseil/ du domaine principal
      location.href = '/conseil/dashboard.html';
    },

    // Envoi d'un message au client (modale + appel API)
    openMessageModal: function() {
      var existing = document.getElementById('conseil-msg-modal');
      if (existing) { existing.style.display = 'flex'; return; }

      var overlay = document.createElement('div');
      overlay.id = 'conseil-msg-modal';
      overlay.className = 'conseil-modal-overlay';
      overlay.innerHTML = ''
        + '<div class="conseil-modal">'
        + '  <div class="conseil-modal-header">'
        + '    <span>✉️ Envoyer un message à ' + escapeHtml(viewAsName) + '</span>'
        + '    <button type="button" class="conseil-modal-close" aria-label="Fermer">×</button>'
        + '  </div>'
        + '  <div class="conseil-modal-body">'
        + '    <label class="conseil-modal-label">Sujet</label>'
        + '    <input type="text" class="conseil-modal-input" id="conseil-msg-subject" placeholder="Objet du message" maxlength="120">'
        + '    <label class="conseil-modal-label" style="margin-top:14px;">Message</label>'
        + '    <textarea class="conseil-modal-textarea" id="conseil-msg-body" rows="8" placeholder="Bonjour..." maxlength="4000"></textarea>'
        + '    <p class="conseil-modal-hint">Le client recevra ce message par email. Il pourra répondre directement à votre adresse.</p>'
        + '    <div id="conseil-msg-feedback" class="conseil-modal-feedback" style="display:none;"></div>'
        + '  </div>'
        + '  <div class="conseil-modal-footer">'
        + '    <button type="button" class="conseil-btn-ghost" data-act="cancel">Annuler</button>'
        + '    <button type="button" class="conseil-btn-primary" data-act="send">Envoyer</button>'
        + '  </div>'
        + '</div>';
      document.body.appendChild(overlay);

      function close() { overlay.style.display = 'none'; }
      overlay.querySelector('.conseil-modal-close').addEventListener('click', close);
      overlay.querySelector('[data-act="cancel"]').addEventListener('click', close);
      overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });

      overlay.querySelector('[data-act="send"]').addEventListener('click', async function() {
        var subjectEl  = overlay.querySelector('#conseil-msg-subject');
        var bodyEl     = overlay.querySelector('#conseil-msg-body');
        var feedbackEl = overlay.querySelector('#conseil-msg-feedback');
        var sendBtn    = overlay.querySelector('[data-act="send"]');

        var subject = (subjectEl.value || '').trim();
        var body    = (bodyEl.value || '').trim();

        if (!subject) { showFb('Sujet manquant.', 'error'); return; }
        if (body.length < 5) { showFb('Message trop court.', 'error'); return; }

        sendBtn.disabled = true;
        sendBtn.textContent = 'Envoi...';
        showFb('', '');

        try {
          var token = '';
          try {
            if (window._auth && window._auth.currentUser) {
              token = await window._auth.currentUser.getIdToken();
            }
          } catch(_) {}

          var resp = await fetch('/api/conseil-send-message', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': token ? 'Bearer ' + token : ''
            },
            body: JSON.stringify({
              clientUid: viewAsUid,
              subject:   subject,
              body:      body
            })
          });
          var data = await resp.json().catch(function() { return {}; });
          if (!resp.ok) throw new Error(data.error || 'Erreur d\'envoi');

          showFb('✓ Message envoyé', 'ok');
          setTimeout(close, 1500);
        } catch (err) {
          showFb('Erreur : ' + (err.message || 'envoi impossible'), 'error');
          sendBtn.disabled = false;
          sendBtn.textContent = 'Envoyer';
        }

        function showFb(txt, kind) {
          if (!txt) { feedbackEl.style.display = 'none'; return; }
          feedbackEl.style.display = 'block';
          feedbackEl.textContent = txt;
          feedbackEl.className = 'conseil-modal-feedback ' + (kind === 'ok' ? 'ok' : 'error');
        }
      });
    }
  };

  // ══════════════════════════════════════════════════════════════════
  // INJECTION DU BANNER + NAV CONSEIL
  // ══════════════════════════════════════════════════════════════════

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function injectBanner() {
    if (document.getElementById('conseil-banner')) return;

    document.body.classList.add('conseil-view');

    var bar = document.createElement('div');
    bar.id = 'conseil-banner';
    bar.innerHTML = ''
      + '<div class="conseil-banner-inner">'
      + '  <div class="conseil-banner-left">'
      + '    <span class="conseil-banner-dot"></span>'
      + '    <span class="conseil-banner-label">Mode lecture seule</span>'
      + '    <span class="conseil-banner-sep">•</span>'
      + '    <span class="conseil-banner-client">Compte de <strong>' + escapeHtml(viewAsName) + '</strong></span>'
      + '  </div>'
      + '  <div class="conseil-banner-right">'
      + '    <button type="button" class="conseil-banner-btn" id="conseil-msg-btn" title="Envoyer un message au client">'
      + '      ✉️ <span class="conseil-banner-btn-label">Message</span>'
      + '    </button>'
      + '    <button type="button" class="conseil-banner-btn conseil-banner-btn-exit" id="conseil-exit-btn" title="Retour au dashboard conseil">'
      + '      ← <span class="conseil-banner-btn-label">Quitter</span>'
      + '    </button>'
      + '  </div>'
      + '</div>';
    document.body.insertBefore(bar, document.body.firstChild);

    document.getElementById('conseil-msg-btn').addEventListener('click', function() {
      window.ConseilBootstrap.openMessageModal();
    });
    document.getElementById('conseil-exit-btn').addEventListener('click', function() {
      window.ConseilBootstrap.exitView();
    });

    // Tracking de l'accès (silencieux)
    trackAccess();
  }

  function trackAccess() {
    // Décale légèrement pour ne pas ralentir l'affichage initial
    setTimeout(async function() {
      try {
        var token = '';
        if (window._auth && window._auth.currentUser) {
          token = await window._auth.currentUser.getIdToken();
        }
        if (!token) return;
        await fetch('/api/conseil-track-access', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
          },
          body: JSON.stringify({
            clientUid: viewAsUid,
            page: currentPage
          })
        });
      } catch(_) {}
    }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectBanner);
  } else {
    injectBanner();
  }
})();
