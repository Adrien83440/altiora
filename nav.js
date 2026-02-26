// ── nav.js — Alteore ── v3 (nav centralisée + module RH Master)
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
  const CAN_STOCK        = ['max', 'master', 'trial', 'dev'];
  const CAN_BILAN        = ['master', 'trial', 'dev'];
  const CAN_RAPPORT      = ['pro', 'max', 'master', 'dev'];
  const CAN_RH           = ['master', 'trial', 'dev'];

  // Pages RH
  const RH_PAGES = [
    'rh-dashboard.html','rh-employes.html','rh-planning.html','rh-conges.html',
    'rh-temps.html','rh-paie.html','rh-recrutement.html','rh-onboarding.html',
    'rh-documents.html','rh-entretiens.html','rh-conformite.html',
    'rh-formations.html','rh-modeles.html','rh-rapport.html'
  ];

  // ════════════════════════════════════════════════
  // PAGE ACTIVE — détection automatique
  // ════════════════════════════════════════════════
  const PAGE = location.pathname.split('/').pop() || 'dashboard.html';

  // ════════════════════════════════════════════════
  // INJECTION NAV HTML
  // ════════════════════════════════════════════════
  function buildNavHTML() {
    function active(page) { return PAGE === page ? ' on' : ''; }
    function activeNI(pages) { return pages.includes(PAGE) ? ' on' : ''; }

    const kpisPages = ['cout-revient.html','marges.html','panier-moyen.html','dettes.html','gestion-stock.html'];
    const kpisOpen  = kpisPages.includes(PAGE) ? 'style="max-height:400px"' : '';
    const pilOpen   = PAGE === 'pilotage.html' || PAGE === 'cashflow.html' ? 'style="max-height:400px"' : '';
    const fidOpen   = PAGE === 'fidelisation.html' ? 'style="max-height:400px"' : '';
    const rhOpen    = ''; // Jamais ouvert automatiquement — uniquement sur clic

    return `
<nav id="alteore-nav">
  <div class="nav-scroll-area">
  <div class="logo">
    <svg width="32" height="28" viewBox="0 0 120 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="nav-lg-ae" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#00e5ff"/>
          <stop offset="100%" stop-color="#1a3dce"/>
        </linearGradient>
      </defs>
      <polygon points="38,80 55,20 72,80 65,80 55,45 45,80" fill="url(#nav-lg-ae)"/>
      <polygon points="68,24 105,24 102,32 68,32" fill="url(#nav-lg-ae)"/>
      <polygon points="68,44 100,44 97,52 68,52" fill="url(#nav-lg-ae)"/>
      <polygon points="68,64 95,64 92,72 68,72" fill="url(#nav-lg-ae)"/>
    </svg>
    <div class="logo-t">ALTEORE</div>
  </div>

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
    <div class="si${active('gestion-stock.html')}" id="nav-stock" onclick="location.href='gestion-stock.html'"><span class="dot"></span>Gestion des Stocks</div>
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
    <span class="chev">›</span>
  </div>
  <div class="sub" id="fid-nav-sub" ${fidOpen}>
    <div class="si${active('fidelisation.html')}" onclick="location.href='fidelisation.html'"><span class="dot"></span>Dashboard fidélité</div>
    <div class="si" onclick="location.href='fidelisation.html';setTimeout(()=>window.switchTab&&window.switchTab('clients',null),300)"><span class="dot"></span>Clients</div>
    <div class="si" onclick="location.href='fidelisation.html';setTimeout(()=>window.switchTab&&window.switchTab('carte',null),300)"><span class="dot"></span>Carte fidélité</div>
    <div class="si" onclick="location.href='fidelisation.html';setTimeout(()=>window.switchTab&&window.switchTab('points',null),300)"><span class="dot"></span>Points &amp; Récompenses</div>
    <div class="si" onclick="location.href='fidelisation.html';setTimeout(()=>window.switchTab&&window.switchTab('coupons',null),300)"><span class="dot"></span>Coupons &amp; Offres</div>
    <div class="si" onclick="location.href='fidelisation.html';setTimeout(()=>window.switchTab&&window.switchTab('campagnes',null),300)"><span class="dot"></span>Campagnes</div>
  </div>

  <!-- ══════════════════════════════════════ -->
  <!-- MODULE RH — Plan Master               -->
  <!-- ══════════════════════════════════════ -->
  <div class="ns rh-ns">Ressources Humaines</div>
  <div class="ni rh-ni${activeNI(RH_PAGES)}" id="nav-rh" onclick="toggleAlteoreNav('rh-nav-sub',this)">
    <span>👥</span><span style="flex:1">Module RH</span>
    <span style="font-size:9px;font-weight:700;background:rgba(16,185,129,.2);color:#6ee7b7;padding:2px 6px;border-radius:20px;margin-right:4px">Master</span>
    <span class="chev rh-chev">›</span>
  </div>
  <div class="sub" id="rh-nav-sub" ${rhOpen}>

    <div class="rh-sub-group">Accueil</div>
    <div class="si rh-si${active('rh-dashboard.html')}" onclick="location.href='rh-dashboard.html'"><span class="dot rh-dot"></span>Dashboard RH</div>

    <div class="rh-sub-group">RH Core</div>
    <div class="si rh-si${active('rh-employes.html')}" onclick="location.href='rh-employes.html'"><span class="dot rh-dot"></span>Employés &amp; Fiches</div>
    <div class="si rh-si${active('rh-planning.html')}" onclick="location.href='rh-planning.html'"><span class="dot rh-dot"></span>Planning</div>
    <div class="si rh-si${active('rh-conges.html')}" onclick="location.href='rh-conges.html'"><span class="dot rh-dot"></span>Congés</div>
    <div class="si rh-si${active('rh-temps.html')}" onclick="location.href='rh-temps.html'"><span class="dot rh-dot"></span>Temps de travail</div>
    <div class="si rh-si${active('rh-paie.html')}" onclick="location.href='rh-paie.html'"><span class="dot rh-dot"></span>Paie &amp; Salaires</div>
    <div class="si rh-si${active('rh-recrutement.html')}" onclick="location.href='rh-recrutement.html'"><span class="dot rh-dot"></span>Recrutement</div>

    <div class="rh-sub-group">Gestion</div>
    <div class="si rh-si${active('rh-onboarding.html')}" onclick="location.href='rh-onboarding.html'"><span class="dot rh-dot"></span>Onboarding / Offboarding</div>
    <div class="si rh-si${active('rh-documents.html')}" onclick="location.href='rh-documents.html'"><span class="dot rh-dot"></span>Documents RH</div>
    <div class="si rh-si${active('rh-entretiens.html')}" onclick="location.href='rh-entretiens.html'"><span class="dot rh-dot"></span>Entretiens annuels</div>
    <div class="si rh-si${active('rh-conformite.html')}" onclick="location.href='rh-conformite.html'"><span class="dot rh-dot"></span>Conformité &amp; Légal</div>
    <div class="si rh-si${active('rh-formations.html')}" onclick="location.href='rh-formations.html'"><span class="dot rh-dot"></span>Plan de formation</div>
    <div class="si rh-si${active('rh-modeles.html')}" onclick="location.href='rh-modeles.html'"><span class="dot rh-dot"></span>Modèles de documents</div>

  </div>

  </div><!-- /nav-scroll-area -->
  <div class="nav-footer">
    <div class="ni" id="nav-import" onclick="location.href='import.html'" style="border-top:1px solid rgba(255,255,255,.08);padding:10px 0 8px;margin:0">
      <span>📥</span><span>Import de données</span>
    </div>
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

  // ════════════════════════════════════════════════
  // CSS INJECTÉ
  // ════════════════════════════════════════════════
  const NAV_CSS = `
<style id="alteore-nav-css">
nav#alteore-nav{width:250px;height:100vh;background:linear-gradient(180deg,#0f1f5c,#162366);position:fixed;top:0;left:0;display:flex;flex-direction:column;overflow:hidden;z-index:99;box-sizing:border-box}
nav#alteore-nav .nav-scroll-area{flex:1;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.12) transparent}
nav#alteore-nav .nav-scroll-area::-webkit-scrollbar{width:4px}
nav#alteore-nav .nav-scroll-area::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:99px}
nav#alteore-nav.rh-mode .nav-scroll-area::-webkit-scrollbar-thumb{background:rgba(52,211,153,.3)}
nav#alteore-nav .logo{display:flex;align-items:center;gap:10px;padding:22px 18px;border-bottom:1px solid rgba(255,255,255,.08)}
nav#alteore-nav .logo-i{width:33px;height:33px;background:rgba(255,255,255,.14);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:15px}
nav#alteore-nav .logo-t{font-size:17px;font-weight:800;color:#fff;letter-spacing:1px}
nav#alteore-nav .ns{font-size:10px;font-weight:700;color:rgba(255,255,255,.28);letter-spacing:1px;text-transform:uppercase;padding:12px 18px 4px}
nav#alteore-nav .ni{display:flex;align-items:center;gap:9px;padding:9px 18px;color:rgba(255,255,255,.55);font-size:12.5px;font-weight:500;cursor:pointer;border-left:3px solid transparent;transition:.15s}
nav#alteore-nav .ni:hover{color:#fff;background:rgba(255,255,255,.06)}
nav#alteore-nav .ni.on{color:#fff;background:rgba(255,255,255,.1);border-left-color:#4f7ef8}
nav#alteore-nav .sub{overflow:hidden;max-height:0;transition:max-height .5s ease}
nav#alteore-nav .si{display:flex;align-items:center;gap:7px;padding:7px 18px 7px 40px;color:rgba(255,255,255,.4);font-size:12px;cursor:pointer;border-left:3px solid transparent;transition:.15s}
nav#alteore-nav .si:hover{color:rgba(255,255,255,.75);background:rgba(255,255,255,.04)}
nav#alteore-nav .si.on{color:#fff;background:rgba(79,126,248,.15);border-left-color:rgba(79,126,248,.6)}
nav#alteore-nav .dot{width:5px;height:5px;border-radius:50%;background:rgba(255,255,255,.25);display:inline-block;flex-shrink:0}
nav#alteore-nav .si.on .dot{background:#4f7ef8}
nav#alteore-nav .chev{font-size:11px;color:rgba(255,255,255,.3);transition:transform .25s;margin-left:auto}
nav#alteore-nav .nav-footer{flex-shrink:0;padding:12px 18px 8px;border-top:1px solid rgba(255,255,255,.08)}
nav#alteore-nav .ucard{display:flex;align-items:center;gap:8px;padding:8px;background:rgba(255,255,255,.07);border-radius:8px}
nav#alteore-nav .uav{width:29px;height:29px;background:linear-gradient(135deg,#4f7ef8,#6366f1);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff}
nav#alteore-nav .un{font-size:11.5px;font-weight:600;color:#fff}
nav#alteore-nav .upl{font-size:10px;color:rgba(255,255,255,.3)}
nav#alteore-nav .lbtn{margin-left:auto;background:none;border:none;color:rgba(255,255,255,.3);cursor:pointer;font-size:13px}

/* ── RH MODULE — vert sur items RH ── */
nav#alteore-nav .rh-ns{color:rgba(52,211,153,.55);letter-spacing:1px}
nav#alteore-nav .ni.rh-ni{border-left-color:transparent}
nav#alteore-nav .ni.rh-ni:hover{background:rgba(16,185,129,.08)}
nav#alteore-nav .ni.rh-ni.on{color:#fff;background:rgba(16,185,129,.13);border-left-color:#10b981}
nav#alteore-nav .rh-chev{color:rgba(52,211,153,.45) !important}
nav#alteore-nav .rh-sub-group{font-size:9px;font-weight:700;color:rgba(52,211,153,.4);letter-spacing:1px;text-transform:uppercase;padding:8px 18px 3px 18px;margin-top:4px}
nav#alteore-nav .rh-si{color:rgba(255,255,255,.4)}
nav#alteore-nav .rh-si:hover{color:rgba(255,255,255,.82);background:rgba(16,185,129,.07)}
nav#alteore-nav .rh-si.on{color:#fff;background:rgba(16,185,129,.17);border-left-color:rgba(16,185,129,.75)}
nav#alteore-nav .rh-dot{background:rgba(52,211,153,.28)}
nav#alteore-nav .rh-si.on .rh-dot{background:#10b981}
/* Le sous-menu RH s'étend normalement — c'est la nav entière qui scrolle */
/* rh-nav-sub utilise le .sub standard — pas de règle spéciale nécessaire */

/* ── THÈME VERT GLOBAL — toute la sidebar passe en vert quand RH est ouvert ── */
nav#alteore-nav.rh-mode{background:linear-gradient(180deg,#052e16 0%,#064e23 50%,#065f2c 100%);transition:background .45s ease}
nav#alteore-nav.rh-mode .logo{border-bottom-color:rgba(52,211,153,.15)}
nav#alteore-nav.rh-mode .logo-t{background:linear-gradient(135deg,#34d399,#6ee7b7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
nav#alteore-nav.rh-mode .ns{color:rgba(52,211,153,.35)}
nav#alteore-nav.rh-mode .rh-ns{color:rgba(52,211,153,.7)}
nav#alteore-nav.rh-mode .ni{color:rgba(255,255,255,.5);transition:.15s}
nav#alteore-nav.rh-mode .ni:hover{background:rgba(52,211,153,.08)}
nav#alteore-nav.rh-mode .ni.on{background:rgba(52,211,153,.12);border-left-color:#34d399}
nav#alteore-nav.rh-mode .ni.rh-ni.on{background:rgba(52,211,153,.18);border-left-color:#10b981}
nav#alteore-nav.rh-mode .si{color:rgba(255,255,255,.38)}
nav#alteore-nav.rh-mode .si:hover{background:rgba(52,211,153,.07)}
nav#alteore-nav.rh-mode .si.on{background:rgba(52,211,153,.15);border-left-color:rgba(52,211,153,.65)}
nav#alteore-nav.rh-mode .si.on .dot{background:#34d399}
nav#alteore-nav.rh-mode .rh-sub-group{color:rgba(52,211,153,.55)}
nav#alteore-nav.rh-mode .rh-si:hover{background:rgba(52,211,153,.1)}
nav#alteore-nav.rh-mode .rh-si.on{background:rgba(52,211,153,.2);border-left-color:#10b981}
nav#alteore-nav.rh-mode .nav-footer{border-top-color:rgba(52,211,153,.15);background:linear-gradient(180deg,transparent,#065f2c 18px)}
nav#alteore-nav.rh-mode .ucard{background:rgba(52,211,153,.1)}
nav#alteore-nav.rh-mode .uav{background:linear-gradient(135deg,#10b981,#34d399)}
nav#alteore-nav.rh-mode .chev{color:rgba(52,211,153,.35)}
nav#alteore-nav.rh-mode .rh-chev{color:rgba(52,211,153,.7) !important}
nav#alteore-nav.rh-mode #rh-nav-sub::-webkit-scrollbar-thumb{background:rgba(52,211,153,.35)}


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
    if (document.getElementById('alteore-nav')) return;
    if (!document.getElementById('alteore-nav-css')) {
      document.head.insertAdjacentHTML('beforeend', NAV_CSS);
    }
    if (!document.querySelector('.alteore-hamburger')) {
      document.body.insertAdjacentHTML('afterbegin',
        `<button class="alteore-hamburger" id="alteore-hamburger" onclick="alteoreToggleSidebar()" aria-label="Menu"><span></span><span></span><span></span></button>
         <div class="alteore-nav-overlay" id="alteoreNavOverlay" onclick="alteoreCloseSidebar()"></div>`
      );
    }
    const oldNav = document.querySelector('nav:not(#alteore-nav), aside.sidebar');
    if (oldNav) oldNav.remove();
    const oldHamburger = document.querySelector('.hamburger');
    if (oldHamburger) oldHamburger.remove();
    const oldOverlay = document.querySelector('.nav-overlay');
    if (oldOverlay) oldOverlay.remove();

    document.body.insertAdjacentHTML('afterbegin', buildNavHTML());

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
    var nav = document.getElementById('alteore-nav');
    var isOpen = sub.style.maxHeight && sub.style.maxHeight !== '0px';
    // Fermer tous les sous-menus
    document.querySelectorAll('nav#alteore-nav .sub').forEach(function(s) { s.style.maxHeight = '0px'; });
    if (!isOpen) {
      sub.style.maxHeight = '2000px';
      // Thème vert si RH, bleu sinon
      if (nav) {
        if (subId === 'rh-nav-sub') nav.classList.add('rh-mode');
        else nav.classList.remove('rh-mode');
      }
    } else {
      // Fermeture du menu RH : repasser en bleu
      if (nav && subId === 'rh-nav-sub') nav.classList.remove('rh-mode');
    }
  };

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
      fidelisation: { icon:'💎', title:'Fidélisation — Plan Max requis',     desc:'La gestion des clients, cartes de fidélité, coupons et campagnes SMS est disponible dès le plan <strong>Max (99€/mois)</strong> ou <strong>Master (169€/mois)</strong>.', cta:'⭐ Passer au plan Max' },
      bilan:        { icon:'🤖', title:'Analyse de Bilan — Plan Master requis', desc:'L\'analyse de bilan comptable par intelligence artificielle est disponible avec le plan <strong>Master (169€/mois)</strong>.', cta:'⭐ Passer au plan Master' },
      rapport:      { icon:'📄', title:'Rapport annuel PDF — Plan Pro requis', desc:'La génération de rapports annuels PDF est disponible dès le plan <strong>Pro (69€/mois)</strong>.', cta:'⭐ Passer au plan Pro' },
      import:       { icon:'📥', title:'Import/Export — Plan Pro requis',     desc:"L'import et l'export de données est disponible dès le plan <strong>Pro (69€/mois)</strong>.", cta:'⭐ Passer au plan Pro' },
      rh:           { icon:'👥', title:'Module RH — Plan Master requis',      desc:'La gestion complète des ressources humaines (employés, planning, congés, paie, recrutement, conformité…) est disponible avec le plan <strong>Master (169€/mois)</strong>.', cta:'⭐ Passer au plan Master' },
      core:         { icon:'📊', title:'Fonctionnalité Premium',              desc:'Cette fonctionnalité est disponible dès le plan <strong>Pro (69€/mois)</strong>.', cta:'⭐ Voir les plans' }
    };
    const cfg = configs[upgrade] || configs.core;
    document.getElementById('nav-modal-icon').textContent    = cfg.icon;
    document.getElementById('nav-modal-title').textContent   = cfg.title;
    document.getElementById('nav-modal-desc').innerHTML      = cfg.desc;
    document.getElementById('nav-modal-cta').textContent     = cfg.cta;
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
    const subMap = { 'nav-fid': 'fid-nav-sub', 'nav-rh': 'rh-nav-sub' };
    if (subMap[id]) { const s = document.getElementById(subMap[id]); if (s) s.style.display = 'none'; }
  }

  function applyNavPlan(plan) {
    window._userPlan = plan;
    const upl = document.getElementById('uplan');
    if (upl) upl.textContent = PLAN_NAMES[plan] || plan;
    if (!CAN_FIDELISATION.includes(plan)) lockNavItem('nav-fid',    'Max+',   'fidelisation');
    if (!CAN_STOCK.includes(plan))        lockNavItem('nav-stock',  'Max+',   'stock');
    if (!CAN_IMPORT.includes(plan))       lockNavItem('nav-import', 'Pro+',   'import');
    if (!CAN_BILAN.includes(plan))        lockNavItem('nav-bilan',  'Master', 'bilan');
    if (!CAN_RAPPORT.includes(plan))      lockNavItem('nav-rapport','Pro+',   'rapport');
    if (!CAN_RH.includes(plan))           lockNavItem('nav-rh',     'Master', 'rh');
    const mainEl = document.querySelector('main, .main');
    if (mainEl) mainEl.style.visibility = 'visible';
  }

  function checkPageAccess(plan) {
    if (PAGE === 'gestion-stock.html'   && !CAN_STOCK.includes(plan))        { showUpgradeModal('stock');        return false; }
    if (PAGE === 'fidelisation.html'    && !CAN_FIDELISATION.includes(plan)) { showUpgradeModal('fidelisation'); return false; }
    if (PAGE === 'import.html'          && !CAN_IMPORT.includes(plan))       { showUpgradeModal('import');       return false; }
    if (PAGE === 'bilan.html'           && !CAN_BILAN.includes(plan))        { showUpgradeModal('bilan');        return false; }
    if (PAGE === 'rapport-annuel.html'  && !CAN_RAPPORT.includes(plan))      { showUpgradeModal('rapport');      return false; }
    if (RH_PAGES.includes(PAGE)         && !CAN_RH.includes(plan))           { showUpgradeModal('rh');           return false; }
    const corePages = ['pilotage.html','marges.html','cout-revient.html','panier-moyen.html','dettes.html','suivi-ca.html','cashflow.html'];
    if (corePages.includes(PAGE) && !CAN_CORE.includes(plan)) { showUpgradeModal('core'); return false; }
    return true;
  }

  // ════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════
  const mainEl = document.querySelector('main, .main');
  if (mainEl && !window._firebaseReady) mainEl.style.visibility = 'hidden';
  // Failsafe 2s — ne jamais bloquer la page
  setTimeout(function() { if (mainEl) mainEl.style.visibility = 'visible'; }, 2000);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectNav);
  } else {
    injectNav();
  }

  function waitForFirebase(cb, tries) {
    tries = tries || 0;
    if (window._uid && window._getDoc && window._db && window._doc) { cb(); }
    else if (tries < 30) { setTimeout(function() { waitForFirebase(cb, tries + 1); }, 100); }
    else {
      if (mainEl) mainEl.style.visibility = 'visible';
      applyNavPlan('dev');
    }
  }

  waitForFirebase(async function() {
    try {
      const snap = await window._getDoc(window._doc(window._db, 'users', window._uid));
      const plan = snap.exists() ? (snap.data().plan || 'free') : 'free';
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
