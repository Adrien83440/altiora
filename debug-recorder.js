/* ═════════════════════════════════════════════════════════════════════════
   debug-recorder.js — Outil de diagnostic intégré ALTEORE (v1)

   FONCTION :
   • Capture en rolling buffer (30s) : clics, console.log/warn/error,
     erreurs JS, promise rejections, fetch failures, navigation
   • FAB "🐛 Signaler un bug" en bas à gauche (ne conflicte pas avec
     le FAB tickets de admin-panel.js qui est en bas à droite)
   • Modal léger : la cliente décrit le bug en 1 phrase et envoie
   • Rapport stocké dans Firestore (debug_reports/) + email à
     contact@adrienemily.com via /api/send-debug-email

   DÉPENDANCES :
   • Firebase Auth/Firestore exposés sur window (window._db, window._auth,
     window._doc, window._setDoc, window._uid). Si pas dispo → bouton
     reste actif mais l'envoi est gracefully bypassé.
   • Pour bénéficier de la capture, charger le script EN PREMIER dans
     le <head> avant tout autre code applicatif.

   PRIVACY :
   • Aucun mot de passe, token, credit card capturé (stripping basique)
   • Buffer 30s seulement, ne sort de la mémoire qu'au clic explicite
     de la cliente sur "Envoyer"
   • Pas de cookies, pas de tracking permanent

   USAGE :
   <script src="debug-recorder.js" defer></script>
   ═════════════════════════════════════════════════════════════════════════ */

(function() {
  'use strict';

  // Ne pas charger 2 fois
  if (window.__alteoreDebugRecorder) return;
  window.__alteoreDebugRecorder = true;

  // Configuration
  const BUFFER_MS = 30000;        // Garder les 30 dernières secondes
  const MAX_EVENTS = 500;          // Hard cap pour éviter une fuite mémoire
  const MAX_STR = 500;             // Tronquer chaque event à 500 chars
  const MAX_STACK = 1500;          // Tronquer les stacks à 1500 chars

  // Buffer rolling
  const buffer = [];

  function trimBuffer() {
    const cutoff = Date.now() - BUFFER_MS;
    while (buffer.length > 0 && buffer[0].t < cutoff) buffer.shift();
    while (buffer.length > MAX_EVENTS) buffer.shift();
  }

  function safeStringify(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') return v.length > MAX_STR ? v.substring(0, MAX_STR) + '…' : v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (v instanceof Error) return (v.message || String(v)) + (v.stack ? '\n' + v.stack.substring(0, MAX_STACK) : '');
    if (v instanceof Element) return '<' + v.tagName.toLowerCase() + (v.id ? '#' + v.id : '') + (v.className && typeof v.className === 'string' ? '.' + v.className.split(' ').slice(0, 2).join('.') : '') + '>';
    try {
      const s = JSON.stringify(v, function(_k, val) {
        // Strip champs sensibles
        if (typeof _k === 'string' && /password|token|secret|apikey|api_key|cardnumber|cvv|cvc/i.test(_k)) return '[REDACTED]';
        return val;
      });
      return s.length > MAX_STR ? s.substring(0, MAX_STR) + '…' : s;
    } catch(e) {
      return '[unserializable: ' + (e.message || 'unknown') + ']';
    }
  }

  function recordEvent(type, payload) {
    try {
      buffer.push({
        t: Date.now(),
        type: type,
        ...payload
      });
      trimBuffer();
    } catch(e) {
      // Ne jamais throw depuis le recorder
    }
  }

  // ── Capture console ─────────────────────────────────────────────
  ['log', 'warn', 'error', 'info'].forEach(function(level) {
    const orig = console[level] ? console[level].bind(console) : function(){};
    console[level] = function() {
      try {
        const args = Array.prototype.slice.call(arguments).map(safeStringify);
        recordEvent('console.' + level, { args: args });
      } catch(e) {}
      orig.apply(null, arguments);
    };
  });

  // ── Capture erreurs JS ──────────────────────────────────────────
  window.addEventListener('error', function(e) {
    recordEvent('error', {
      message: String(e.message || 'unknown error').substring(0, MAX_STR),
      filename: String(e.filename || '').substring(0, 200),
      line: e.lineno || 0,
      col: e.colno || 0,
      stack: (e.error && e.error.stack) ? String(e.error.stack).substring(0, MAX_STACK) : ''
    });
  });

  window.addEventListener('unhandledrejection', function(e) {
    const reason = e.reason;
    recordEvent('unhandledrejection', {
      message: (reason && (reason.message || String(reason))) || 'Promise rejected',
      stack: (reason && reason.stack) ? String(reason.stack).substring(0, MAX_STACK) : ''
    });
  });

  // ── Capture clicks ──────────────────────────────────────────────
  document.addEventListener('click', function(e) {
    try {
      const t = e.target;
      if (!t || !t.tagName) return;
      // Ne pas capturer les clics SUR le FAB lui-même ni sa modale
      if (t.closest && t.closest('#alteore-debug-fab, #alteore-debug-modal')) return;
      const tag = t.tagName.toLowerCase();
      const id = t.id || '';
      const cls = (t.className && typeof t.className === 'string') ? t.className.substring(0, 100) : '';
      const txt = (t.textContent || '').substring(0, 60).replace(/\s+/g, ' ').trim();
      const onclick = t.getAttribute && t.getAttribute('onclick') ? t.getAttribute('onclick').substring(0, 200) : '';
      recordEvent('click', { tag: tag, id: id, cls: cls, txt: txt, onclick: onclick });
    } catch(_e) {}
  }, true);

  // ── Capture fetch failures ──────────────────────────────────────
  if (window.fetch) {
    const origFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      const t0 = Date.now();
      return origFetch(input, init).then(function(resp) {
        if (!resp.ok) {
          recordEvent('fetch.failed', {
            url: url.substring(0, 200),
            method: method,
            status: resp.status,
            statusText: resp.statusText,
            duration: Date.now() - t0
          });
        }
        return resp;
      }).catch(function(err) {
        recordEvent('fetch.error', {
          url: url.substring(0, 200),
          method: method,
          message: err.message || String(err),
          duration: Date.now() - t0
        });
        throw err;
      });
    };
  }

  // ── Récupérer le state Firebase au moment du report ─────────────
  function snapshotFirebaseState() {
    return {
      uid: window._uid || null,
      authReady: !!window._firebaseReady,
      hasDb: !!window._db,
      hasAuth: !!window._auth,
      currentUserEmail: (window._auth && window._auth.currentUser) ? window._auth.currentUser.email : null
    };
  }

  // ── Récupérer les variables globales utiles à la page courante ──
  function snapshotPageState() {
    const state = {};
    // Variables globales fréquentes du module RH planning
    ['_view', '_disp', '_zoom', '_anchor', '_multiOpen', '_editId', '_crType',
     '_filterPoste', '_emps', '_cr', '_hidden', '_plages', '_publishedWeeks'].forEach(function(name) {
      try {
        if (typeof window[name] !== 'undefined') {
          const v = window[name];
          if (v instanceof Set) state[name] = '<Set size=' + v.size + '>';
          else if (v instanceof Map) state[name] = '<Map size=' + v.size + '>';
          else if (Array.isArray(v)) state[name] = '<Array len=' + v.length + '>';
          else if (v && typeof v === 'object') state[name] = '<Object keys=' + Object.keys(v).length + '>';
          else state[name] = safeStringify(v);
        }
      } catch(_e) {}
    });
    return state;
  }

  // ── Récupérer un snapshot DOM du visible ────────────────────────
  function snapshotDOM() {
    const visible = [];
    try {
      // Modales actuellement ouvertes
      document.querySelectorAll('.overlay.show, .modal-overlay.show, .modal.show').forEach(function(el) {
        visible.push({
          type: 'modal-open',
          id: el.id || '',
          h3: ((el.querySelector('h1, h2, h3, h4') || {}).textContent || '').substring(0, 80)
        });
      });
      // Inputs en erreur visible
      document.querySelectorAll('.error, .invalid, [aria-invalid="true"]').forEach(function(el) {
        visible.push({
          type: 'invalid-input',
          id: el.id || '',
          name: el.getAttribute && el.getAttribute('name') || ''
        });
      });
    } catch(_e) {}
    return visible;
  }

  // ── INJECTION UI : FAB + Modal ──────────────────────────────────
  function injectStyles() {
    if (document.getElementById('alteore-debug-styles')) return;
    const style = document.createElement('style');
    style.id = 'alteore-debug-styles';
    style.textContent = `
      #alteore-debug-fab {
        position: fixed;
        bottom: 18px;
        left: 18px;
        width: 48px;
        height: 48px;
        border-radius: 50%;
        background: linear-gradient(135deg, #f59e0b, #ef4444);
        color: white;
        border: none;
        cursor: pointer;
        box-shadow: 0 6px 20px rgba(239, 68, 68, 0.35);
        font-size: 22px;
        z-index: 99998;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.15s, box-shadow 0.15s;
      }
      #alteore-debug-fab:hover {
        transform: scale(1.08);
        box-shadow: 0 8px 26px rgba(239, 68, 68, 0.5);
      }
      #alteore-debug-fab:active { transform: scale(0.95); }
      #alteore-debug-modal {
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.55);
        backdrop-filter: blur(4px);
        z-index: 99999;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }
      #alteore-debug-modal.show { display: flex; }
      #alteore-debug-modal .adb-card {
        background: white;
        border-radius: 16px;
        max-width: 480px;
        width: 100%;
        padding: 26px 28px;
        box-shadow: 0 24px 60px rgba(0,0,0,0.25);
        font-family: -apple-system, BlinkMacSystemFont, 'Plus Jakarta Sans', 'Segoe UI', Roboto, sans-serif;
        max-height: 90vh;
        overflow-y: auto;
      }
      #alteore-debug-modal h3 {
        margin: 0 0 4px 0;
        font-size: 19px;
        font-weight: 800;
        color: #0f172a;
      }
      #alteore-debug-modal .adb-sub {
        font-size: 13px;
        color: #64748b;
        margin-bottom: 18px;
        line-height: 1.5;
      }
      #alteore-debug-modal label {
        display: block;
        font-size: 12px;
        font-weight: 700;
        color: #0f172a;
        margin-bottom: 6px;
      }
      #alteore-debug-modal textarea {
        width: 100%;
        min-height: 90px;
        padding: 10px 12px;
        border: 1.5px solid #e2e8f0;
        border-radius: 10px;
        font: inherit;
        font-size: 13px;
        resize: vertical;
        box-sizing: border-box;
        outline: none;
        transition: border-color 0.15s;
      }
      #alteore-debug-modal textarea:focus { border-color: #f59e0b; }
      #alteore-debug-modal .adb-info {
        margin-top: 12px;
        padding: 10px 12px;
        background: #f1f5f9;
        border-radius: 8px;
        font-size: 11.5px;
        color: #475569;
        line-height: 1.55;
      }
      #alteore-debug-modal .adb-info strong { color: #0f172a; }
      #alteore-debug-modal .adb-actions {
        display: flex;
        gap: 10px;
        margin-top: 18px;
      }
      #alteore-debug-modal button.adb-btn {
        flex: 1;
        padding: 11px 14px;
        border-radius: 10px;
        font: inherit;
        font-weight: 700;
        font-size: 13px;
        cursor: pointer;
        border: none;
        transition: opacity 0.15s, transform 0.15s;
      }
      #alteore-debug-modal button.adb-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      #alteore-debug-modal button.adb-cancel {
        background: #f1f5f9;
        color: #475569;
      }
      #alteore-debug-modal button.adb-send {
        background: linear-gradient(135deg, #f59e0b, #ef4444);
        color: white;
      }
      #alteore-debug-modal button.adb-send:hover:not(:disabled) { transform: translateY(-1px); }
      #alteore-debug-modal .adb-result {
        margin-top: 14px;
        padding: 12px 14px;
        border-radius: 10px;
        font-size: 13px;
        font-weight: 600;
        text-align: center;
        display: none;
      }
      #alteore-debug-modal .adb-result.success {
        background: #d1fae5;
        color: #065f46;
        display: block;
      }
      #alteore-debug-modal .adb-result.error {
        background: #fee2e2;
        color: #b91c1c;
        display: block;
      }
      @media (max-width: 600px) {
        #alteore-debug-fab { bottom: 78px; }  /* Au-dessus de la nav mobile */
      }
    `;
    document.head.appendChild(style);
  }

  function injectFAB() {
    if (document.getElementById('alteore-debug-fab')) return;
    const btn = document.createElement('button');
    btn.id = 'alteore-debug-fab';
    btn.type = 'button';
    btn.title = 'Signaler un problème';
    btn.setAttribute('aria-label', 'Signaler un problème');
    btn.innerHTML = '🐛';
    btn.addEventListener('click', openModal);
    document.body.appendChild(btn);
  }

  function injectModal() {
    if (document.getElementById('alteore-debug-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'alteore-debug-modal';
    modal.innerHTML = `
      <div class="adb-card">
        <h3>🐛 Signaler un problème</h3>
        <div class="adb-sub">Décrivez ce que vous étiez en train de faire, et ce qui ne marche pas. L'équipe Alteore reçoit le rapport immédiatement.</div>
        <label for="adb-summary">Que s'est-il passé ?</label>
        <textarea id="adb-summary" placeholder="Ex : Quand je clique sur Enregistrer après avoir sélectionné 4 jours, rien ne se passe…"></textarea>
        <div class="adb-info">
          <strong>📦 Inclus dans le rapport :</strong>
          page courante, clics récents, erreurs JavaScript, état de l'application (sans aucune donnée sensible).
        </div>
        <div class="adb-actions">
          <button type="button" class="adb-btn adb-cancel">Annuler</button>
          <button type="button" class="adb-btn adb-send">📤 Envoyer le rapport</button>
        </div>
        <div class="adb-result" id="adb-result"></div>
      </div>
    `;
    modal.addEventListener('click', function(e) {
      if (e.target === modal) closeModal();
    });
    modal.querySelector('.adb-cancel').addEventListener('click', closeModal);
    modal.querySelector('.adb-send').addEventListener('click', sendReport);
    document.body.appendChild(modal);
  }

  function openModal() {
    const modal = document.getElementById('alteore-debug-modal');
    if (!modal) return;
    // Reset
    const ta = document.getElementById('adb-summary');
    if (ta) ta.value = '';
    const result = document.getElementById('adb-result');
    if (result) { result.className = 'adb-result'; result.textContent = ''; }
    const sendBtn = modal.querySelector('.adb-send');
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '📤 Envoyer le rapport'; }
    modal.classList.add('show');
    setTimeout(function() { ta && ta.focus(); }, 50);
  }

  function closeModal() {
    const modal = document.getElementById('alteore-debug-modal');
    if (modal) modal.classList.remove('show');
  }

  // ── ENVOI DU RAPPORT ────────────────────────────────────────────
  async function sendReport() {
    const modal = document.getElementById('alteore-debug-modal');
    const sendBtn = modal && modal.querySelector('.adb-send');
    const ta = document.getElementById('adb-summary');
    const result = document.getElementById('adb-result');
    const summary = (ta && ta.value || '').trim();

    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '⏳ Envoi en cours…'; }

    try {
      // Vérifier qu'on a Firebase
      if (!window._db || !window._setDoc || !window._doc) {
        throw new Error('Application non initialisée — rechargez la page et réessayez.');
      }
      if (!window._uid) {
        throw new Error('Vous devez être connecté pour envoyer un rapport.');
      }

      // Construire le rapport
      const reportId = 'bug_' + new Date().toISOString().replace(/[^0-9]/g, '').substring(0, 14) + '_' + Math.random().toString(36).substring(2, 8);
      trimBuffer();
      const events = buffer.slice();
      const errorCount = events.filter(function(e){ return e.type === 'error' || e.type === 'unhandledrejection' || e.type === 'console.error'; }).length;
      const warningCount = events.filter(function(e){ return e.type === 'console.warn' || e.type === 'fetch.failed'; }).length;

      const meta = {
        userAgent: navigator.userAgent.substring(0, 300),
        platform: navigator.platform || '',
        language: navigator.language || '',
        url: location.href.substring(0, 300),
        referrer: (document.referrer || '').substring(0, 200),
        viewport: { w: window.innerWidth, h: window.innerHeight },
        timestamp: new Date().toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || ''
      };

      const userInfo = {};
      try {
        if (window._auth && window._auth.currentUser) {
          userInfo.email = window._auth.currentUser.email || '';
          userInfo.displayName = window._auth.currentUser.displayName || '';
        }
      } catch(_e) {}

      const payload = {
        uid: window._uid,
        createdAt: new Date().toISOString(),
        source: 'debug-recorder',
        version: 1,
        userSummary: summary || '(aucune description fournie)',
        meta: meta,
        userInfo: userInfo,
        firebaseState: snapshotFirebaseState(),
        pageState: snapshotPageState(),
        domSnapshot: snapshotDOM(),
        events: events,
        errorCount: errorCount,
        warningCount: warningCount,
        eventCount: events.length
      };

      // Écrire dans Firestore
      const ref = window._doc(window._db, 'debug_reports', reportId);
      await window._setDoc(ref, payload);

      // Notifier par email (best effort)
      try {
        await fetch('/api/send-debug-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reportId: reportId,
            uid: window._uid,
            email: userInfo.email,
            name: userInfo.displayName,
            summary: summary || meta.url,
            errorCount: errorCount,
            warningCount: warningCount
          })
        });
      } catch(emailErr) {
        // Pas bloquant — le rapport est déjà dans Firestore
      }

      if (result) {
        result.className = 'adb-result success';
        result.innerHTML = '✅ Rapport envoyé ! L\'équipe Alteore va l\'examiner.<br><span style="font-size:11px;opacity:0.7">Réf : ' + reportId + '</span>';
      }
      setTimeout(closeModal, 2800);

    } catch(err) {
      console.error('[debug-recorder] sendReport failed:', err);
      if (result) {
        result.className = 'adb-result error';
        result.textContent = '❌ ' + (err.message || 'Erreur lors de l\'envoi');
      }
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '📤 Réessayer'; }
    }
  }

  // ── INIT ────────────────────────────────────────────────────────
  function init() {
    try {
      injectStyles();
      injectFAB();
      injectModal();
      recordEvent('recorder.ready', { url: location.href.substring(0, 200) });
    } catch(e) {
      console.warn('[debug-recorder] init failed:', e.message);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // API publique optionnelle
  window.alteoreDebug = {
    open: openModal,
    record: function(label, data) {
      recordEvent('manual', { label: String(label).substring(0, 80), data: safeStringify(data) });
    },
    bufferSize: function() { return buffer.length; }
  };

})();
