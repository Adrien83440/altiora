// ── nav.js — Alteore ──
// Gestion centralisée du plan et de la sidebar
// Inclure dans tous les fichiers HTML après le module Firebase

(function() {

  const PLAN_NAMES = {
    free: 'Plan Gratuit', trial: 'Essai gratuit', pro: 'Alteore Pro',
    max: 'Alteore Max', master: 'Alteore Master', past_due: 'Paiement en attente', dev: 'Dev / Admin'
  };

  // Plans ayant accès à la fidélisation
  const CAN_FIDELISATION = ['trial', 'max', 'master', 'dev'];
  // Plans ayant accès aux fonctions core
  const CAN_CORE = ['trial', 'pro', 'max', 'master', 'dev'];
  // Plans ayant accès import/export
  const CAN_IMPORT = ['pro', 'max', 'master', 'dev'];

  // Attendre que Firebase soit prêt (window._uid dispo)
  function waitForFirebase(cb, tries) {
    tries = tries || 0;
    if (window._uid && window._getDoc && window._db) {
      cb();
    } else if (tries < 50) {
      setTimeout(function() { waitForFirebase(cb, tries + 1); }, 100);
    }
  }

  function applyNavPlan(plan) {
    // Màj badge sidebar
    const upl = document.getElementById('uplan');
    if (upl) upl.textContent = PLAN_NAMES[plan] || plan;

    // ── Fidélisation ──
    const fidNav = document.querySelector('.ni[onclick*="fidelisation"], .ni[onclick*="toggleFidNav"]');
    if (fidNav) {
      if (!CAN_FIDELISATION.includes(plan)) {
        // Griser + cadenas
        fidNav.style.opacity = '0.45';
        fidNav.style.pointerEvents = 'none';
        fidNav.style.position = 'relative';
        // Remplacer l'icône par cadenas
        const spans = fidNav.querySelectorAll('span');
        if (spans[0]) spans[0].textContent = '🔒';
        // Ajouter badge upgrade
        if (!fidNav.querySelector('.nav-lock-badge')) {
          const badge = document.createElement('span');
          badge.className = 'nav-lock-badge';
          badge.textContent = 'Max+';
          badge.style.cssText = 'font-size:9px;font-weight:700;background:linear-gradient(135deg,#f59e0b,#fbbf24);color:#1a1f36;padding:2px 6px;border-radius:20px;margin-left:auto;flex-shrink:0';
          fidNav.appendChild(badge);
        }
        // Réactiver le clic pour rediriger vers upgrade
        fidNav.style.pointerEvents = 'auto';
        fidNav.style.cursor = 'pointer';
        fidNav.onclick = function(e) {
          e.preventDefault();
          e.stopPropagation();
          location.href = 'profil.html?tab=abonnement&upgrade=fidelisation';
        };

        // Masquer aussi les sous-items fidelisation
        const fidSub = document.getElementById('fid-nav-sub');
        if (fidSub) fidSub.style.display = 'none';

      } else {
        // Accès OK — style normal
        fidNav.style.opacity = '1';
        fidNav.style.cursor = 'pointer';
        const spans = fidNav.querySelectorAll('span');
        if (spans[0] && spans[0].textContent === '🔒') spans[0].textContent = '💎';
      }
    }

    // ── Import ──
    const importNav = document.querySelector('.ni[onclick*="import.html"]');
    if (importNav) {
      if (!CAN_IMPORT.includes(plan)) {
        importNav.style.opacity = '0.45';
        importNav.style.cursor = 'pointer';
        const spans = importNav.querySelectorAll('span');
        if (spans[0]) spans[0].textContent = '🔒';
        if (!importNav.querySelector('.nav-lock-badge')) {
          const badge = document.createElement('span');
          badge.className = 'nav-lock-badge';
          badge.textContent = 'Pro+';
          badge.style.cssText = 'font-size:9px;font-weight:700;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;padding:2px 6px;border-radius:20px;margin-left:auto;flex-shrink:0';
          importNav.appendChild(badge);
        }
        importNav.onclick = function(e) {
          e.preventDefault();
          location.href = 'profil.html?tab=abonnement&upgrade=import';
        };
      }
    }
  }

  // Initialiser dès que Firebase est prêt
  waitForFirebase(async function() {
    try {
      const snap = await window._getDoc(window._doc(window._db, 'users', window._uid));
      const plan = snap.exists() ? (snap.data().plan || 'free') : 'free';
      window._userPlan = plan;
      applyNavPlan(plan);
    } catch(e) {
      console.warn('nav.js: erreur chargement plan', e);
    }
  });

  // Exposer pour usage externe
  window._navApplyPlan = applyNavPlan;

})();
