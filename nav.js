// ── nav.js — Alteore ──
(function() {

  const PLAN_NAMES = {
    free: 'Plan Gratuit', trial: 'Essai gratuit', pro: 'Alteore Pro',
    max: 'Alteore Max', master: 'Alteore Master', past_due: 'Paiement en attente', dev: 'Dev / Admin'
  };

  const CAN_FIDELISATION = ['trial', 'max', 'master', 'dev'];
  const CAN_IMPORT       = ['pro', 'max', 'master', 'dev'];
  const CAN_CORE         = ['trial', 'pro', 'max', 'master', 'dev'];
  const CAN_BILAN        = ['master', 'trial', 'dev'];
  const CAN_RAPPORT      = ['pro', 'max', 'master', 'dev'];

  const mainEl = document.querySelector('main');
  // Masquer brièvement pour éviter le flash uniquement si Firebase est déjà prêt
  if (mainEl && !window._firebaseReady) mainEl.style.visibility = 'hidden';
  // Failsafe: toujours visible après 2s max
  setTimeout(function() { if (mainEl) mainEl.style.visibility = 'visible'; }, 2000);

  // ── Injecter la modale upgrade ──
  function injectUpgradeModal() {
    if (document.getElementById('nav-upgrade-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'nav-upgrade-modal';
    modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(15,31,92,.55);backdrop-filter:blur(4px);z-index:99999;align-items:center;justify-content:center';
    modal.innerHTML = `
      <div style="background:#fff;border-radius:20px;padding:36px 32px;max-width:420px;width:90%;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,.25);animation:navPop .25s ease">
        <div style="font-size:48px;margin-bottom:12px" id="nav-modal-icon">🔒</div>
        <div style="font-size:20px;font-weight:800;color:#1a1f36;margin-bottom:8px" id="nav-modal-title">Fonctionnalité verrouillée</div>
        <div style="font-size:13px;color:#6b7280;margin-bottom:24px;line-height:1.6" id="nav-modal-desc">Cette fonctionnalité n'est pas disponible dans votre plan actuel.</div>
        <div style="display:flex;gap:10px;justify-content:center">
          <button onclick="document.getElementById('nav-upgrade-modal').style.display='none'" style="padding:10px 20px;border:1.5px solid #e2e8f0;border-radius:10px;background:#fff;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;color:#6b7280">Plus tard</button>
          <button id="nav-modal-cta" style="padding:10px 24px;border:none;border-radius:10px;background:linear-gradient(135deg,#1a3dce,#4f7ef8);color:#fff;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 4px 14px rgba(26,61,206,.3)">⭐ Voir les plans</button>
        </div>
        <div style="margin-top:16px;font-size:11px;color:#9ca3af">Annulation à tout moment · 15j d'essai gratuit</div>
      </div>
    `;
    // Fermer en cliquant l'overlay
    modal.addEventListener('click', function(e) {
      if (e.target === modal) modal.style.display = 'none';
    });
    document.body.appendChild(modal);

    // Injecter l'animation
    if (!document.getElementById('nav-modal-style')) {
      const style = document.createElement('style');
      style.id = 'nav-modal-style';
      style.textContent = '@keyframes navPop{from{transform:scale(.92);opacity:0}to{transform:scale(1);opacity:1}}';
      document.head.appendChild(style);
    }
  }

  function showUpgradeModal(upgrade) {
    injectUpgradeModal();
    const configs = {
      fidelisation: {
        icon: '💎',
        title: 'Fidélisation — Plan Max requis',
        desc: 'La gestion des clients, cartes de fidélité, coupons et campagnes SMS est disponible dès le plan <strong>Max (99€/mois)</strong> ou <strong>Master (169€/mois)</strong>.',
        cta: '⭐ Passer au plan Max'
      },
      bilan: {
        icon: '🤖',
        title: 'Analyse de Bilan — Plan Master requis',
        desc: 'L\'analyse de bilan comptable par intelligence artificielle est disponible avec le plan <strong>Master (169€/mois)</strong>. Importez vos bilans et obtenez des conseils IA personnalisés.',
        cta: '⭐ Passer au plan Master'
      },
      rapport: {
        icon: '📄',
        title: 'Rapport annuel PDF — Plan Pro requis',
        desc: 'La génération de rapports annuels PDF (situation financière, compte de résultat, dettes) est disponible dès le plan <strong>Pro (69€/mois)</strong>.',
        cta: '⭐ Passer au plan Pro'
      },
      import: {
        icon: '📥',
        title: 'Import/Export — Plan Pro requis',
        desc: "L'import et l'export de données est disponible dès le plan <strong>Pro (69€/mois)</strong>.",
        cta: '⭐ Passer au plan Pro'
      },
      core: {
        icon: '📊',
        title: 'Fonctionnalité Premium',
        desc: 'Cette fonctionnalité est disponible dès le plan <strong>Pro (69€/mois)</strong>.',
        cta: '⭐ Voir les plans'
      }
    };
    const cfg = configs[upgrade] || configs.core;
    document.getElementById('nav-modal-icon').textContent = cfg.icon;
    document.getElementById('nav-modal-title').textContent = cfg.title;
    document.getElementById('nav-modal-desc').innerHTML = cfg.desc;
    document.getElementById('nav-modal-cta').textContent = cfg.cta;
    document.getElementById('nav-modal-cta').onclick = function() {
      location.href = 'profil.html?tab=abonnement&upgrade=' + upgrade;
    };
    const modal = document.getElementById('nav-upgrade-modal');
    modal.style.display = 'flex';
  }

  window._showUpgradeModal = showUpgradeModal;

  function waitForFirebase(cb, tries) {
    tries = tries || 0;
    if (window._uid && window._getDoc && window._db && window._doc) {
      cb();
    } else if (tries < 30) {
      setTimeout(function() { waitForFirebase(cb, tries + 1); }, 100);
    } else {
      // Timeout 3s — afficher quand même
      if (mainEl) mainEl.style.visibility = 'visible';
    }
  }

  function lockNavItem(el, badge, upgrade) {
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
    el.setAttribute('onclick', '');
    el.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showUpgradeModal(upgrade);
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

  function getBilanNavEl() {
    const all = document.querySelectorAll('.nav-item, .ni');
    for (let i = 0; i < all.length; i++) {
      const oc = all[i].getAttribute('onclick') || '';
      if (oc.includes('bilan.html')) return all[i];
    }
    return null;
  }

  function getRapportNavEl() {
    const all = document.querySelectorAll('.nav-item, .ni');
    for (let i = 0; i < all.length; i++) {
      const oc = all[i].getAttribute('onclick') || '';
      if (oc.includes('rapport-annuel.html')) return all[i];
    }
    return null;
  }

  function applyNavPlan(plan) {
    window._userPlan = plan;
    const upl = document.getElementById('uplan');
    if (upl) upl.textContent = PLAN_NAMES[plan] || plan;

    if (!CAN_FIDELISATION.includes(plan)) {
      lockNavItem(getFidNavEl(), 'Max+', 'fidelisation');
    }
    if (!CAN_IMPORT.includes(plan)) {
      lockNavItem(getImportNavEl(), 'Pro+', 'import');
    }
    if (!CAN_BILAN.includes(plan)) {
      lockNavItem(getBilanNavEl(), 'Master', 'bilan');
    }
    if (!CAN_RAPPORT.includes(plan)) {
      lockNavItem(getRapportNavEl(), 'Pro+', 'rapport');
    }
    if (mainEl) mainEl.style.visibility = 'visible';
  }

  function checkPageAccess(plan) {
    const page = location.pathname.split('/').pop();
    if (page === 'fidelisation.html' && !CAN_FIDELISATION.includes(plan)) {
      if (mainEl) mainEl.style.visibility = 'visible';
      showUpgradeModal('fidelisation');
      return false;
    }
    if (page === 'import.html' && !CAN_IMPORT.includes(plan)) {
      if (mainEl) mainEl.style.visibility = 'visible';
      showUpgradeModal('import');
      return false;
    }
    if (page === 'bilan.html' && !CAN_BILAN.includes(plan)) {
      if (mainEl) mainEl.style.visibility = 'visible';
      showUpgradeModal('bilan');
      return false;
    }
    if (page === 'rapport-annuel.html' && !CAN_RAPPORT.includes(plan)) {
      if (mainEl) mainEl.style.visibility = 'visible';
      showUpgradeModal('rapport');
      return false;
    }
    const corePages = ['pilotage.html','marges.html','cout-revient.html','panier-moyen.html','dettes.html','suivi-ca.html','dashboard.html'];
    if (corePages.includes(page) && !CAN_CORE.includes(plan)) {
      if (mainEl) mainEl.style.visibility = 'visible';
      showUpgradeModal('core');
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
    }, 400);
  }

  waitForFirebase(async function() {
    try {
      const snap = await window._getDoc(window._doc(window._db, 'users', window._uid));
      const plan = snap.exists() ? (snap.data().plan || 'free') : 'free';
      if (!checkPageAccess(plan)) {
        applyNavPlan(plan);
        return;
      }
      applyNavPlan(plan);
      handleProfilParams();
    } catch(e) {
      // Firebase offline ou erreur — afficher la page quand même
      if (mainEl) mainEl.style.visibility = 'visible';
      // Plan inconnu = accès total en cas d'erreur réseau (Firestore rules protègent côté serveur)
      applyNavPlan('pro');
    }
  });

})();
