// ── nav.js — Alteore ── v6 (nav par usage : Au quotidien / Mes résultats / Développer + CTA Saisir + mode découverte + encart migration)
(function () {

  // ── Vercel Analytics ──
  if (!document.querySelector('script[src*="/_vercel/insights"]')) {
    var va = document.createElement('script');
    va.defer = true;
    va.src = '/_vercel/insights/script.js';
    document.head.appendChild(va);
  }

  // ── updates.js : système de news/changelog in-app ──
  // Injecté ici pour être dispo sur toutes les pages du dashboard (qui chargent nav.js).
  // Il s'auto-init et attend que Firebase + le logo sidebar soient prêts.
  if (!document.querySelector('script[src*="updates.js"]')) {
    var upd = document.createElement('script');
    upd.defer = true;
    upd.src = '/updates.js';
    document.head.appendChild(upd);
  }

  // ── admin-panel.js : bouton flottant admin (uniquement pour role=admin) ──
  // S'injecte uniquement si l'utilisateur a le rôle admin. Sinon zéro impact.
  if (!document.querySelector('script[src*="admin-panel.js"]')) {
    var adm = document.createElement('script');
    adm.defer = true;
    adm.src = '/admin-panel.js';
    document.head.appendChild(adm);
  }

  // ════════════════════════════════════════════════
  // CONFIG PLANS
  // ════════════════════════════════════════════════
  const PLAN_NAMES = {
    free: 'Plan Gratuit', trial: 'Essai gratuit', trial_expired: 'Essai expiré', deleted: 'Compte supprimé', pro: 'Alteore Pro',
    max: 'Alteore Max', master: 'Alteore Master', past_due: 'Paiement en attente', dev: 'Dev / Admin',
    promo_expired: 'Offre expirée'
  };
  const CAN_FIDELISATION = ['trial', 'max', 'master', 'dev'];
  const CAN_IMPORT       = ['trial', 'pro', 'max', 'master', 'dev'];
  const CAN_CORE         = ['trial', 'pro', 'max', 'master', 'dev'];
  const CAN_STOCK        = ['pro', 'max', 'master', 'trial', 'dev'];
  const CAN_BILAN        = ['max', 'master', 'trial', 'dev'];
  const CAN_RAPPORT      = ['trial', 'pro', 'max', 'master', 'dev'];
  const CAN_RH           = ['master', 'trial', 'dev'];
  const CAN_SCENARIOS    = ['max', 'master', 'trial', 'dev'];
  const CAN_PREVISIONS   = ['master', 'trial', 'dev'];

  // ── AGENT LÉA (Wave 1+) ──
  // Pages qui nécessitent soit le trial, soit l'addon Léa (agentEnabled),
  // soit le mode dégradé (agentDegradedMode) pour l'accès en lecture.
  const AGENT_PAGES = ['agent.html', 'agent-historique.html'];
  // agent-upgrade.html est accessible à tous les plans payants (pro/max/master/trial/dev)
  // pour permettre l'activation de l'addon.
  const CAN_AGENT_UPGRADE = ['pro', 'max', 'master', 'trial', 'dev'];

  // Pages RH (contrôle d'accès + détection page active)
  const RH_PAGES = [
    'rh-dashboard.html', 'rh-employes.html', 'rh-planning.html', 'rh-conges.html',
    'rh-temps.html', 'rh-paie.html', 'rh-dirigeant.html', 'rh-objectifs.html', 'rh-recrutement.html',
    'rh-onboarding.html', 'rh-entretiens.html',
    'rh-conformite.html', 'rh-modeles.html', 'rh-documents.html', 'rh-rapport.html',
    'rh-contrats.html', 'rh-pointages.html', 'rh-emargements.html', 'rh-urgence.html'
  ];

  // Pages Fidélisation (détection sidebar dorée)
  const FID_PAGES = ['fidelisation.html'];

  // ════════════════════════════════════════════════
  // PAGE ACTIVE
  // ════════════════════════════════════════════════
  const PAGE = location.pathname.split('/').pop() || 'dashboard.html';
  // Année active dans le pilotage (lue depuis ?year=XXXX)
  const ACTIVE_YEAR = parseInt(new URLSearchParams(location.search).get('year')) || new Date().getFullYear();
  // Génère les années dynamiquement : année courante -1, courante, courante +1
  const CUR_YEAR = new Date().getFullYear();
  const PIL_YEARS = [CUR_YEAR - 1, CUR_YEAR, CUR_YEAR + 1];
  // _pilYears : liste effective (fusionne PIL_YEARS + années ajoutées par l'user via Firestore)
  // Initialisée avec PIL_YEARS, mise à jour après lecture du snap users/{uid}
  window._pilYears = PIL_YEARS.slice();

  // ════════════════════════════════════════════════
  // BUILD NAV HTML
  // ════════════════════════════════════════════════
  function buildNavHTML() {
    function a(page)  { return PAGE === page ? ' on' : ''; }
    function aNI(arr) { return arr.includes(PAGE) ? ' on' : ''; }

    // ── Groupes ouverts selon la page active (v6 : nav par usage) ──
    const rentPages  = ['cout-revient.html', 'marges.html', 'panier-moyen.html'];
    const tresoPages = ['cashflow.html', 'dettes.html'];
    const bankPages  = ['banque.html', 'bank-validation.html', 'import.html', 'import-releve.html', 'import-facture-achat.html'];
    const kpisOpen  = rentPages.includes(PAGE)     ? 'style="max-height:500px"'  : '';
    const pilOpen   = PAGE === 'pilotage.html'     ? 'style="max-height:500px"'  : '';
    const tresoOpen = tresoPages.includes(PAGE)    ? 'style="max-height:500px"'  : '';
    const bankOpen  = bankPages.includes(PAGE)     ? 'style="max-height:500px"'  : '';
    const fidOpen   = PAGE === 'fidelisation.html' ? 'style="max-height:500px"'  : '';
    const rhOpen    = RH_PAGES.includes(PAGE)      ? 'style="max-height:4000px"' : '';
    const rot = ' style="transform:rotate(90deg)"';

    return `
<nav id="alteore-nav"${RH_PAGES.includes(PAGE) ? ' class="rh-mode"' : FID_PAGES.includes(PAGE) ? ' class="fid-mode"' : ''}>
  <div class="nav-scroll-area">

    <div class="logo">
      <svg width="32" height="28" viewBox="0 0 120 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="nav-lg-ae" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#00e5ff"/><stop offset="100%" stop-color="#1a3dce"/>
          </linearGradient>
        </defs>
        <polygon points="38,80 55,20 72,80 65,80 55,45 45,80" fill="url(#nav-lg-ae)"/>
        <polygon points="68,24 105,24 102,32 68,32"           fill="url(#nav-lg-ae)"/>
        <polygon points="68,44 100,44 97,52 68,52"            fill="url(#nav-lg-ae)"/>
        <polygon points="68,64 95,64 92,72 68,72"             fill="url(#nav-lg-ae)"/>
      </svg>
      <div class="logo-t">ALTEORE</div>
    </div>

    <!-- CTA action n°1 : saisir ses chiffres -->
    <div class="nav-cta" onclick="location.href='pilotage.html'">✏️ <span>Saisir mes chiffres</span></div>

    <!-- Carte "Bien démarrer" — remplie par initNavExtras() si nouveau compte -->
    <div class="nav-start" id="nav-start-card" style="display:none" onclick="if(window._navStartLink)location.href=window._navStartLink">
      <div class="nav-start-top"><span>Bien démarrer</span><b id="nav-start-count">0/5</b></div>
      <div class="nav-start-bar"><i id="nav-start-fill" style="width:0%"></i></div>
      <div class="nav-start-hint" id="nav-start-hint"></div>
    </div>

    <!-- ═══ ① AU QUOTIDIEN ═══ -->
    <div class="ns"><span class="step">1</span>Au quotidien</div>

    <div class="ni grp" id="nav-pilotage" onclick="toggleAlteoreNav('pil-sub',this)">
      <span class="chip c-blue">🧭</span><span class="lbl b">Pilotage</span><span class="chev" id="chev-pil"${pilOpen ? rot : ''}>›</span>
    </div>
    <div class="sub" id="pil-sub" ${pilOpen}>
      ${window._pilYears.map(y => `<div data-pil-year="${y}" class="si${PAGE === 'pilotage.html' && ACTIVE_YEAR === y ? ' on' : ''}" onclick="location.href='pilotage.html?year=${y}'"><span class="dot"></span>Pilotage ${y}</div>`).join('\n      ')}
      <div id="pil-add-year-btn" style="display:flex;align-items:center;gap:8px;padding:7px 20px 7px 44px;color:rgba(255,255,255,.35);font-size:11px;cursor:pointer;transition:.15s" onmouseenter="this.style.color='rgba(255,255,255,.7)'" onmouseleave="this.style.color='rgba(255,255,255,.35)'" onclick="addPilotageYear()"><span style="font-size:14px;line-height:1">＋</span> Ajouter une année</div>
    </div>

    <div class="ni grp" id="nav-banque" onclick="toggleAlteoreNav('bank-sub',this)">
      <span class="chip c-teal">🏦</span><span class="lbl b">Banque &amp; imports</span><span class="plan-badge nv">Nouveau</span><span class="chev" id="chev-bank"${bankOpen ? rot : ''}>›</span>
    </div>
    <div class="sub" id="bank-sub" ${bankOpen}>
      <div class="si${a('banque.html') || a('bank-validation.html')}" onclick="location.href='banque.html'">Connexion bancaire</div>
      <div class="si${a('import.html')}" id="nav-import" onclick="location.href='import.html'">Import de données</div>
    </div>

    <!-- ═══ ② MES RÉSULTATS ═══ -->
    <div class="ns"><span class="step">2</span>Mes résultats</div>

    <div class="ni${a('dashboard.html')}" id="nav-dashboard" onclick="location.href='dashboard.html'">
      <span class="chip c-blue">🏠</span><span class="lbl b">Tableau de bord</span>
    </div>
    <div class="ni${a('suivi-ca.html')}" id="nav-suivi" onclick="location.href='suivi-ca.html'">
      <span class="chip c-indigo">📈</span><span class="lbl">Suivi CA &amp; Résultats</span>
    </div>

    <div class="ni grp" id="nav-kpis" onclick="toggleAlteoreNav('kpis-sub',this)">
      <span class="chip c-orange">🧮</span><span class="lbl">Rentabilité</span><span class="chev" id="chev-kpis"${kpisOpen ? rot : ''}>›</span>
    </div>
    <div class="sub" id="kpis-sub" ${kpisOpen}>
      <div class="si${a('cout-revient.html')}"  id="nav-cout"   onclick="location.href='cout-revient.html'">Coût de revient</div>
      <div class="si${a('marges.html')}"         id="nav-marges" onclick="location.href='marges.html'">Marge brute &amp; nette</div>
      <div class="si${a('panier-moyen.html')}"   id="nav-panier" onclick="location.href='panier-moyen.html'">Panier moyen</div>
    </div>

    <div class="ni grp" id="nav-treso" onclick="toggleAlteoreNav('treso-sub',this)">
      <span class="chip c-teal">💧</span><span class="lbl">Trésorerie</span><span class="chev" id="chev-treso"${tresoOpen ? rot : ''}>›</span>
    </div>
    <div class="sub" id="treso-sub" ${tresoOpen}>
      <div class="si${a('cashflow.html')}" id="nav-cashflow" onclick="location.href='cashflow.html'">Cashflow</div>
      <div class="si${a('dettes.html')}"   id="nav-dettes"   onclick="location.href='dettes.html'">Dettes &amp; Emprunts</div>
    </div>

    <!-- ═══ ③ DÉVELOPPER ═══ -->
    <div class="ns"><span class="step">3</span>Développer</div>

    <div class="ni${a('gestion-stock.html')}" id="nav-stock" onclick="location.href='gestion-stock.html'">
      <span class="chip c-amber">📦</span><span class="lbl">Gestion des stocks</span>
    </div>

    <div class="ni grp" id="nav-fid" onclick="toggleAlteoreNav('fid-nav-sub',this)">
      <span class="chip c-gold">💎</span><span class="lbl b">Fidélisation</span><span class="plan-badge">Max</span><span class="chev fid-chev"${fidOpen ? rot : ''}>›</span>
    </div>
    <div class="sub fid" id="fid-nav-sub" ${fidOpen}>
      <div class="si fid-si" id="fid-si-dashboard" onclick="goFid('dashboard')">Dashboard fidélité</div>
      <div class="si fid-si" id="fid-si-clients"   onclick="goFid('clients')">Clients</div>
      <div class="si fid-si" id="fid-si-carte"     onclick="goFid('carte')">Carte fidélité</div>
      <div class="si fid-si" id="fid-si-points"    onclick="goFid('points')">Points &amp; Récompenses</div>
      <div class="si fid-si" id="fid-si-coupons"   onclick="goFid('coupons')">Coupons &amp; Offres</div>
      <div class="si fid-si" id="fid-si-campagnes" onclick="goFid('campagnes')">Campagnes</div>
    </div>

    <div class="ni${a('scenarios.html')}" id="nav-scenarios" onclick="location.href='scenarios.html'">
      <span class="chip c-blue">🎯</span><span class="lbl">Scénarios "Et si..."</span>
    </div>
    <div class="ni${a('previsions.html')}" id="nav-previsions" onclick="location.href='previsions.html'">
      <span class="chip c-violet">🔮</span><span class="lbl">Prévisions IA</span><span class="plan-badge">Master</span>
    </div>

    <!-- ═══ MON ÉQUIPE ═══ -->
    <div class="ns">Mon équipe</div>
    <div class="ni grp" id="nav-rh" onclick="toggleAlteoreNav('rh-nav-sub',this)">
      <span class="chip c-green">👥</span><span class="lbl b">Module RH</span><span class="plan-badge">Master</span><span class="chev rh-chev"${rhOpen ? rot : ''}>›</span>
    </div>
    <div class="sub rh" id="rh-nav-sub" ${rhOpen}>

      <div class="rh-sub-group">Accueil</div>
      <div class="si rh-si${a('rh-dashboard.html')}" onclick="location.href='rh-dashboard.html'">Dashboard RH</div>

      <div class="rh-sub-group">RH Core</div>
      <div class="si rh-si${a('rh-employes.html')}"  onclick="location.href='rh-employes.html'">Employés &amp; Fiches</div>
      <div class="si rh-si${a('rh-planning.html')}"  onclick="location.href='rh-planning.html'">Planning</div>
      <div class="si rh-si${a('rh-conges.html')}"    onclick="location.href='rh-conges.html'">Congés</div>
      <div class="si rh-si${a('rh-temps.html')}"     onclick="location.href='rh-temps.html'">Temps de travail</div>
      <div class="si rh-si${a('rh-pointages.html')}" onclick="location.href='rh-pointages.html'">Pointages</div>
      <div class="si rh-si${a('rh-emargements.html')}" onclick="location.href='rh-emargements.html'">
        <span style="flex:1">Émargements</span>
        <span class="mini-badge lg">Légal</span>
      </div>

      <div class="rh-sub-group">Rémunération</div>
      <div class="si rh-si${a('rh-paie.html')}" onclick="location.href='rh-paie.html'">Paie &amp; Salaires</div>
      <div class="si rh-si${a('rh-dirigeant.html')}" onclick="location.href='rh-dirigeant.html'">Rémunération dirigeant</div>
      <div class="si rh-si${a('rh-objectifs.html')}" onclick="location.href='rh-objectifs.html'">Objectifs &amp; Primes</div>

      <div class="rh-sub-group">Recrutement</div>
      <div class="si rh-si${a('rh-recrutement.html')}" onclick="location.href='rh-recrutement.html'">Recrutement</div>

      <div class="rh-sub-group">Gestion</div>
      <div class="si rh-si${a('rh-onboarding.html')}"  onclick="location.href='rh-onboarding.html'">Onboarding / Offboarding</div>
      <div class="si rh-si${a('rh-entretiens.html')}"  onclick="location.href='rh-entretiens.html'">Entretiens annuels</div>
      <div class="si rh-si${a('rh-conformite.html')}"  onclick="location.href='rh-conformite.html'">Conformité &amp; Légal</div>
      <div class="si rh-si${a('rh-urgence.html')}" onclick="location.href='rh-urgence.html'">
        <span style="flex:1">Urgence Contrôle</span>
        <span class="mini-badge sos">SOS</span>
      </div>
      <div class="si rh-si${a('rh-contrats.html')}"   onclick="location.href='rh-contrats.html'">Contrats de travail</div>
      <div class="si rh-si${a('rh-modeles.html')}"     onclick="location.href='rh-modeles.html'">Modèles de documents</div>

    </div><!-- /rh-nav-sub -->

    <!-- ═══ MON ASSISTANT IA ═══ -->
    <div class="ns">Mon assistant IA</div>
    <div class="ni lea-ni${a('agent.html') || a('agent-historique.html') || a('agent-upgrade.html')}" id="nav-lea" onclick="location.href='agent.html'">
      <span class="chip c-violet lea-avatar-mini">👩‍💼</span><span class="lbl b">Léa</span>
      <span id="nav-lea-badge" class="lea-badge">Nouveau</span>
    </div>
    <div class="ni${a('bilan.html')}" id="nav-bilan" onclick="location.href='bilan.html'">
      <span class="chip c-violet">🤖</span><span class="lbl">Analyse de Bilan</span><span class="plan-badge">Max</span>
    </div>
    <div class="ni${a('rapport-annuel.html')}" id="nav-rapport" onclick="location.href='rapport-annuel.html'">
      <span class="chip c-violet">📄</span><span class="lbl">Situation intermédiaire</span>
    </div>

  </div><!-- /nav-scroll-area -->

  <div class="nav-footer">
    <div class="foot-row">
      <div class="fbtn${a('tutoriels.html')}" id="nav-tutos" onclick="location.href='tutoriels.html'">🎓 Tutoriels</div>
      <div class="fbtn${a('aide.html')}" id="nav-aide" onclick="location.href='aide.html'">❓ Aide<span id="nav-aide-badge" style="display:none;background:#dc2626;color:white;font-size:10px;font-weight:800;padding:1px 6px;border-radius:20px;margin-left:6px"></span></div>
    </div>
    <!-- Slot admin : rempli dynamiquement si role === 'admin' -->
    <div id="nav-admin-slot"></div>
    <div class="ucard" onclick="location.href='profil.html'" style="cursor:pointer;transition:.15s" title="Mon compte">
      <div class="uav" id="av">A</div>
      <div>
        <div class="un" id="uname">Utilisateur</div>
        <div class="upl" id="uplan">Plan gratuit</div>
      </div>
      <button class="lbtn" onclick="event.stopPropagation();(window.doLogout||window.handleLogout||function(){window._signOut&&window._signOut(window._auth).then(()=>location.href='index.html')})()">⎋</button>
    </div>
    <div class="legal-row">
      <a href="mentions-legales.html" class="legal-a">Mentions</a>
      <a href="cgv.html"              class="legal-a">CGV</a>
      <a href="confidentialite.html"  class="legal-a">Confidentialité</a>
    </div>
  </div>
</nav>`;
  }

  // ════════════════════════════════════════════════
  // CSS INJECTÉ
  // ════════════════════════════════════════════════
  const NAV_CSS = `
<style id="alteore-nav-css">
/* ── BASE ── */
nav#alteore-nav{width:250px;height:100vh;background:linear-gradient(180deg,#0f1f5c,#162366);position:fixed;top:0;left:0;display:flex;flex-direction:column;overflow:hidden;z-index:99;box-sizing:border-box}
nav#alteore-nav .nav-scroll-area{flex:1;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.12) transparent;position:relative;padding-bottom:8px}
nav#alteore-nav .nav-scroll-area::before{content:'';position:absolute;top:-70px;left:50%;transform:translateX(-50%);width:300px;height:190px;background:radial-gradient(closest-side,rgba(0,212,240,.15),transparent);pointer-events:none}
nav#alteore-nav .nav-scroll-area::-webkit-scrollbar{width:4px}
nav#alteore-nav .nav-scroll-area::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:99px}
nav#alteore-nav .logo{display:flex;align-items:center;gap:10px;padding:20px 18px 14px;position:relative}
nav#alteore-nav .logo-t{font-size:17px;font-weight:800;color:#fff;letter-spacing:1px}

/* ── CTA "Saisir mes chiffres" ── */
nav#alteore-nav .nav-cta{display:flex;align-items:center;justify-content:center;gap:8px;margin:2px 12px 8px;padding:11px 12px;border-radius:12px;cursor:pointer;color:#fff;font-size:13px;font-weight:800;letter-spacing:.2px;background:linear-gradient(135deg,#00d4f0 0%,#2456f0 55%,#1a3dce 100%);box-shadow:0 6px 18px rgba(0,180,240,.30),inset 0 1px 0 rgba(255,255,255,.25);transition:transform .15s,box-shadow .15s;user-select:none}
nav#alteore-nav .nav-cta:hover{transform:translateY(-1px);box-shadow:0 9px 24px rgba(0,180,240,.40),inset 0 1px 0 rgba(255,255,255,.25)}
nav#alteore-nav .nav-cta:active{transform:translateY(0)}

/* ── Carte "Bien démarrer" (mode découverte) ── */
nav#alteore-nav .nav-start{margin:0 12px 6px;padding:10px 12px;background:rgba(255,255,255,.06);border:1px solid rgba(0,212,240,.28);border-radius:12px;cursor:pointer;transition:.15s}
nav#alteore-nav .nav-start:hover{background:rgba(255,255,255,.09)}
nav#alteore-nav .nav-start-top{display:flex;justify-content:space-between;align-items:center;font-size:11px;font-weight:700;color:#fff;margin-bottom:7px}
nav#alteore-nav .nav-start-top b{color:#7be9ff;font-size:11.5px}
nav#alteore-nav .nav-start-bar{height:6px;background:rgba(255,255,255,.12);border-radius:99px;overflow:hidden}
nav#alteore-nav .nav-start-bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#00d4f0,#4f7ef8);transition:width .5s}
nav#alteore-nav .nav-start-hint{font-size:10.5px;color:rgba(255,255,255,.55);margin-top:7px;line-height:1.35}

/* ── Sections + pastilles d'étape (mode découverte) ── */
nav#alteore-nav .ns{display:flex;align-items:center;gap:7px;font-size:10px;font-weight:800;color:rgba(255,255,255,.42);letter-spacing:1.2px;text-transform:uppercase;padding:15px 18px 5px}
nav#alteore-nav .ns .step{display:none;width:15px;height:15px;flex-shrink:0;border-radius:50%;align-items:center;justify-content:center;font-size:9px;font-weight:800;color:#fff;letter-spacing:0;background:linear-gradient(135deg,#00d4f0,#1a3dce);box-shadow:0 0 8px rgba(0,212,240,.35)}
nav#alteore-nav.decouverte .ns .step{display:inline-flex}

/* ── Items principaux (pastille + libellé, actif en pilule) ── */
nav#alteore-nav .ni{display:flex;align-items:center;gap:9px;margin:1px 10px;padding:7px 8px;border-radius:10px;color:rgba(255,255,255,.72);font-size:12.5px;font-weight:500;cursor:pointer;transition:background .15s,color .15s;border-left:3px solid transparent}
nav#alteore-nav .ni:hover{color:#fff;background:rgba(255,255,255,.07)}
nav#alteore-nav .ni.on{color:#fff;background:rgba(79,126,248,.22);font-weight:600}
nav#alteore-nav .chip{width:24px;height:24px;flex-shrink:0;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;font-size:12px}
nav#alteore-nav .c-blue{background:rgba(79,126,248,.20)}
nav#alteore-nav .c-indigo{background:rgba(99,102,241,.20)}
nav#alteore-nav .c-teal{background:rgba(20,184,166,.20)}
nav#alteore-nav .c-orange{background:rgba(251,146,60,.20)}
nav#alteore-nav .c-amber{background:rgba(245,158,11,.20)}
nav#alteore-nav .c-gold{background:rgba(251,191,36,.20)}
nav#alteore-nav .c-green{background:rgba(16,185,129,.20)}
nav#alteore-nav .c-violet{background:rgba(167,139,250,.22)}
nav#alteore-nav .lbl{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
nav#alteore-nav .lbl.b{font-weight:700;color:#fff}
nav#alteore-nav .ni:not(.on):not(:hover) .lbl.b{color:rgba(255,255,255,.88)}
nav#alteore-nav .chev{font-size:12px;color:rgba(255,255,255,.35);transition:transform .25s;flex-shrink:0}

/* ── Badges de plan (statiques) + compat verrou ── */
nav#alteore-nav .plan-badge{font-size:9px;font-weight:800;padding:2px 7px;border-radius:20px;flex-shrink:0;background:rgba(255,255,255,.10);color:rgba(255,255,255,.75);border:1px solid rgba(255,255,255,.16)}
nav#alteore-nav .plan-badge.nv{background:rgba(16,185,129,.22);color:#6ee7b7;border-color:rgba(16,185,129,.25)}
nav#alteore-nav .ni:has(.nav-lock-badge) .plan-badge{display:none}
nav#alteore-nav .mini-badge{font-size:8.5px;font-weight:800;padding:1px 6px;border-radius:20px;margin-left:auto;flex-shrink:0}
nav#alteore-nav .mini-badge.lg{background:rgba(59,130,246,.2);color:#93c5fd}
nav#alteore-nav .mini-badge.sos{background:rgba(239,68,68,.2);color:#f87171}

/* ── Sous-menus ── */
nav#alteore-nav .sub{overflow:hidden;max-height:0;transition:max-height .45s ease}
nav#alteore-nav .sub.open{max-height:4000px}
nav#alteore-nav .si{display:flex;align-items:center;gap:8px;margin:0 10px;padding:6px 10px 6px 38px;border-radius:8px;font-size:12px;color:rgba(255,255,255,.50);cursor:pointer;position:relative;transition:background .15s,color .15s;border-left:3px solid transparent}
nav#alteore-nav .si::before{content:'';position:absolute;left:22px;top:50%;transform:translateY(-50%);width:5px;height:5px;border-radius:50%;background:rgba(255,255,255,.25)}
nav#alteore-nav .si:hover{color:#fff;background:rgba(255,255,255,.05)}
nav#alteore-nav .si.on{color:#fff;background:rgba(79,126,248,.18)}
nav#alteore-nav .si.on::before{background:#4f7ef8}
nav#alteore-nav .si .dot{display:none}
nav#alteore-nav .sub.fid .si.on{background:rgba(251,191,36,.16)}
nav#alteore-nav .sub.fid .si.on::before{background:#fbbf24}
nav#alteore-nav .sub.rh .si.on{background:rgba(16,185,129,.17)}
nav#alteore-nav .sub.rh .si.on::before{background:#10b981}
nav#alteore-nav .rh-sub-group{font-size:9px;font-weight:800;color:rgba(52,211,153,.5);letter-spacing:1px;text-transform:uppercase;padding:9px 18px 3px 38px;margin-top:2px}

/* ── Footer ── */
nav#alteore-nav .nav-footer{flex-shrink:0;padding:10px 12px 8px;border-top:1px solid rgba(255,255,255,.09)}
nav#alteore-nav .foot-row{display:flex;gap:8px;margin-bottom:8px}
nav#alteore-nav .fbtn{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:8px 6px;background:rgba(255,255,255,.06);border-radius:10px;font-size:11.5px;font-weight:600;color:rgba(255,255,255,.65);cursor:pointer;transition:.15s;white-space:nowrap}
nav#alteore-nav .fbtn:hover{background:rgba(255,255,255,.11);color:#fff}
nav#alteore-nav .fbtn.on{background:rgba(79,126,248,.22);color:#fff}
nav#alteore-nav .ucard{display:flex;align-items:center;gap:8px;padding:8px;background:rgba(255,255,255,.07);border-radius:10px}
nav#alteore-nav .ucard:hover{background:rgba(255,255,255,.11)}
nav#alteore-nav .uav{width:29px;height:29px;background:linear-gradient(135deg,#4f7ef8,#6366f1);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0}
nav#alteore-nav .un{font-size:11.5px;font-weight:600;color:#fff}
nav#alteore-nav .upl{font-size:10px;color:rgba(255,255,255,.3)}
nav#alteore-nav .lbtn{margin-left:auto;background:none;border:none;color:rgba(255,255,255,.3);cursor:pointer;font-size:13px}
nav#alteore-nav .legal-row{display:flex;justify-content:center;gap:14px;padding:9px 0 2px}
nav#alteore-nav .legal-a{font-size:10px;color:rgba(255,255,255,.22);text-decoration:none;transition:color .2s}
nav#alteore-nav .legal-a:hover{color:rgba(255,255,255,.6)}

/* ── LÉA — badge dynamique (classes posées par applyLeaNavItem) ── */
nav#alteore-nav .ni.lea-ni{position:relative}
nav#alteore-nav .ni.lea-ni:hover{background:rgba(124,58,237,.14)}
nav#alteore-nav .ni.lea-ni.on{background:rgba(124,58,237,.22)}
nav#alteore-nav .lea-avatar-mini{box-shadow:0 0 0 1px rgba(255,255,255,.12),0 0 12px rgba(167,139,250,.3)}
nav#alteore-nav .lea-badge{font-size:9px;font-weight:700;letter-spacing:.3px;padding:2px 7px;border-radius:20px;flex-shrink:0;background:linear-gradient(135deg,rgba(167,139,250,.3),rgba(124,58,237,.3));color:#ddd6fe;border:1px solid rgba(167,139,250,.3)}
nav#alteore-nav .lea-badge.active{background:linear-gradient(135deg,rgba(16,185,129,.3),rgba(5,150,105,.3));color:#6ee7b7;border-color:rgba(16,185,129,.3)}
nav#alteore-nav .lea-badge.degraded{background:rgba(245,158,11,.2);color:#fbbf24;border-color:rgba(245,158,11,.3)}
nav#alteore-nav .lea-badge.trial{background:rgba(96,165,250,.2);color:#93c5fd;border-color:rgba(96,165,250,.3)}
nav#alteore-nav .lea-badge.admin{background:linear-gradient(135deg,rgba(239,68,68,.25),rgba(220,38,38,.25));color:#fca5a5;border-color:rgba(239,68,68,.3)}
nav#alteore-nav .lea-badge.beta{background:linear-gradient(135deg,rgba(99,102,241,.3),rgba(79,70,229,.3));color:#c7d2fe;border-color:rgba(99,102,241,.35)}
@keyframes leaPulse{0%,100%{box-shadow:0 0 0 1px rgba(255,255,255,.12),0 0 12px rgba(167,139,250,.3)}50%{box-shadow:0 0 0 1px rgba(255,255,255,.18),0 0 18px rgba(167,139,250,.55)}}
nav#alteore-nav .ni.lea-ni .lea-avatar-mini{animation:leaPulse 3s ease-in-out infinite}

/* ── THÈME VERT GLOBAL quand RH ouvert ── */
nav#alteore-nav.rh-mode{background:linear-gradient(180deg,#052e16 0%,#064e23 50%,#065f2c 100%);transition:background .45s ease}
nav#alteore-nav.rh-mode .logo-t{background:linear-gradient(135deg,#34d399,#6ee7b7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
nav#alteore-nav.rh-mode .nav-scroll-area::before{background:radial-gradient(closest-side,rgba(52,211,153,.14),transparent)}
nav#alteore-nav.rh-mode .nav-cta{background:linear-gradient(135deg,#10b981 0%,#059669 60%,#047857 100%);box-shadow:0 6px 18px rgba(16,185,129,.3),inset 0 1px 0 rgba(255,255,255,.25)}
nav#alteore-nav.rh-mode .ns{color:rgba(52,211,153,.45)}
nav#alteore-nav.rh-mode .ni:hover{background:rgba(52,211,153,.09)}
nav#alteore-nav.rh-mode .ni.on{background:rgba(52,211,153,.18)}
nav#alteore-nav.rh-mode .si:hover{background:rgba(52,211,153,.07)}
nav#alteore-nav.rh-mode .si.on{background:rgba(52,211,153,.17)}
nav#alteore-nav.rh-mode .si.on::before{background:#34d399}
nav#alteore-nav.rh-mode .rh-sub-group{color:rgba(52,211,153,.6)}
nav#alteore-nav.rh-mode .nav-footer{border-top-color:rgba(52,211,153,.15)}
nav#alteore-nav.rh-mode .ucard{background:rgba(52,211,153,.1)}
nav#alteore-nav.rh-mode .uav{background:linear-gradient(135deg,#10b981,#34d399)}
nav#alteore-nav.rh-mode .chev{color:rgba(52,211,153,.4)}
nav#alteore-nav.rh-mode .nav-scroll-area::-webkit-scrollbar-thumb{background:rgba(52,211,153,.3)}

/* ── THÈME DORÉ quand FIDÉLISATION ouverte ── */
nav#alteore-nav.fid-mode{background:linear-gradient(180deg,#451a03 0%,#78350f 50%,#92400e 100%);transition:background .45s ease}
nav#alteore-nav.fid-mode .logo-t{background:linear-gradient(135deg,#fbbf24,#fde68a);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
nav#alteore-nav.fid-mode .nav-scroll-area::before{background:radial-gradient(closest-side,rgba(251,191,36,.14),transparent)}
nav#alteore-nav.fid-mode .nav-cta{background:linear-gradient(135deg,#fbbf24 0%,#f59e0b 60%,#d97706 100%);box-shadow:0 6px 18px rgba(245,158,11,.3),inset 0 1px 0 rgba(255,255,255,.3)}
nav#alteore-nav.fid-mode .ns{color:rgba(251,191,36,.42)}
nav#alteore-nav.fid-mode .ni:hover{background:rgba(251,191,36,.09)}
nav#alteore-nav.fid-mode .ni.on{background:rgba(251,191,36,.16)}
nav#alteore-nav.fid-mode .si:hover{background:rgba(251,191,36,.07)}
nav#alteore-nav.fid-mode .si.on{background:rgba(251,191,36,.14)}
nav#alteore-nav.fid-mode .si.on::before{background:#fbbf24}
nav#alteore-nav.fid-mode .nav-footer{border-top-color:rgba(251,191,36,.12)}
nav#alteore-nav.fid-mode .ucard{background:rgba(251,191,36,.08)}
nav#alteore-nav.fid-mode .uav{background:linear-gradient(135deg,#f59e0b,#fbbf24)}
nav#alteore-nav.fid-mode .chev{color:rgba(251,191,36,.4)}
nav#alteore-nav.fid-mode .nav-scroll-area::-webkit-scrollbar-thumb{background:rgba(251,191,36,.25)}

/* ── A11Y ── */
nav#alteore-nav .nav-cta:focus-visible,nav#alteore-nav .ni:focus-visible,nav#alteore-nav .si:focus-visible{outline:2px solid #7be9ff;outline-offset:2px}
@media (prefers-reduced-motion:reduce){nav#alteore-nav *,nav#alteore-nav *::before{transition:none!important;animation:none!important}}

/* ── HAMBURGER MOBILE ── */
.alteore-hamburger{display:none;position:fixed;top:14px;left:14px;z-index:1001;width:44px;height:44px;background:#0f1f5c;border:none;border-radius:12px;cursor:pointer;flex-direction:column;align-items:center;justify-content:center;gap:5px;box-shadow:0 4px 16px rgba(15,31,92,.45);-webkit-tap-highlight-color:transparent}
.alteore-hamburger span{display:block;width:20px;height:2.5px;background:#fff;border-radius:2px;transition:all .25s ease}
.alteore-hamburger.open span:nth-child(1){transform:translateY(7.5px) rotate(45deg)}
.alteore-hamburger.open span:nth-child(2){opacity:0;transform:scaleX(0)}
.alteore-hamburger.open span:nth-child(3){transform:translateY(-7.5px) rotate(-45deg)}
.alteore-nav-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000}
.alteore-nav-overlay.show{display:block}
/* ═════════════════════════════════════════════════════════
   RESPONSIVE GLOBAL — v1 (19/04/2026)
   Breakpoint 900px : laptop 13" réduit → hamburger
   Breakpoint 600px : mobile / tablette portrait
   Classes utilitaires : .col-hide-md (<900), .col-hide-sm (<600)
   ═════════════════════════════════════════════════════════ */
@media(max-width:900px){
  /* ── Sidebar en drawer ── */
  .alteore-hamburger{display:flex!important}
  nav#alteore-nav{position:fixed!important;top:0!important;left:0!important;height:100vh!important;width:min(280px,84vw)!important;z-index:1001!important;transform:translateX(-105%)!important;transition:transform .3s cubic-bezier(.4,0,.2,1)!important;overflow-y:auto!important;margin:0!important}
  nav#alteore-nav.open{transform:translateX(0)!important;box-shadow:8px 0 32px rgba(0,0,0,.3)!important}

  /* ── Main récupère toute la largeur ── */
  .main,main,div.main{margin-left:0!important;width:100%!important;max-width:100vw!important;overflow-x:hidden}
  html,body{overflow-x:hidden;max-width:100vw}

  /* ── Topbar wrap + espace pour le hamburger ── */
  .topbar{flex-wrap:wrap!important;gap:10px!important;padding:14px 14px 14px 64px!important;min-height:60px;align-items:center}
  .topbar-left{min-width:0;flex:1 1 auto!important}
  .topbar-left h1,.topbar h1{font-size:16px!important;margin:0;line-height:1.2}
  .topbar-left p,.topbar-left .subtitle{font-size:11px!important}
  .topbar-right{flex-wrap:wrap!important;gap:6px!important;justify-content:flex-start!important}
  .topbar-right .btn,.topbar .btn{font-size:12px!important;padding:8px 10px!important;white-space:nowrap}

  /* ── Content padding ── */
  .content{padding:14px 12px!important}

  /* ── Grids KPI : 2 cols ── */
  .summary-grid,.kpi-grid,.kpi-grid-4,.kpi-grid-5,.kpi-grid-3,.hero-kpis,.fact-kpis,.fiche-kpis,.fiche-stats-grid,.comp-kpi-grid,.score-kpis,.seuil-kpis,.mk-kpis,.sum-cards{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:10px!important}

  /* ── Grids sections 2-cols → 1 col ── */
  .sections-grid,.main-grid,.grid-2,.charts-grid,.charts-grid-2,.charts-grid-3,.form-grid-2,.widget-row,.prev-grid,.cashflow-grid,.tva-result,.seuil-compare,#widgets-row{grid-template-columns:1fr!important;gap:12px!important}

  /* ── Tables : scroll horizontal ── */
  .table-card,.table-wrap,.ex-table-wrap,.card-table-wrap,.prod-list-wrap,.tbl-wrap{overflow-x:auto!important;-webkit-overflow-scrolling:touch}
  .table-card table,.table-wrap table{min-width:480px}
  /* Card générique qui contient un tableau → scroll horizontal (supporté Chrome 105+, Safari 15.4+, Firefox 121+) */
  .card:has(>table),.card:has(>.table-wrap),.block:has(>table),section.card:has(table){overflow-x:auto!important;-webkit-overflow-scrolling:touch}

  /* ── Utility : masquer colonnes non critiques ── */
  .col-hide-md{display:none!important}
}

@media(max-width:600px){
  /* ── KPIs en 1 col ── */
  .summary-grid,.kpi-grid,.kpi-grid-4,.kpi-grid-5,.kpi-grid-3,.hero-kpis,.fact-kpis,.fiche-kpis,.fiche-stats-grid,.comp-kpi-grid,.score-kpis,.seuil-kpis,.mk-kpis,.sum-cards{grid-template-columns:1fr!important}

  /* ── Topbar encore plus compact ── */
  .topbar{padding:12px 10px 12px 60px!important}
  .topbar-left h1,.topbar h1{font-size:14px!important}
  .topbar-right .btn,.topbar .btn{font-size:11px!important;padding:7px 9px!important}

  .content{padding:10px 8px!important}

  /* ── Tailles réduites ── */
  .kpi-value,.kpi-card .kpi-value{font-size:18px!important}
  .kpi-label,.kpi-card .kpi-label{font-size:10px!important}
  table{font-size:12px!important}

  /* ── Utility : masquer colonnes non critiques petit écran ── */
  .col-hide-sm{display:none!important}
}
</style>`;

  // ════════════════════════════════════════════════
  // INJECTION DOM
  // ════════════════════════════════════════════════
  function injectNav() {
    if (document.getElementById('alteore-nav')) return;

    if (!document.getElementById('alteore-nav-css')) {
      document.head.insertAdjacentHTML('beforeend', NAV_CSS);
    }

    // ── CSS overrides en FIN de <head> pour battre les <style> inline des pages ──
    // Utilise appendChild (pas insertAdjacentHTML) pour garantir l'ordre de cascade :
    // parsé APRÈS tout ce qui existait déjà dans <head>. Les sélecteurs du fichier
    // utilisent `html body` pour une spécificité de 12 (vs 10 pour une classe seule).
    if (!document.getElementById('alteore-responsive-overrides')) {
      var ovLink = document.createElement('link');
      ovLink.id = 'alteore-responsive-overrides';
      ovLink.rel = 'stylesheet';
      ovLink.href = 'responsive-overrides.css';
      document.head.appendChild(ovLink);
    }

    // Hamburger
    if (!document.querySelector('.alteore-hamburger')) {
      document.body.insertAdjacentHTML('afterbegin',
        `<button class="alteore-hamburger" id="alteore-hamburger" onclick="alteoreToggleSidebar()" aria-label="Menu">
           <span></span><span></span><span></span>
         </button>
         <div class="alteore-nav-overlay" id="alteoreNavOverlay" onclick="alteoreCloseSidebar()"></div>`
      );
    }

    // Supprimer anciens éléments des pages inline
    const oldNav = document.querySelector('nav:not(#alteore-nav), aside.sidebar');
    if (oldNav) oldNav.remove();
    const oldHamburger = document.querySelector('.hamburger');
    if (oldHamburger) oldHamburger.remove();
    const oldOverlay = document.querySelector('.nav-overlay');
    if (oldOverlay) oldOverlay.remove();

    // goFid doit être défini AVANT l'injection du HTML (les onclick l'appellent immédiatement)
    window.goFid = function(tab){
      // Mettre à jour surbrillance sidebar
      document.querySelectorAll('[id^="fid-si-"]').forEach(el => el.classList.remove('on'));
      const activeEl = document.getElementById('fid-si-' + tab);
      if(activeEl) activeEl.classList.add('on');
      const onFid = location.pathname.endsWith('fidelisation.html');
      if(onFid){
        if(window.switchTab) window.switchTab(tab, null);
      } else {
        location.href = 'fidelisation.html?tab=' + tab;
      }
    };

    // Surbrillance initiale selon ?tab= dans l'URL
    (function(){
      if(PAGE === 'fidelisation.html'){
        const urlTab = new URLSearchParams(location.search).get('tab') || 'dashboard';
        setTimeout(()=>{
          document.querySelectorAll('[id^="fid-si-"]').forEach(el => el.classList.remove('on'));
          const el = document.getElementById('fid-si-' + urlTab);
          if(el) el.classList.add('on');
        }, 50);
      }
    })();

    document.body.insertAdjacentHTML('afterbegin', buildNavHTML());

    // Marge main
    const mainEl = document.querySelector('main, .main, div.main');
    if (mainEl && !mainEl.style.marginLeft) mainEl.style.marginLeft = '250px';
  }

  // ════════════════════════════════════════════════
  // TOGGLE SOUS-MENUS
  // ════════════════════════════════════════════════
  window.toggleAlteoreNav = function (subId, el) {
    var sub = document.getElementById(subId);
    if (!sub) return;
    var nav = document.getElementById('alteore-nav');
    var isOpen = sub.style.maxHeight && sub.style.maxHeight !== '0px';

    // Fermer tous
    document.querySelectorAll('nav#alteore-nav .sub').forEach(function (s) {
      s.style.maxHeight = '0px';
    });

    if (!isOpen) {
      sub.style.maxHeight = '4000px';
      if (nav) {
        if (subId === 'rh-nav-sub') nav.classList.add('rh-mode');
        else nav.classList.remove('rh-mode');
      }
    } else {
      if (nav && subId === 'rh-nav-sub') nav.classList.remove('rh-mode');
    }
  };

  window.toggleNav    = window.toggleAlteoreNav;
  window.toggleFidNav = function (el) { window.toggleAlteoreNav('fid-nav-sub', el); };

  // ════════════════════════════════════════════════
  // HAMBURGER MOBILE
  // ════════════════════════════════════════════════
  window.alteoreToggleSidebar = function () {
    var nav     = document.getElementById('alteore-nav');
    var overlay = document.getElementById('alteoreNavOverlay');
    var btn     = document.getElementById('alteore-hamburger');
    if (nav)     nav.classList.toggle('open');
    if (overlay) overlay.classList.toggle('show');
    if (btn)     btn.classList.toggle('open');
  };
  window.alteoreCloseSidebar = function () {
    var nav     = document.getElementById('alteore-nav');
    var overlay = document.getElementById('alteoreNavOverlay');
    var btn     = document.getElementById('alteore-hamburger');
    if (nav)     nav.classList.remove('open');
    if (overlay) overlay.classList.remove('show');
    if (btn)     btn.classList.remove('open');
  };
  window.toggleSidebar = window.alteoreToggleSidebar;
  window.closeSidebar  = window.alteoreCloseSidebar;

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
    modal.addEventListener('click', function (e) {
      if (e.target === modal) modal.style.display = 'none';
    });
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
      fidelisation: { icon: '💎', title: 'Fidélisation — Plan Max requis',       desc: 'La gestion des clients, cartes de fidélité, coupons et campagnes SMS est disponible dès le plan <strong>Max (99€/mois)</strong> ou <strong>Master (169€/mois)</strong>.', cta: '⭐ Passer au plan Max' },
      stock:        { icon: '📦', title: 'Gestion des stocks — Plan Pro requis',  desc: 'La gestion des stocks est disponible dès le plan <strong>Pro (69€/mois)</strong>.', cta: '⭐ Passer au plan Max' },
      bilan:        { icon: '🤖', title: 'Analyse de Bilan IA — Plan Max requis', desc: 'L\'analyse de bilan comptable par intelligence artificielle est disponible dès le plan <strong>Max (99€/mois)</strong> ou <strong>Master (169€/mois)</strong>.', cta: '⭐ Passer au plan Max' },
      rapport:      { icon: '📄', title: 'Situation intermédiaire IA — Plan Pro requis',  desc: 'La situation intermédiaire IA est disponible dès le plan <strong>Pro (69€/mois)</strong>.', cta: '⭐ Passer au plan Pro' },
      import:       { icon: '📥', title: 'Import/Export — Plan Pro requis',        desc: "L'import et l'export de données est disponible dès le plan <strong>Pro (69€/mois)</strong>.", cta: '⭐ Passer au plan Pro' },
      rh:           { icon: '👥', title: 'Module RH — Plan Master requis',         desc: 'La gestion complète des ressources humaines (employés, planning, congés, paie, rémunération dirigeant…) est disponible avec le plan <strong>Master (169€/mois)</strong>.', cta: '⭐ Passer au plan Master' },
      scenarios:    { icon: '🎯', title: 'Scénarios & IA avancée — Plan Max requis', desc: 'Les scénarios \"Et si...\", l\'assistant vocal IA et l\'analyse IA du stock sont disponibles dès le plan <strong>Max (99€/mois)</strong>.', cta: '⭐ Passer au plan Max' },
      previsions:   { icon: '🔮', title: 'Prévisions IA — Plan Master requis',    desc: 'Les prévisions de demande par intelligence artificielle (météo, fériés, événements, historique de ventes) sont disponibles avec le plan <strong>Master (169€/mois)</strong>.', cta: '⭐ Passer au plan Master' },
      core:         { icon: '📊', title: 'Fonctionnalité Premium',                 desc: 'Cette fonctionnalité est disponible dès le plan <strong>Pro (69€/mois)</strong>.', cta: '⭐ Voir les plans' },
      trial_expired:{ icon: '⏰', title: 'Votre essai gratuit a expiré',           desc: 'Votre période d\'essai de 15 jours est terminée.<br><br>Souscrivez à un abonnement pour <strong>continuer à utiliser Alteore</strong> et conserver toutes vos données.<br><br>⚠️ <strong>Sans abonnement, vos données seront définitivement supprimées 15 jours après l\'expiration.</strong>', cta: '⭐ Choisir mon plan →' },
      deleted:      { icon: '🗑', title: 'Vos données ont été supprimées',          desc: 'Votre essai a expiré il y a plus de 15 jours. <strong>Toutes vos données ont été définitivement supprimées</strong> conformément à nos conditions.<br><br>Pour utiliser Alteore, vous pouvez créer un nouveau compte et souscrire à un abonnement.', cta: 'Créer un nouveau compte →' },
      promo_expired:{ icon: '🎁', title: 'Votre offre découverte a expiré',        desc: 'Votre offre gratuite de 2 mois est terminée.<br><br><strong>Bonne nouvelle : toutes vos données sont intactes !</strong> Choisissez un plan pour reprendre là où vous en étiez.<br><br>Vous ne perdrez rien.', cta: '⭐ Choisir mon plan →' }
    };
    const cfg = configs[upgrade] || configs.core;
    document.getElementById('nav-modal-icon').textContent  = cfg.icon;
    document.getElementById('nav-modal-title').textContent = cfg.title;
    document.getElementById('nav-modal-desc').innerHTML    = cfg.desc;
    document.getElementById('nav-modal-cta').textContent   = cfg.cta;
    document.getElementById('nav-modal-cta').onclick = function () {
      if (upgrade === 'trial_expired' || upgrade === 'promo_expired') location.href = 'pricing.html';
      else if (upgrade === 'deleted') location.href = 'index.html';
      else location.href = 'profil.html?tab=abonnement&upgrade=' + upgrade;
    };
    document.getElementById('nav-upgrade-modal').style.display = 'flex';
  }
  window._showUpgradeModal = showUpgradeModal;

  // ════════════════════════════════════════════════
  // VERROUILLAGE PAR PLAN
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
    el.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showUpgradeModal(upgrade);
    }, true);
    const subMap = { 'nav-fid': 'fid-nav-sub', 'nav-rh': 'rh-nav-sub' };
    if (subMap[id]) {
      const s = document.getElementById(subMap[id]);
      if (s) s.style.display = 'none';
    }
  }

  function applyNavPlan(plan) {
    window._userPlan = plan;
    const upl = document.getElementById('uplan');
    if (upl) upl.textContent = PLAN_NAMES[plan] || plan;

    // ── BYPASS ADMIN : si role=admin, on ne lock aucun menu (accès à tout) ──
    const isAdmin = window._isAdmin === true;

    if (!isAdmin && !CAN_FIDELISATION.includes(plan)) lockNavItem('nav-fid',    'Max+',   'fidelisation');
    if (!isAdmin && !CAN_STOCK.includes(plan))        lockNavItem('nav-stock',  'Pro+',   'stock');
    if (!isAdmin && !CAN_IMPORT.includes(plan))       lockNavItem('nav-import', 'Pro+',   'import');
    if (!isAdmin && !CAN_BILAN.includes(plan))        lockNavItem('nav-bilan',  'Max+',   'bilan');
    if (!isAdmin && !CAN_RAPPORT.includes(plan))      lockNavItem('nav-rapport','Pro+',   'rapport');
    if (!isAdmin && !CAN_RH.includes(plan))           lockNavItem('nav-rh',     'Master', 'rh');
    if (!isAdmin && !CAN_SCENARIOS.includes(plan))    lockNavItem('nav-scenarios','Max+', 'scenarios');
    if (!isAdmin && !CAN_PREVISIONS.includes(plan))   lockNavItem('nav-previsions','Master', 'previsions');

    // ── LÉA — gestion visibilité + badge dynamique selon statut ──
    applyLeaNavItem(plan);

    const mainEl = document.querySelector('main, .main');
    if (mainEl) mainEl.style.visibility = 'visible';
  }

  // Met à jour l'item "Léa" de la sidebar (section "Mon assistant IA") :
  //  - Cache l'item si le plan ne permet pas l'accès (free, trial_expired, past_due, etc.)
  //  - Sinon affiche un badge adapté au statut
  //  - Ordre de priorité : Admin > Beta > Actif > Inclus (trial) > Veille (dégradé) > Nouveau
  function applyLeaNavItem(plan) {
    var navItem = document.getElementById('nav-lea');
    var badge   = document.getElementById('nav-lea-badge');
    if (!navItem || !badge) return;

    var isAdmin      = window._isAdmin === true;
    var isBetaTester = window._isBetaTester === true;
    var agentEnabled = window._agentEnabled === true;
    var agentDegraded = window._agentDegradedMode === true;
    var canSee = isAdmin || isBetaTester || CAN_AGENT_UPGRADE.includes(plan);

    if (!canSee) {
      navItem.style.display = 'none';
      return;
    }

    navItem.style.display = '';
    badge.classList.remove('active', 'degraded', 'trial', 'admin', 'beta');

    if (isAdmin) {
      badge.textContent = 'Admin';
      badge.classList.add('admin');
    } else if (isBetaTester) {
      badge.textContent = 'Beta';
      badge.classList.add('beta');
    } else if (agentEnabled) {
      badge.textContent = 'Actif';
      badge.classList.add('active');
    } else if (plan === 'trial') {
      badge.textContent = 'Inclus';
      badge.classList.add('trial');
    } else if (agentDegraded) {
      badge.textContent = '💤 Veille';
      badge.classList.add('degraded');
    } else {
      badge.textContent = 'Nouveau';
    }
  }

  function checkPageAccess(plan) {
    // ── BYPASS ADMIN : role=admin → accès complet à tout, aucune restriction ──
    if (window._isAdmin === true) return true;

    // ── Plan free / past_due / trial_expired → redirection (pas de plan gratuit) ──
    const BLOCKED_PLANS = ['free', 'past_due', 'trial_expired', 'deleted', 'promo_expired'];
    const ALLOWED_PAGES_FREE = ['profil.html', 'aide.html', 'tutoriels.html'];
    if (BLOCKED_PLANS.includes(plan) && !ALLOWED_PAGES_FREE.includes(PAGE)) {
      var upgradeType = (plan === 'trial_expired' || plan === 'deleted') ? plan : (plan === 'promo_expired' ? 'promo_expired' : 'core');
      location.href = 'profil.html?tab=abonnement&upgrade=' + upgradeType;
      return false;
    }

    if (PAGE === 'gestion-stock.html'  && !CAN_STOCK.includes(plan))        { showUpgradeModal('stock');        return false; }
    if (PAGE === 'fidelisation.html'   && !CAN_FIDELISATION.includes(plan)) { showUpgradeModal('fidelisation'); return false; }
    if (PAGE === 'import.html'         && !CAN_IMPORT.includes(plan))       { showUpgradeModal('import');       return false; }
    if (PAGE === 'bilan.html'          && !CAN_BILAN.includes(plan))        { showUpgradeModal('bilan');        return false; }
    if (PAGE === 'rapport-annuel.html' && !CAN_RAPPORT.includes(plan))      { showUpgradeModal('rapport');      return false; }
    if (RH_PAGES.includes(PAGE)        && !CAN_RH.includes(plan))           { showUpgradeModal('rh');           return false; }
    if (PAGE === 'scenarios.html'       && !CAN_SCENARIOS.includes(plan))     { showUpgradeModal('scenarios');    return false; }
    if (PAGE === 'previsions.html'     && !CAN_PREVISIONS.includes(plan))    { showUpgradeModal('previsions');   return false; }

    // ── AGENT LÉA ──
    // agent.html / agent-historique.html : trial OU agentEnabled OU agentDegradedMode OU betaTester (admin déjà bypass plus haut)
    if (AGENT_PAGES.includes(PAGE)) {
      var hasTrial     = plan === 'trial' || plan === 'dev';
      var hasAddon     = window._agentEnabled === true;
      var hasDegraded  = window._agentDegradedMode === true;
      var isBetaTester = window._isBetaTester === true;
      if (!hasTrial && !hasAddon && !hasDegraded && !isBetaTester) {
        if (CAN_AGENT_UPGRADE.includes(plan)) {
          location.href = 'agent-upgrade.html';
        } else {
          location.href = 'profil.html?tab=abonnement&upgrade=core';
        }
        return false;
      }
    }

    // agent-upgrade.html : nécessite un plan payant
    if (PAGE === 'agent-upgrade.html' && !CAN_AGENT_UPGRADE.includes(plan)) {
      location.href = 'profil.html?tab=abonnement&upgrade=core';
      return false;
    }

    const corePages = ['dashboard.html','pilotage.html','marges.html','cout-revient.html','panier-moyen.html','dettes.html','suivi-ca.html','cashflow.html','banque.html','bank-validation.html'];
    if (corePages.includes(PAGE) && !CAN_CORE.includes(plan)) { showUpgradeModal('core'); return false; }
    return true;
  }

  // ════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════
  const mainEl = document.querySelector('main, .main');
  if (mainEl && !window._firebaseReady) mainEl.style.visibility = 'hidden';

  // Failsafe 2s — ne jamais bloquer la page
  setTimeout(function () { if (mainEl) mainEl.style.visibility = 'visible'; }, 2000);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectNav);
  } else {
    injectNav();
  }

  function waitForFirebase(cb, tries) {
    tries = tries || 0;
    if (window._uid && window._getDoc && window._db && window._doc) {
      cb();
    } else if (tries < 30) {
      setTimeout(function () { waitForFirebase(cb, tries + 1); }, 100);
    } else {
      if (mainEl) mainEl.style.visibility = 'visible';
      applyNavPlan('dev');
    }
  }

  waitForFirebase(async function () {
    try {
      const snap = await window._getDoc(window._doc(window._db, 'users', window._uid));
      let plan = snap.exists() ? (snap.data().plan || 'free') : 'free';

      // ── Redirection onboarding si pas complété (tous les plans, payés inclus) ──
      if (snap.exists() && snap.data().isOnboarded === false && PAGE !== 'profil.html' && PAGE !== 'aide.html' && PAGE !== 'tutoriels.html') {
        window.location.href = 'bienvenue.html';
        return;
      }

      // ── Vérifier expiration du trial (15 jours) ──
      if (plan === 'trial' && snap.exists()) {
        var d = snap.data();
        var trialEnd = d.trialEnd;
        // Vérifier aussi si un abonnement Stripe est actif (= le user a souscrit)
        var hasStripe = d.stripeSubscriptionId && d.subscriptionStatus === 'trialing';
        if (trialEnd && !hasStripe) {
          var endDate = new Date(trialEnd);
          if (!isNaN(endDate.getTime()) && endDate < new Date()) {
            plan = 'trial_expired';
          }
        }
      }

      // ── Vérifier expiration de la promo ──
      if (plan === 'master' && snap.exists()) {
        var dp = snap.data();
        var promoEnd = dp.promoEnd;
        var hasStripePlan = dp.stripeSubscriptionId && ['active', 'trialing'].includes(dp.subscriptionStatus);
        if (promoEnd && !hasStripePlan) {
          var promoEndDate = new Date(promoEnd);
          if (!isNaN(promoEndDate.getTime())) {
            if (promoEndDate < new Date()) {
              plan = 'promo_expired';
            } else {
              // Promo active → injecter un bandeau avec les jours restants
              var now = new Date(); now.setHours(12,0,0,0); promoEndDate.setHours(12,0,0,0);
              var promoDaysLeft = Math.max(0, Math.round((promoEndDate - now) / (1000*60*60*24)));
              injectPromoBanner(promoDaysLeft);
            }
          }
        }
      }
      const user = window._auth && window._auth.currentUser;
      if (user) {
        const n  = user.displayName || user.email?.split('@')[0] || '';
        const av = document.getElementById('av');
        const un = document.getElementById('uname');
        if (av) av.textContent = n[0]?.toUpperCase() || 'A';
        if (un) un.textContent = n;
      }

      // ── AGENT LÉA (Wave 1+) : exposer les flags sur window ──
      // agentEnabled : true si l'addon Léa est actif (plan payant + subscription_item Léa)
      // agentDegradedMode : true si post-trial sans addon (accès lecture seule aux briefings hebdo)
      // isAdmin : role === 'admin' dans users/{uid} → bypass total, accès complet à TOUT
      // isBetaTester : betaTester === true → accès Léa en bypass Stripe (pour testeurs)
      // Disponibles aussi pendant le trial (plan==='trial' → tous les droits sans flag)
      if (snap.exists()) {
        const ud = snap.data();
        window._agentEnabled      = ud.agentEnabled === true;
        window._agentDegradedMode = ud.agentDegradedMode === true;
        window._agentAddonStatus  = ud.agentAddonStatus || null;
        window._isAdmin           = ud.role === 'admin';
        window._isBetaTester      = ud.betaTester === true;
      } else {
        window._agentEnabled      = false;
        window._agentDegradedMode = false;
        window._agentAddonStatus  = null;
        window._isAdmin           = false;
        window._isBetaTester      = false;
      }

      if (!checkPageAccess(plan)) { applyNavPlan(plan); return; }
      applyNavPlan(plan);
      handleProfilParams();
      initNavExtras(snap).catch(function(){});

      // ── BADGE TICKETS NON LUS — best-effort, silencieux ──
      // Vérifie si le client a des réponses non lues sur ses tickets.
      // Ne bloque jamais le chargement de la nav.
      (async function() {
        try {
          const u = window._auth && window._auth.currentUser;
          if (!u) return;
          const tok = await u.getIdToken();
          const r = await fetch('/api/get-my-tickets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok }
          });
          if (!r.ok) return;
          const d = await r.json();
          const unread = (d.tickets || []).filter(function(t) {
            return !t.clientRead && t.replies && t.replies.some(function(rep){ return rep.from !== 'client'; });
          }).length;
          const badge = document.getElementById('nav-aide-badge');
          if (badge && unread > 0) {
            badge.textContent = unread;
            badge.style.display = 'inline-block';
          }
        } catch(e) { /* silencieux */ }
      })();

      // ── ANNÉES PILOTAGE SUPPLÉMENTAIRES — lecture + patch nav ──
      // Fusionne PIL_YEARS de base avec les années ajoutées par l'user (Firestore users/{uid}.pilotageYears).
      // Reconstruit uniquement le contenu des liens d'années dans #pil-sub (safe, ne touche pas au reste).
      (function() {
        try {
          var extra = (snap.exists() && snap.data().pilotageYears) ? snap.data().pilotageYears : [];
          if (!Array.isArray(extra)) extra = [];
          // Fusionner + dédupliquer + trier
          var merged = PIL_YEARS.concat(extra.map(function(y){ return parseInt(y,10); }).filter(function(y){ return !isNaN(y) && y >= 2020 && y <= 2099; }));
          merged = merged.filter(function(y, i, arr){ return arr.indexOf(y) === i; }).sort(function(a,b){ return a-b; });
          window._pilYears = merged;
          // Reconstruire les liens d'années dans #pil-sub sans toucher aux autres éléments (Cashflow, Prévisions)
          var pilSub = document.getElementById('pil-sub');
          if (pilSub) {
            // Supprimer uniquement les anciens liens d'années et l'ancien bouton +
            Array.from(pilSub.querySelectorAll('[data-pil-year], #pil-add-year-btn')).forEach(function(el){ el.remove(); });
            // Point d'insertion : avant le premier .si avec border-top (Cashflow)
            var cashflowEl = pilSub.querySelector('.si[style*="border-top"]');
            merged.forEach(function(y) {
              var div = document.createElement('div');
              div.className = 'si' + (PAGE === 'pilotage.html' && ACTIVE_YEAR === y ? ' on' : '');
              div.setAttribute('data-pil-year', y);
              div.onclick = function(){ location.href = 'pilotage.html?year=' + y; };
              div.innerHTML = '<span class="dot"></span>Pilotage ' + y;
              pilSub.insertBefore(div, cashflowEl || null);
            });
            // Bouton + après les années
            var addBtn = document.createElement('div');
            addBtn.id = 'pil-add-year-btn';
            addBtn.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 20px 7px 44px;color:rgba(255,255,255,.35);font-size:11px;cursor:pointer;transition:.15s';
            addBtn.onmouseenter = function(){ this.style.color = 'rgba(255,255,255,.7)'; };
            addBtn.onmouseleave = function(){ this.style.color = 'rgba(255,255,255,.35)'; };
            addBtn.onclick = function(){ addPilotageYear(); };
            addBtn.innerHTML = '<span style="font-size:14px;line-height:1">＋</span> Ajouter une année';
            pilSub.insertBefore(addBtn, cashflowEl || null);
          }
        } catch(e) { /* silencieux — ne jamais casser la nav */ }
      })();

      // ── TRACKING ACTIVITÉ (fire-and-forget, ne bloque jamais) ──
      // Throttle 5min par user via sessionStorage. Indépendant de window._setDoc
      // (utilise dynamic import pour fonctionner même sur les pages qui n'exposent pas Firestore).
      trackUserActivity(plan).catch(function(){});
    } catch (e) {
      if (mainEl) mainEl.style.visibility = 'visible';
      applyNavPlan('free');
    }
  });

  function handleProfilParams() {
    if (PAGE !== 'profil.html') return;
    const params = new URLSearchParams(location.search);
    if (params.get('tab') !== 'abonnement') return;
    setTimeout(function () {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('on'));
      const abonTab = Array.from(document.querySelectorAll('.tab')).find(t => t.textContent.includes('Abonnement'));
      if (abonTab) abonTab.classList.add('on');
      const abonPanel = document.getElementById('panel-abonnement');
      if (abonPanel) abonPanel.classList.add('on');
      // ── Afficher la modale trial expiré / deleted automatiquement ──
      var upgrade = params.get('upgrade');
      if (upgrade === 'trial_expired' || upgrade === 'deleted' || upgrade === 'promo_expired') showUpgradeModal(upgrade);
    }, 400);
  }

  // ════════════════════════════════════════════════
  // TRACKING ACTIVITÉ — users_activity/{uid}
  //
  // Écrit (en merge:true) :
  //   • lastActivity   : ISO du dernier pageload
  //   • lastPage       : nom de la page (ex: "pilotage.html")
  //   • lastModule     : module détecté (ex: "pilotage")
  //   • modulesUsed.X  : ISO du dernier accès au module X
  //   • daysActive.YYYY-MM-DD : true (pour calculer DAU/WAU/MAU)
  //   • lastEmail, plan : utiles pour l'admin reporting
  //
  // Throttle 5 min/user via sessionStorage (1 write max toutes les 5 minutes).
  // ════════════════════════════════════════════════
  var _trackFs = null;
  async function _ensureFirestore() {
    if (_trackFs) return _trackFs;
    if (!window._db) return null;
    if (window._setDoc && window._doc) {
      _trackFs = { db: window._db, setDoc: window._setDoc, doc: window._doc };
      return _trackFs;
    }
    try {
      var m = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      _trackFs = { db: window._db, setDoc: m.setDoc, doc: m.doc };
      return _trackFs;
    } catch (_) { return null; }
  }

  function _detectModule(page) {
    if (!page) return null;
    var p = page.replace('.html', '');
    if (['pilotage','dashboard','rapport-annuel','marges','cout-revient','panier','dettes','previsions','cashflow'].indexOf(p) >= 0) {
      if (['marges','cout-revient','panier'].indexOf(p) >= 0) return 'marges';
      if (['previsions','cashflow','dettes'].indexOf(p) >= 0) return 'cashflow';
      return 'pilotage';
    }
    if (['fidelisation','client-fidelite','tablet'].indexOf(p) >= 0) return 'fidelisation';
    if (p.indexOf('rh-') === 0 || p === 'espace-salarie') return 'rh';
    if (['banque','bank-validation','import-releve','import-facture-achat'].indexOf(p) >= 0) return 'banque';
    if (p === 'gestion-stock' || p === 'import') return 'stock';
    if (p === 'bilan') return 'bilan';
    if (['agent','lea','agent-historique','agent-upgrade'].indexOf(p) >= 0) return 'agent';
    return null; // pages neutres (index, login, profil, aide, pricing, ...)
  }

  async function trackUserActivity(plan) {
    try {
      if (!window._uid) return;
      // Throttle 5 min via sessionStorage
      var sessKey = 'altTrackActivity_' + window._uid;
      var nowMs = Date.now();
      var last = parseInt(sessionStorage.getItem(sessKey) || '0', 10);
      if (nowMs - last < 5 * 60 * 1000) return;

      var fs = await _ensureFirestore();
      if (!fs) return;

      var now = new Date();
      var todayStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
      var module = _detectModule(PAGE);
      var email = (window._auth && window._auth.currentUser && window._auth.currentUser.email) || '';

      var payload = {
        lastActivity: now.toISOString(),
        lastPage: PAGE || '',
        lastEmail: email,
        plan: plan || ''
      };
      if (module) {
        payload.lastModule = module;
        payload['modulesUsed.' + module] = now.toISOString();
      }
      payload['daysActive.' + todayStr] = true;

      await fs.setDoc(fs.doc(fs.db, 'users_activity', window._uid), payload, { merge: true });
      sessionStorage.setItem(sessKey, String(nowMs));
    } catch (_) {
      // Tracking ne doit JAMAIS casser la page → silencieux
    }
  }

  // ════════════════════════════════════════════════
  // BANDEAU PROMO (jours restants)
  // ════════════════════════════════════════════════
  function injectPromoBanner(daysLeft) {
    if (document.getElementById('promo-banner')) return;
    var color = daysLeft <= 3 ? '#ef4444' : daysLeft <= 7 ? '#f59e0b' : '#10b981';
    var bg    = daysLeft <= 3 ? '#fef2f2' : daysLeft <= 7 ? '#fffbeb' : '#f0fdf4';
    var border= daysLeft <= 3 ? '#fecaca' : daysLeft <= 7 ? '#fde68a' : '#bbf7d0';
    var text  = daysLeft <= 1
      ? '🎁 Votre offre gratuite expire <strong>demain</strong> !'
      : '🎁 Offre découverte — <strong>' + daysLeft + ' jour' + (daysLeft > 1 ? 's' : '') + '</strong> restant' + (daysLeft > 1 ? 's' : '');
    var banner = document.createElement('div');
    banner.id = 'promo-banner';
    banner.style.cssText = 'background:' + bg + ';border-bottom:2px solid ' + border + ';padding:10px 20px;display:flex;align-items:center;justify-content:center;gap:12px;font-size:13px;color:' + color + ';font-weight:600;z-index:49;position:sticky;top:0;flex-wrap:wrap';
    banner.innerHTML = '<span>' + text + '</span><a href="pricing.html" style="padding:5px 14px;background:linear-gradient(135deg,#1a3dce,#4f7ef8);color:white;border-radius:8px;font-size:12px;font-weight:700;text-decoration:none;white-space:nowrap">Choisir mon plan →</a>';
    var topbar = document.querySelector('.topbar');
    if (topbar && topbar.parentNode) {
      topbar.parentNode.insertBefore(banner, topbar);
    } else {
      var main = document.querySelector('.main, main');
      if (main) main.insertBefore(banner, main.firstChild);
    }
  }

  // ════════════════════════════════════════════════
  // CHARGEMENT CHATBOT (auto-injectable)
  // ════════════════════════════════════════════════
  (function loadChatbot() {
    var s = document.createElement('script');
    s.src = 'chatbot.js';
    s.defer = true;
    document.body.appendChild(s);
  })();

  // ════════════════════════════════════════════════
  // CHARGEMENT ONBOARDING (checklist + tours guidés)
  // ════════════════════════════════════════════════
  (function loadOnboarding() {
    var s = document.createElement('script');
    s.src = 'onboarding.js';
    s.defer = true;
    document.body.appendChild(s);
  })();

  // ════════════════════════════════════════════════
  // NAV v6 — MODE DÉCOUVERTE + ENCART "NAVIGATION A ÉVOLUÉ"
  //
  // 100% additif, fire-and-forget, ne bloque jamais la nav.
  //  • Compte ≤ 7 jours : pastilles d'étapes ①②③ + carte "Bien démarrer"
  //    (mêmes règles et mêmes données que la checklist onboarding.js :
  //     tuto_progress/{uid}.step_*, checklistDismissed, tutoDisabled,
  //     users/{uid}.createdAt, localStorage alteoreTuto*)
  //  • Compte > 7 jours : encart unique "La navigation a évolué"
  //    (localStorage alteoreNavV6Seen)
  // ════════════════════════════════════════════════
  var NAV_STEPS = [
    { id: 'profil',    label: 'compléter votre profil',        link: 'profil.html' },
    { id: 'ca',        label: 'saisir votre CA du mois',       link: 'pilotage.html' },
    { id: 'charges',   label: 'ajouter vos charges',           link: 'pilotage.html' },
    { id: 'produit',   label: 'créer votre premier produit',   link: 'cout-revient.html' },
    { id: 'dashboard', label: 'explorer votre tableau de bord', link: 'dashboard.html' }
  ];

  async function initNavExtras(snap) {
    try {
      if (!snap || !snap.exists()) return;
      var created = snap.data().createdAt;
      if (!created) return;
      var cd = created.toDate ? created.toDate() : new Date(created);
      if (isNaN(cd.getTime())) return;
      var ageDays = (Date.now() - cd.getTime()) / 864e5;

      if (ageDays <= 7) {
        // ── Nouveau compte → mode découverte ──
        try {
          if (localStorage.getItem('alteoreTutoDisabled') === '1') return;
          if (localStorage.getItem('alteoreTutoChecklistDismissed') === '1') return;
        } catch (e) {}
        var ps = null;
        try {
          ps = await window._getDoc(window._doc(window._db, 'tuto_progress', window._uid));
        } catch (e) { ps = null; }
        var prog = (ps && ps.exists()) ? ps.data() : {};
        if (prog.tutoDisabled || prog.checklistDismissed) return;

        var doneCount = 0, next = null;
        NAV_STEPS.forEach(function (s) {
          if (prog['step_' + s.id]) doneCount++;
          else if (!next) next = s;
        });
        if (doneCount >= NAV_STEPS.length) return; // tout est fait → nav sobre

        var nav = document.getElementById('alteore-nav');
        if (nav) nav.classList.add('decouverte');
        var cnt  = document.getElementById('nav-start-count');
        var fill = document.getElementById('nav-start-fill');
        var hint = document.getElementById('nav-start-hint');
        var card = document.getElementById('nav-start-card');
        if (cnt)  cnt.textContent = doneCount + '/' + NAV_STEPS.length;
        if (fill) fill.style.width = Math.round(doneCount / NAV_STEPS.length * 100) + '%';
        if (hint && next) hint.textContent = 'Prochaine étape : ' + next.label;
        window._navStartLink = next ? next.link : 'dashboard.html';
        if (card) card.style.display = '';
      } else {
        // ── Compte existant → encart migration (une seule fois) ──
        injectNavChangeNotice();
      }
    } catch (e) { /* silencieux — ne jamais casser la nav */ }
  }

  function injectNavChangeNotice() {
    try {
      if (localStorage.getItem('alteoreNavV6Seen') === '1') return;
    } catch (e) { return; }
    if (document.getElementById('nav-change-notice')) return;
    var n = document.createElement('div');
    n.id = 'nav-change-notice';
    n.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:9000;display:flex;align-items:center;gap:12px;max-width:540px;width:calc(100% - 32px);background:#0f1f5c;color:#fff;padding:13px 16px;border-radius:14px;box-shadow:0 14px 40px rgba(15,31,92,.4);font-size:12.5px;line-height:1.45;font-family:inherit';
    n.innerHTML = '<span style="font-size:18px;flex-shrink:0">✨</span>' +
      '<span style="flex:1;min-width:0"><strong>La navigation a évolué.</strong> Vos outils sont désormais rangés par usage : Au quotidien, Mes résultats, Développer. Rien n\'a été supprimé.</span>' +
      '<a href="aide.html" onclick="try{localStorage.setItem(\'alteoreNavV6Seen\',\'1\')}catch(e){}" style="color:#7be9ff;font-weight:700;text-decoration:none;white-space:nowrap;flex-shrink:0">Voir le guide</a>' +
      '<button onclick="try{localStorage.setItem(\'alteoreNavV6Seen\',\'1\')}catch(e){};this.parentNode.remove()" style="background:none;border:none;color:rgba(255,255,255,.55);font-size:15px;cursor:pointer;padding:2px 4px;flex-shrink:0" title="Fermer">✕</button>';
    document.body.appendChild(n);
  }

  // ════════════════════════════════════════════════
  // AJOUTER UNE ANNÉE PILOTAGE
  //
  // Calcule max(années affichées) + 1, écrit dans users/{uid}.pilotageYears
  // via merge Firestore (setDoc + merge:true), puis navigue vers la nouvelle année.
  // Ultra-safe : lit window._pilYears (déjà fusionné), ne casse rien si Firestore
  // est indisponible (fallback navigation directe sans persistance).
  // Accessible depuis le bouton ＋ dans la sidebar (onclick="addPilotageYear()").
  // ════════════════════════════════════════════════
  window.addPilotageYear = async function addPilotageYear() {
    var btn = document.getElementById('pil-add-year-btn');
    if (btn) {
      btn.style.opacity = '0.5';
      btn.style.pointerEvents = 'none';
    }
    try {
      var currentYears = window._pilYears || [new Date().getFullYear()];
      var newYear = Math.max.apply(null, currentYears) + 1;
      // Valider que l'année est raisonnable
      if (newYear > 2099) {
        if (btn) { btn.style.opacity = ''; btn.style.pointerEvents = ''; }
        return;
      }
      // Persister dans Firestore si Firebase dispo
      if (window._uid && window._db && window._doc && window._setDoc) {
        try {
          // Récupérer les années extra déjà stockées, ajouter la nouvelle
          var snap = await window._getDoc(window._doc(window._db, 'users', window._uid));
          var existing = (snap.exists() && Array.isArray(snap.data().pilotageYears)) ? snap.data().pilotageYears : [];
          // Merge : ajouter la nouvelle année si pas déjà présente
          var updated = existing.map(function(y){ return parseInt(y,10); }).filter(function(y){ return !isNaN(y); });
          if (updated.indexOf(newYear) === -1) updated.push(newYear);
          await window._setDoc(
            window._doc(window._db, 'users', window._uid),
            { pilotageYears: updated },
            { merge: true }
          );
        } catch(fsErr) {
          // Firestore KO : on navigue quand même, l'année ne sera pas persistée
          console.warn('[addPilotageYear] Firestore write failed, navigating anyway:', fsErr);
        }
      }
      // Naviguer vers la nouvelle année
      location.href = 'pilotage.html?year=' + newYear;
    } catch(e) {
      console.error('[addPilotageYear]', e);
      if (btn) { btn.style.opacity = ''; btn.style.pointerEvents = ''; }
    }
  };

})();
