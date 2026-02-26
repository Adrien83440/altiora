// ── nav.js — Alteore ── v2 (nav centralisée)
(function() {

  // ════════════════════════════════════════════════
  // CONFIG PLANS
  // ════════════════════════════════════════════════
  const PLAN_NAMES = {
    free: 'Plan Gratuit', trial: 'Essai gratuit', pro: 'Alteore Pro',
    max: 'Alteore Max', master: 'Alteore Master', past_due: 'Paiement en attente', dev: 'Dev / Admin'
  };
  const CAN_FIDELISATION = ['trial', 'max', 'master', 'dev'];
  const CAN_IMPORT       = ['pro', 'max', 'master', 'dev'];
  const CAN_CORE         = ['trial', 'pro', 'max', 'master', 'dev'];
  const CAN_BILAN        = ['master', 'trial', 'dev'];
  const CAN_RAPPORT      = ['pro', 'max', 'master', 'dev'];

  // ════════════════════════════════════════════════
  // PAGE ACTIVE — détection automatique
  // ════════════════════════════════════════════════
  const PAGE = location.pathname.split('/').pop() || 'dashboard.html';

  // ════════════════════════════════════════════════
  // INJECTION NAV HTML
  // ════════════════════════════════════════════════
  function buildNavHTML() {
    // Détermine si un item ou sous-item est actif
    function active(page) {
      return PAGE === page ? ' on' : '';
    }
    function activeNI(pages) {
      return pages.includes(PAGE) ? ' on' : '';
    }
    // Sous-menu KPIs ouvert si on est sur une page KPI
    const kpisPages = ['cout-revient.html','marges.html','panier-moyen.html','dettes.html'];
    const kpisOpen  = kpisPages.includes(PAGE) ? 'style="max-height:400px"' : '';
    // Sous-menu Pilotage ouvert si on est sur pilotage
    const pilOpen   = PAGE === 'pilotage.html' ? 'style="max-height:400px"' : '';
    // Sous-menu Fidélisation ouvert si on est sur fidelisation
    const fidOpen   = PAGE === 'fidelisation.html' ? 'style="max-height:400px"' : '';
    // Cashflow ouvert dans pilotage
    const cashOpen  = PAGE === 'cashflow.html' ? 'style="max-height:400px"' : '';

    return `
<nav id="alteore-nav">
  <div class="logo"><div class="logo-i">📊</div><div class="logo-t">ALTEORE</div></div>

  <div class="ns">Principal</div>

  <div class="ni${active('dashboard.html')}" id="nav-dashboard" onclick="location.href='dashboard.html'">
    <span>🏠</span><span>Tableau de bord</span>
  </div>

  <div class="ni${active('suivi-ca.html')}" id="nav-suivi" onclick="location.href='suivi-ca.html'">
    <span>📈</span><span>Suivi CA &amp; Résultats</span>
  </div>

  <div class="ni${activeNI(kpisPages)}" id="nav-kpis" onclick="toggleAlteoreNav('kpis-sub',this)">
    <span>🎯</span><span style="flex:1">KPIs Clés</span><span class="chev" id="chev-kpis">›</span>
  </div>
  <div class="sub" id="kpis-sub" ${kpisOpen}>
    <div class="si${active('cout-revient.html')}" id="nav-cout" onclick="location.href='cout-revient.html'"><span class="dot"></span>Coût de revient</div>
    <div class="si${active('marges.html')}" id="nav-marges" onclick="location.href='marges.html'"><span class="dot"></span>Marge brute &amp; nette</div>
    <div class="si${active('panier-moyen.html')}" id="nav-panier" onclick="location.href='panier-moyen.html'"><span class="dot"></span>Panier moyen</div>
    <div class="si${active('dettes.html')}" id="nav-dettes" onclick="location.href='dettes.html'"><span class="dot"></span>Dettes &amp; Emprunts</div>
  </div>

  <div class="ni${active('pilotage.html')}" id="nav-pilotage" onclick="toggleAlteoreNav('pil-sub',this)">
    <span>🧭</span><span style="flex:1">Pilotage</span><span class="chev" id="chev-pil">›</span>
  </div>
  <div class="sub" id="pil-sub" ${pilOpen}>
    <div class="si${active('pilotage.html')}" onclick="location.href='pilotage.html?year=2025'"><span class="dot"></span>Pilotage 2025</div>
    <div class="si" onclick="location.href='pilotage.html?year=2026'"><span class="dot"></span>Pilotage 2026</div>
    <div class="si" onclick="location.href='pilotage.html?year=2027'"><span class="dot"></span>Pilotage 2027</div>
    <div class="si${active('cashflow.html')}" onclick="location.href='cashflow.html'" style="border-top:1px solid rgba(255,255,255,.06);margin-top:4px;padding-top:8px">
      <span class="dot" style="background:#0d9488"></span>💧 Cashflow
    </div>
  </div>

  <div class="ns">Rapports</div>
  <div class="ni${active('rapport-annuel.html')}" id="nav-rapport" onclick="location.href='rapport-annuel.html'">
    <span>📄</span><span style="flex:1">Rapport annuel PDF</span>
    <span style="font-size:9px;font-weight:700;background:rgba(16,185,129,.25);color:#6ee7b7;padding:2px 7px;border-radius:20px">Nouveau</span>
  </div>

  <div class="ns">Intelligence IA</div>
  <div class="ni${active('bilan.html')}" id="nav-bilan" onclick="location.href='bilan.html'">
    <span>🤖</span><span style="flex:1">Analyse de Bilan</span>
    <span style="font-size:10px;font-weight:700;background:rgba(79,126,248,0.3);color:#a5b4fc;padding:2px 7px;border-radius:20px">IA</span>
  </div>

  <div class="ns">Fidélisation</div>
  <div class="ni${active('fidelisation.html')}" id="nav-fid" onclick="toggleAlteoreNav('fid-nav-sub',this)">
    <span>💎</span><span style="flex:1">Fidélisation</span>
    <span class="fid-chev" style="font-size:11px;color:rgba(255,255,255,.3);transition:transform .25s;margin-left:auto">›</span>
  </div>
  <div class="sub" id="fid-nav-sub" ${fidOpen}>
    <div class="si${active('fidelisation.html')}" onclick="location.href='fidelisation.html'"><span class="dot"></span>Dashboard fidélité</div>
    <div class="si" onclick="location.href='fidelisation.html';setTimeout(()=>window.switchTab&&window.switchTab('clients',null),300)"><span class="dot"></span>Clients</div>
    <div class="si" onclick="location.href='fidelisation.html';setTimeout(()=>window.switchTab&&window.switchTab('carte',null),300)"><span class="dot"></span>Carte fidélité</div>
    <div class="si" onclick="location.href='fidelisation.html';setTimeout(()=>window.switchTab&&window.switchTab('points',null),300)"><span class="dot"></span>Points &amp; Récompenses</div>
    <div class="si" onclick="location.href='fidelisation.html';setTimeout(()=>window.switchTab&&window.switchTab('coupons',null),300)"><span class="dot"></span>Coupons &amp; Offres</div>
    <div class="si" onclick="location.href='fidelisation.html';setTimeout(()=>window.switchTab&&window.switchTab('campagnes',null),300)"><span class="dot"></span>Campagnes</div>
  </div>

  <div class="ni" id="nav-import" onclick="location.href='import.html'" style="border-top:1px solid rgba(255,255,255,.08);padding-top:10px">
    <span>📥</span><span>Import de données</span>
  </div>

  <div class="nav-footer">
    <div class="ucard" onclick="location.href='profil.html'" style="cursor:pointer;transition:.15s" title="Mon compte">
      <div class="uav" id="av">A</div>
      <div>
        <div class="un" id="uname">Utilisateur</div>
        <div class="upl" id="uplan">Plan gratuit</div>
      </div>
      <button class="lbtn" onclick="event.stopPropagation();(window.doLogout||window.handleLogout||function(){window._signOut&&window._signOut(window._auth).then(()=>location.href='index.html')})()">⎋</button>
    </div>
    <div style="display:flex;justify-content:center;gap:14px;padding:10px 0 2px">
      <a href="mentions-legales.html" style="font-size:10px;color:rgba(255,255,255,.22);text-decoration:none;transition:color .2s" onmouseover="this.style.color='rgba(255,255,255,.6)'" onmouseout="this.style.color='rgba(255,255,255,.22)'">Mentions</a>
      <a href="cgv.html" style="font-size:10px;color:rgba(255,255,255,.22);text-decoration:none;transition:color .2s" onmouseover="this.style.color='rgba(255,255,255,.6)'" onmouseout="this.style.color='rgba(255,255,255,.22)'">CGV</a>
      <a href="confidentialite.html" style="font-size:10px;color:rgba(255,255,255,.22);text-decoration:none;transition:color .2s" onmouseover="this.style.color='rgba(255,255,255,.6)'" onmouseout="this.style.color='rgba(255,255,255,.22)'">Confidentialité</a>
    </div>
  </div>
</nav>`;
  }

  // CSS de la nav (injecté une seule fois)
  const NAV_CSS = `
<style id="alteore-nav-css">
nav#alteore-nav{width:250px;min-height:100vh;background:linear-gradient(180deg,#0f1f5c,#162366);position:fixed;top:0;left:0;display:flex;flex-direction:column;padding-bottom:20px;overflow-y:auto;z-index:99}
nav#alteore-nav .logo{display:flex;align-items:center;gap:10px;padding:22px 18px;border-bottom:1px solid rgba(255,255,255,.08)}
nav#alteore-nav .logo-i{width:33px;height:33px;background:rgba(255,255,255,.14);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:15px}
nav#alteore-nav .logo-t{font-size:17px;font-weight:800;color:#fff;letter-spacing:1px}
nav#alteore-nav .ns{font-size:10px;font-weight:700;color:rgba(255,255,255,.28);letter-spacing:1px;text-transform:uppercase;padding:12px 18px 4px}
nav#alteore-nav .ni{display:flex;align-items:center;gap:9px;padding:9px 18px;color:rgba(255,255,255,.55);font-size:12.5px;font-weight:500;cursor:pointer;border-left:3px solid transparent;transition:.15s}
nav#alteore-nav .ni:hover{color:#fff;background:rgba(255,255,255,.06)}
nav#alteore-nav .ni.on{color:#fff;background:rgba(255,255,255,.1);border-left-color:#4f7ef8}
nav#alteore-nav .sub{overflow:hidden;max-height:0;transition:max-height .3s}
nav#alteore-nav .si{display:flex;align-items:center;gap:7px;padding:7px 18px 7px 40px;color:rgba(255,255,255,.4);font-size:12px;cursor:pointer;border-left:3px solid transparent;transition:.15s}
nav#alteore-nav .si:hover{color:rgba(255,255,255,.75);background:rgba(255,255,255,.04)}
nav#alteore-nav .si.on{color:#fff;background:rgba(79,126,248,.15);border-left-color:rgba(79,126,248,.6)}
nav#alteore-nav .dot{width:5px;height:5px;border-radius:50%;background:rgba(255,255,255,.25);display:inline-block;flex-shrink:0}
nav#alteore-nav .si.on .dot{background:#4f7ef8}
nav#alteore-nav .chev{font-size:11px;color:rgba(255,255,255,.3);transition:transform .25s;margin-left:auto}
nav#alteore-nav .nav-footer{margin-top:auto;padding:12px 18px 0;border-top:1px solid rgba(255,255,255,.08)}
nav#alteore-nav .ucard{display:flex;align-items:center;gap:8px;padding:8px;background:rgba(255,255,255,.07);border-radius:8px}
nav#alteore-nav .uav{width:29px;height:29px;background:linear-gradient(135deg,#4f7ef8,#6366f1);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff}
nav#alteore-nav .un{font-size:11.5px;font-weight:600;color:#fff}
nav#alteore-nav .upl{font-size:10px;color:rgba(255,255,255,.3)}
nav#alteore-nav .lbtn{margin-left:auto;background:none;border:none;color:rgba(255,255,255,.3);cursor:pointer;font-size:13px}
/* Mobile hamburger */
.alteore-hamburger{display:none;position:fixed;top:14px;left:14px;z-index:1001;width:44px;height:44px;background:#0f1f5c;border:none;border-radius:12px;cursor:pointer;flex-direction:column;align-items:center;justify-content:center;gap:5px;box-shadow:0 4px 16px rgba(15,31,92,.45);-webkit-tap-highlight-color:transparent}
.alteore-hamburger span{display:block;width:20px;height:2.5px;background:#fff;border-radius:2px;transition:all .25s ease}
.alteore-hamburger.open span:nth-child(1){transform:translateY(7.5px) rotate(45deg)}
.alteore-hamburger.open span:nth-child(2){opacity:0;transform:scaleX(0)}
.alteore-hamburger.open span:nth-child(3){transform:translateY(-7.5px) rotate(-45deg)}
.alteore-nav-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000}
.alteore-nav-overlay.show{display:block}
@media(max-width:768px){
  .alteore-hamburger{display:flex!important}
  nav#alteore-nav{position:fixed!important;top:0!important;left:0!important;height:100vh!important;width:min(280px,84vw)!important;z-index:1001!important;transform:translateX(-105%)!important;transition:transform .3s cubic-bezier(.4,0,.2,1)!important;overflow-y:auto!important}
  nav#alteore-nav.open{transform:translateX(0)!important;box-shadow:8px 0 32px rgba(0,0,0,.3)!important}
}
</style>`;

  // ════════════════════════════════════════════════
  // INJECTION DANS LE DOM
  // ════════════════════════════════════════════════
  function injectNav() {
    // Ne pas injecter si déjà présent
    if (document.getElementById('alteore-nav')) return;

    // Injecter le CSS dans le <head>
    if (!document.getElementById('alteore-nav-css')) {
      document.head.insertAdjacentHTML('beforeend', NAV_CSS);
    }

    // Injecter hamburger + overlay
    if (!document.querySelector('.alteore-hamburger')) {
      document.body.insertAdjacentHTML('afterbegin',
        `<button class="alteore-hamburger" id="alteore-hamburger" onclick="alteoreToggleSidebar()" aria-label="Menu"><span></span><span></span><span></span></button>
         <div class="alteore-nav-overlay" id="alteoreNavOverlay" onclick="alteoreCloseSidebar()"></div>`
      );
    }

    // Supprimer l'ancienne nav si elle existe (les deux types)
    const oldNav = document.querySelector('nav:not(#alteore-nav), aside.sidebar');
    if (oldNav) oldNav.remove();
    const oldHamburger = document.querySelector('.hamburger');
    if (oldHamburger) oldHamburger.remove();
    const oldOverlay = document.querySelector('.nav-overlay');
    if (oldOverlay) oldOverlay.remove();

    // Injecter la nouvelle nav
    document.body.insertAdjacentHTML('afterbegin', buildNavHTML());

    // Corriger le margin-left du main/aside
    const mainEl = document.querySelector('main, .main, div.main');
    if (mainEl && !mainEl.style.marginLeft) {
      mainEl.style.marginLeft = '250px';
    }
  }

  // ════════════════════════════════════════════════
  // FONCTIONS NAVIGATION (globales)
  // ════════════════════════════════════════════════
  window.toggleAlteoreNav = function(subId, el) {
    var sub = document.getElementById(subId);
    if (!sub) return;
    var isOpen = sub.style.maxHeight && sub.style.maxHeight !== '0px';
    document.querySelectorAll('nav#alteore-nav .sub').forEach(function(s) { s.style.maxHeight = '0px'; });
    if (!isOpen) {
      sub.style.maxHeight = '400px';
    }
  };

  // Compatibilité avec les anciens appels toggleNav dans les pages
  window.toggleNav = window.toggleAlteoreNav;
  window.toggleFidNav = function(el) { window.toggleAlteoreNav('fid-nav-sub', el); };

  window.alteoreToggleSidebar = function() {
    var nav = document.getElementById('alteore-nav');
    var overlay = document.getElementById('alteoreNavOverlay');
    var btn = document.getElementById('alteore-hamburger');
    if (nav) nav.classList.toggle('open');
    if (overlay) overlay.classList.toggle('show');
    if (btn) btn.classList.toggle('open');
  };
  window.alteoreCloseSidebar = function() {
    var nav = document.getElementById('alteore-nav');
    var overlay = document.getElementById('alteoreNavOverlay');
    var btn = document.getElementById('alteore-hamburger');
    if (nav) nav.classList.remove('open');
    if (overlay) overlay.classList.remove('show');
    if (btn) btn.classList.remove('open');
  };
  // Compatibilité anciens noms
  window.toggleSidebar = window.alteoreToggleSidebar;
  window.closeSidebar = window.alteoreCloseSidebar;

  // ════════════════════════════════════════════════
  // MODALE UPGRADE
  // ════════════════════════════════════════════════
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
      </div>`;
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.style.display = 'none'; });
    document.body.appendChild(modal);
    if (!document.getElementById('nav-modal-style')) {
      const s = document.createElement('style');
      s.id = 'nav-modal-style';
      s.textContent = '@keyframes navPop{from{transform:scale(.92);opacity:0}to{transform:scale(1);opacity:1}}';
      document.head.appendChild(s);
    }
  }

  function showUpgradeModal(upgrade) {
    injectUpgradeModal();
    const configs = {
      fidelisation: { icon:'💎', title:'Fidélisation — Plan Max requis', desc:'La gestion des clients, cartes de fidélité, coupons et campagnes SMS est disponible dès le plan <strong>Max (99€/mois)</strong> ou <strong>Master (169€/mois)</strong>.', cta:'⭐ Passer au plan Max' },
      bilan:        { icon:'🤖', title:'Analyse de Bilan — Plan Master requis', desc:'L\'analyse de bilan comptable par intelligence artificielle est disponible avec le plan <strong>Master (169€/mois)</strong>.', cta:'⭐ Passer au plan Master' },
      rapport:      { icon:'📄', title:'Rapport annuel PDF — Plan Pro requis', desc:'La génération de rapports annuels PDF est disponible dès le plan <strong>Pro (69€/mois)</strong>.', cta:'⭐ Passer au plan Pro' },
      import:       { icon:'📥', title:'Import/Export — Plan Pro requis', desc:"L'import et l'export de données est disponible dès le plan <strong>Pro (69€/mois)</strong>.", cta:'⭐ Passer au plan Pro' },
      core:         { icon:'📊', title:'Fonctionnalité Premium', desc:'Cette fonctionnalité est disponible dès le plan <strong>Pro (69€/mois)</strong>.', cta:'⭐ Voir les plans' }
    };
    const cfg = configs[upgrade] || configs.core;
    document.getElementById('nav-modal-icon').textContent = cfg.icon;
    document.getElementById('nav-modal-title').textContent = cfg.title;
    document.getElementById('nav-modal-desc').innerHTML = cfg.desc;
    document.getElementById('nav-modal-cta').textContent = cfg.cta;
    document.getElementById('nav-modal-cta').onclick = function() { location.href = 'profil.html?tab=abonnement&upgrade=' + upgrade; };
    document.getElementById('nav-upgrade-modal').style.display = 'flex';
  }
  window._showUpgradeModal = showUpgradeModal;

  // ════════════════════════════════════════════════
  // VERROUILLAGE PLAN
  // ════════════════════════════════════════════════
  function lockNavItem(id, badge, upgrade) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.opacity = '0.4';
    el.style.cursor = 'pointer';
    const icon = el.querySelector('span:first-child');
    if (icon) icon.textContent = '🔒';
    if (!el.querySelector('.nav-lock-badge')) {
      const b = document.createElement('span');
      b.className = 'nav-lock-badge';
      b.textContent = badge;
      b.style.cssText = 'font-size:9px;font-weight:700;background:linear-gradient(135deg,#f59e0b,#fbbf24);color:#1a1f36;padding:2px 6px;border-radius:20px;margin-left:auto;flex-shrink:0;pointer-events:none';
      el.appendChild(b);
    }
    el.setAttribute('onclick', '');
    el.addEventListener('click', function(e) {
      e.preventDefault(); e.stopImmediatePropagation();
      showUpgradeModal(upgrade);
    }, true);
    // Masquer le sous-menu associé
    const subMap = { 'nav-fid': 'fid-nav-sub' };
    if (subMap[id]) { const s = document.getElementById(subMap[id]); if (s) s.style.display = 'none'; }
  }

  function applyNavPlan(plan) {
    window._userPlan = plan;
    const upl = document.getElementById('uplan');
    if (upl) upl.textContent = PLAN_NAMES[plan] || plan;
    if (!CAN_FIDELISATION.includes(plan)) lockNavItem('nav-fid',    'Max+',  'fidelisation');
    if (!CAN_IMPORT.includes(plan))       lockNavItem('nav-import',  'Pro+',  'import');
    if (!CAN_BILAN.includes(plan))        lockNavItem('nav-bilan',   'Master','bilan');
    if (!CAN_RAPPORT.includes(plan))      lockNavItem('nav-rapport', 'Pro+',  'rapport');
    const mainEl = document.querySelector('main, .main');
    if (mainEl) mainEl.style.visibility = 'visible';
  }

  function checkPageAccess(plan) {
    if (PAGE === 'fidelisation.html' && !CAN_FIDELISATION.includes(plan)) { showUpgradeModal('fidelisation'); return false; }
    if (PAGE === 'import.html'       && !CAN_IMPORT.includes(plan))       { showUpgradeModal('import');       return false; }
    if (PAGE === 'bilan.html'        && !CAN_BILAN.includes(plan))        { showUpgradeModal('bilan');        return false; }
    if (PAGE === 'rapport-annuel.html' && !CAN_RAPPORT.includes(plan))    { showUpgradeModal('rapport');      return false; }
    const corePages = ['pilotage.html','marges.html','cout-revient.html','panier-moyen.html','dettes.html','suivi-ca.html','dashboard.html','cashflow.html','rapport-annuel.html'];
    if (corePages.includes(PAGE) && !CAN_CORE.includes(plan)) { showUpgradeModal('core'); return false; }
    return true;
  }

  // ════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════
  const mainEl = document.querySelector('main, .main');
  if (mainEl && !window._firebaseReady) mainEl.style.visibility = 'hidden';
  // Failsafe 2s
  setTimeout(function() { if (mainEl) mainEl.style.visibility = 'visible'; }, 2000);

  // Injecter la nav immédiatement (pas besoin d'attendre Firebase)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectNav);
  } else {
    injectNav();
  }

  // Attendre Firebase pour les droits plan
  function waitForFirebase(cb, tries) {
    tries = tries || 0;
    if (window._uid && window._getDoc && window._db && window._doc) { cb(); }
    else if (tries < 30) { setTimeout(function() { waitForFirebase(cb, tries + 1); }, 100); }
    else { if (mainEl) mainEl.style.visibility = 'visible'; applyNavPlan('pro'); }
  }

  waitForFirebase(async function() {
    try {
      const snap = await window._getDoc(window._doc(window._db, 'users', window._uid));
      const plan = snap.exists() ? (snap.data().plan || 'free') : 'free';
      // Màj nom utilisateur
      const user = window._auth && window._auth.currentUser;
      if (user) {
        const n = user.displayName || user.email?.split('@')[0] || '';
        const av = document.getElementById('av'); if (av) av.textContent = n[0]?.toUpperCase() || 'A';
        const un = document.getElementById('uname'); if (un) un.textContent = n;
      }
      if (!checkPageAccess(plan)) { applyNavPlan(plan); return; }
      applyNavPlan(plan);
      handleProfilParams();
    } catch(e) {
      if (mainEl) mainEl.style.visibility = 'visible';
      applyNavPlan('pro');
    }
  });

  function handleProfilParams() {
    if (PAGE !== 'profil.html') return;
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

})();
