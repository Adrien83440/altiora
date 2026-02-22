// ── nav.js — Alteore ──
(function() {

  const PLAN_NAMES = {
    free: 'Plan Gratuit', trial: 'Essai gratuit', pro: 'Alteore Pro',
    max: 'Alteore Max', master: 'Alteore Master', past_due: 'Paiement en attente', dev: 'Dev / Admin'
  };

  const CAN_FIDELISATION = ['trial', 'max', 'master', 'dev'];
  const CAN_IMPORT       = ['pro', 'max', 'master', 'dev'];
  const CAN_CORE         = ['trial', 'pro', 'max', 'master', 'dev'];

  // Masquer le <main> immédiatement pour éviter le flash
  const mainEl = document.querySelector('main');
  if (mainEl) mainEl.style.visibility = 'hidden';

  function waitForFirebase(cb, tries) {
    tries = tries || 0;
    if (window._uid && window._getDoc && window._db && window._doc) {
      cb();
    } else if (tries < 60) {
      setTimeout(function() { waitForFirebase(cb, tries + 1); }, 100);
    } else {
      if (mainEl) mainEl.style.visibility = 'visible';
    }
  }

  function lockNavItem(el, badge, destination) {
    if (!el) return;
    el.style.opacity = '0.4';
    el.style.cursor = 'pointer';
    const firstSpan = el.querySelector('span:first-child');
    if (firstSpan) firstSpan.textContent = '🔒';
    if (!el.querySelector('.nav-lock-badge')) {
      const b = document.createElement('span');
      b.className = 'nav-lock-badge';
      b.textContent = badge;
      b.style.cssText = 'font-size:9px;font-weight:700;background:linear-gradient(135deg,#f59e0b,#fbbf24);color:#1a1f36;padding:2px 6px;border-radius:20px;margin-left:auto;flex-shrink:0;pointer-events:none';
      el.appendChild(b);
    }
    // Supprimer onclick inline et capturer le clic en phase capture
    el.setAttribute('onclick', '');
    el.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      location.href = destination;
    }, true);
    // Masquer sous-menus
    const next = el.nextElementSibling;
    if (next && (next.classList.contains('nav-fid-sub') || next.classList.contains('sub'))) {
      next.style.display = 'none';
    }
    const fidSub = document.getElementById('fid-nav-sub');
    if (fidSub) fidSub.style.display = 'none';
  }

  function getFidNavEl() {
    const byToggle = document.querySelector('[onclick*="toggleFidNav"]');
    if (byToggle) return byToggle;
    const all = document.querySelectorAll('.nav-item, .ni');
    for (let i = 0; i < all.length; i++) {
      if (all[i].textContent.includes('Fidélis')) return all[i];
    }
    return null;
  }

  function getImportNavEl() {
    const all = document.querySelectorAll('.nav-item, .ni');
    for (let i = 0; i < all.length; i++) {
      const oc = all[i].getAttribute('onclick') || '';
      if (oc.includes('import.html')) return all[i];
    }
    return null;
  }

  function applyNavPlan(plan) {
    window._userPlan = plan;
    const upl = document.getElementById('uplan');
    if (upl) upl.textContent = PLAN_NAMES[plan] || plan;

    if (!CAN_FIDELISATION.includes(plan)) {
      lockNavItem(getFidNavEl(), 'Max+', 'profil.html?tab=abonnement&upgrade=fidelisation');
    }
    if (!CAN_IMPORT.includes(plan)) {
      lockNavItem(getImportNavEl(), 'Pro+', 'profil.html?tab=abonnement&upgrade=import');
    }
    if (mainEl) mainEl.style.visibility = 'visible';
  }

  function checkPageAccess(plan) {
    const page = location.pathname.split('/').pop();
    if (page === 'fidelisation.html' && !CAN_FIDELISATION.includes(plan)) {
      location.replace('profil.html?tab=abonnement&upgrade=fidelisation');
      return false;
    }
    if (page === 'import.html' && !CAN_IMPORT.includes(plan)) {
      location.replace('profil.html?tab=abonnement&upgrade=import');
      return false;
    }
    const corePages = ['pilotage.html','marges.html','cout-revient.html','panier-moyen.html','dettes.html','suivi-ca.html','dashboard.html'];
    if (corePages.includes(page) && !CAN_CORE.includes(plan)) {
      location.replace('profil.html?tab=abonnement&upgrade=core');
      return false;
    }
    return true;
  }

  function handleProfilParams() {
    const page = location.pathname.split('/').pop();
    if (page !== 'profil.html') return;
    const params = new URLSearchParams(location.search);
    if (params.get('tab') !== 'abonnement') return;
    setTimeout(function() {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('on'));
      const abonTab = Array.from(document.querySelectorAll('.tab')).find(t => t.textContent.includes('Abonnement'));
      if (abonTab) abonTab.classList.add('on');
      const abonPanel = document.getElementById('panel-abonnement');
      if (abonPanel) abonPanel.classList.add('on');
      const msgs = {
        fidelisation: '🔒 La fidélisation est disponible dès le plan Max.',
        import: "🔒 L'import/export est disponible dès le plan Pro.",
        core: '🔒 Cette fonctionnalité nécessite un plan payant.'
      };
      const upgrade = params.get('upgrade');
      const toast = document.getElementById('toast');
      if (toast && upgrade && msgs[upgrade]) {
        toast.textContent = msgs[upgrade];
        toast.className = 'toast show err';
        setTimeout(() => { toast.className = 'toast'; }, 5000);
      }
    }, 400);
  }

  waitForFirebase(async function() {
    try {
      const snap = await window._getDoc(window._doc(window._db, 'users', window._uid));
      const plan = snap.exists() ? (snap.data().plan || 'free') : 'free';
      if (!checkPageAccess(plan)) return;
      applyNavPlan(plan);
      handleProfilParams();
    } catch(e) {
      console.warn('nav.js error:', e);
      if (mainEl) mainEl.style.visibility = 'visible';
    }
  });

})();
