// ══════════════════════════════════════════════════════════════════════
// PATCH : Validation manuelle de la checklist de conformité
// À ajouter dans rh-conformite.html AVANT la balise </body>
// ══════════════════════════════════════════════════════════════════════

// ── STOCKAGE DES OVERRIDES MANUELS ──────────────────────────────────
// Structure Firestore : rh/{uid}/conformite_overrides/{empId}
// Contenu : { rib: 'ok', cni: 'ok', vitale: 'warn', dpae: 'ok', ... }

var _conformiteOverrides = {}; // { empId: { checkId: 'ok'|'warn'|'nok'|null } }

async function loadConformiteOverrides(empId) {
  if (!window._uid || !window._getDoc || !window._doc || !window._db) return {};
  try {
    const snap = await window._getDoc(
      window._doc(window._db, 'rh', window._uid, 'conformite_overrides', empId)
    );
    if (snap.exists()) {
      _conformiteOverrides[empId] = snap.data() || {};
    } else {
      _conformiteOverrides[empId] = {};
    }
  } catch(e) {
    _conformiteOverrides[empId] = {};
  }
  return _conformiteOverrides[empId] || {};
}

async function saveConformiteOverride(empId, checkId, newState) {
  if (!_conformiteOverrides[empId]) _conformiteOverrides[empId] = {};
  
  // Toggle : si déjà en 'ok' manuel → repasser en auto (null)
  if (_conformiteOverrides[empId][checkId] === newState) {
    _conformiteOverrides[empId][checkId] = null;
  } else {
    _conformiteOverrides[empId][checkId] = newState;
  }
  
  if (window._uid && window._setDoc && window._doc && window._db) {
    try {
      await window._setDoc(
        window._doc(window._db, 'rh', window._uid, 'conformite_overrides', empId),
        _conformiteOverrides[empId],
        { merge: true }
      );
    } catch(e) { console.warn('Erreur save override:', e); }
  }
  
  // Re-render la fiche avec les nouveaux overrides
  const empList = window._empList || [];
  const emp = empList.find(e => (e.id || e.uid) === empId);
  if (emp) {
    const body = document.getElementById('body-fiche-salarie');
    if (body) body.innerHTML = renderFicheSalarie(emp);
  }
}
window.saveConformiteOverride = saveConformiteOverride;
window.loadConformiteOverrides = loadConformiteOverrides;

// ── REMPLACEMENT DE renderFicheSalarie ──────────────────────────────
// Sauvegarder l'ancienne version si besoin
const _renderFicheSalarieOriginal = window.renderFicheSalarie || null;

function renderFicheSalarie(emp) {
  const empId = emp.id || emp.uid || '';
  const overrides = _conformiteOverrides[empId] || {};

  const COLORS = ['#059669','#3b82f6','#8b5cf6','#f59e0b','#ef4444','#14b8a6'];
  const ci = (emp.prenom||'A').charCodeAt(0) % COLORS.length;
  const init = ((emp.prenom||'')[0]||'').toUpperCase() + ((emp.nom||'')[0]||'').toUpperCase();
  const nom = `${emp.prenom||''} ${emp.nom||''}`.trim();

  const checks = [
    { id:'contrat',      icon:'📝', label:'Contrat de travail',
      check: () => (emp.documents||[]).some(d=>d.type==='contrat')
        ? {ok:true,  msg:'Contrat enregistré'}
        : {ok:false, msg:'Aucun contrat enregistré dans les documents RH'} },
    { id:'cni',          icon:'🪪', label:'Pièce d\'identité',
      check: () => (emp.documents||[]).some(d=>d.type==='cni')
        ? {ok:true, msg:'CNI / Titre de séjour enregistré'}
        : {ok:null, msg:'Non enregistré — vérifier manuellement'} },
    { id:'rib',          icon:'💳', label:'RIB',
      check: () => (emp.documents||[]).some(d=>d.type==='rib')
        ? {ok:true, msg:'RIB enregistré'}
        : {ok:null, msg:'RIB non enregistré'} },
    { id:'vitale',       icon:'💚', label:'Carte vitale',
      check: () => (emp.documents||[]).some(d=>d.type==='vitale')
        ? {ok:true, msg:'Copie enregistrée'}
        : {ok:null, msg:'Non enregistrée'} },
    { id:'mutuelle',     icon:'🏥', label:'Attestation mutuelle',
      check: () => emp.mutuelle
        ? {ok:true, msg:'Mutuelle : ' + emp.mutuelle}
        : {ok:null, msg:'Mutuelle non renseignée'} },
    { id:'visite_med',   icon:'🩺', label:'Visite médicale',
      check: () => {
        if (emp.prochaineSuiviMedical) return {ok:true,  msg:`Prochaine visite : ${new Date(emp.prochaineSuiviMedical).toLocaleDateString('fr-FR')}`};
        if (emp.dateVisiteMedicale)    return {ok:null,  msg:`Dernière : ${new Date(emp.dateVisiteMedicale).toLocaleDateString('fr-FR')} — Planifier la prochaine`};
        return {ok:false, msg:'Aucune visite médicale renseignée'};
      }},
    { id:'entretien_pro',icon:'🎯', label:'Entretien professionnel',
      check: () => {
        if (!emp.derniereEmbauche) return {ok:null, msg:'Date d\'embauche inconnue'};
        const years = (new Date() - new Date(emp.derniereEmbauche)) / (365.25*24*3600*1000);
        if (years < 2)  return {ok:true, msg:`Embauché(e) il y a ${years.toFixed(1)} an(s) — Entretien à planifier`};
        if (years < 3)  return {ok:null, msg:`⚠️ Entretien professionnel dû depuis ${Math.floor((years-2)*12)} mois`};
        return {ok:false, msg:`❌ Entretien en retard de ${Math.floor((years-2)*12)} mois (risque pénalité CPF 3 000€)`};
      }},
    { id:'dpae',         icon:'📨', label:'DPAE effectuée',
      check: () => emp.dpaeDate
        ? {ok:true,  msg:`DPAE effectuée le ${new Date(emp.dpaeDate).toLocaleDateString('fr-FR')}`}
        : {ok:null,  msg:'DPAE non renseignée dans la fiche'} },
  ];

  // Appliquer les overrides manuels
  const renderCheck = (c) => {
    const autoRes  = c.check();
    const override = overrides[c.id]; // 'ok' | 'warn' | 'nok' | null
    
    // Résultat effectif après override
    const res = override
      ? { ok: override === 'ok' ? true : override === 'nok' ? false : null,
          msg: override === 'ok'   ? '✅ Validé manuellement'
             : override === 'nok'  ? '❌ Marqué non conforme'
             :                       '⚠️ Marqué à vérifier' }
      : autoRes;

    const color   = res.ok === true  ? '#059669' : res.ok === false ? '#ef4444' : '#f59e0b';
    const bg      = res.ok === true  ? '#f0fdf4' : res.ok === false ? '#fef2f2' : '#fffbeb';
    const icon    = res.ok === true  ? '✅'       : res.ok === false ? '❌'       : '⚠️';
    const isManual = !!override;

    return `<div style="position:relative;padding:10px 12px;border-radius:8px;background:${bg};border:1.5px solid ${color}33;cursor:pointer;transition:all .15s"
                 onclick="showCheckOverrideMenu('${empId}','${c.id}',this)"
                 title="Cliquer pour valider / modifier manuellement">
      <div style="display:flex;align-items:flex-start;gap:8px">
        <span style="font-size:14px;flex-shrink:0">${icon}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:11px;font-weight:700;color:#1a1f36">${c.icon} ${c.label}</div>
          <div style="font-size:10px;color:${color};margin-top:2px">${res.msg}</div>
          ${isManual ? `<div style="font-size:9px;color:#6b7280;margin-top:3px;font-style:italic">Manuel — cliquer pour retirer</div>` : ''}
        </div>
        <span style="font-size:11px;color:#9ca3af;flex-shrink:0" title="Valider manuellement">✎</span>
      </div>
    </div>`;
  };

  const docs_pertinents = (window.DOCS_CATALOGUE || []).filter(d => d.needsSalarie);

  return `
    <div style="padding:16px">
      <!-- EN-TÊTE SALARIÉ -->
      <div style="display:flex;align-items:center;gap:16px;padding:16px;background:#f5f7ff;border-radius:10px;margin-bottom:16px">
        <div style="width:52px;height:52px;border-radius:12px;background:${COLORS[ci]};display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;color:white;flex-shrink:0">${init}</div>
        <div style="flex:1">
          <div style="font-size:17px;font-weight:800;color:#1a1f36">${nom}</div>
          <div style="font-size:12px;color:#6b7280">${emp.poste||'Poste non renseigné'} · ${emp.typeContrat||'CDI'}</div>
          <div style="font-size:11px;color:#6b7280">Embauché(e) le ${emp.dateEmbauche||emp.derniereEmbauche ? new Date(emp.dateEmbauche||emp.derniereEmbauche).toLocaleDateString('fr-FR') : '—'}</div>
        </div>
        <div style="display:flex;gap:8px">
          <a href="rh-employes.html" style="text-decoration:none;display:flex;align-items:center;gap:6px;padding:7px 14px;border:1.5px solid #e2e8f0;border-radius:8px;background:white;font-size:12px;font-weight:600;color:#1a1f36">📋 Fiche complète</a>
          <button onclick="openPdfDrawerForEmp('${empId}')" style="padding:7px 14px;border:none;border-radius:8px;background:linear-gradient(135deg,#1a6b3a,#2d9e5a);color:white;font-size:12px;font-weight:600;cursor:pointer">📄 Générer doc PDF</button>
        </div>
      </div>

      <!-- CHECKLIST CONFORMITÉ -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-size:12px;font-weight:700;color:#1a1f36">Checklist de conformité</div>
        <div style="font-size:10px;color:#6b7280;font-style:italic">✎ Cliquez sur un item pour le valider manuellement</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">
        ${checks.map(c => renderCheck(c)).join('')}
      </div>

      <!-- MENU OVERRIDE (masqué, apparaît sur clic) -->
      <div id="override-menu-${empId}" style="display:none;position:fixed;z-index:999;background:white;border:1.5px solid #e2e8f0;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.15);padding:12px;min-width:200px">
        <div style="font-size:11px;font-weight:700;color:#374151;margin-bottom:10px" id="override-menu-label-${empId}">Validation manuelle</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <button onclick="applyOverride('${empId}','ok')" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border:1.5px solid #bbf7d0;border-radius:8px;background:#f0fdf4;cursor:pointer;font-size:12px;font-weight:600;color:#065f46;width:100%">
            ✅ Marquer conforme
          </button>
          <button onclick="applyOverride('${empId}','warn')" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border:1.5px solid #fde68a;border-radius:8px;background:#fffbeb;cursor:pointer;font-size:12px;font-weight:600;color:#92400e;width:100%">
            ⚠️ À vérifier / en cours
          </button>
          <button onclick="applyOverride('${empId}','nok')" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border:1.5px solid #fecaca;border-radius:8px;background:#fef2f2;cursor:pointer;font-size:12px;font-weight:600;color:#991b1b;width:100%">
            ❌ Non conforme
          </button>
          <button onclick="applyOverride('${empId}',null)" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border:1.5px solid #e2e8f0;border-radius:8px;background:#f8faff;cursor:pointer;font-size:12px;font-weight:600;color:#6b7280;width:100%">
            ↺ Retour automatique
          </button>
        </div>
        <button onclick="closeOverrideMenu('${empId}')" style="margin-top:8px;width:100%;padding:5px;border:none;background:none;color:#9ca3af;font-size:11px;cursor:pointer">Annuler</button>
      </div>

      <!-- DOCUMENTS À GÉNÉRER -->
      <div style="font-size:12px;font-weight:700;color:#1a1f36;margin-bottom:10px">Documents à générer pour ${nom}</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${docs_pertinents.map(doc => `
          <button onclick="openPdfDrawer('${doc.id}'); setTimeout(()=>{ const sel=document.getElementById('pdf-salarie-sel'); if(sel){sel.value='${empId}';onPdfSalarieSel('${empId}');} },100)"
                  style="display:flex;align-items:center;gap:6px;padding:7px 12px;border:1.5px solid #e2e8f0;border-radius:8px;background:white;cursor:pointer;font-size:11px;font-weight:600;color:#1a1f36"
                  onmouseover="this.style.borderColor='#1a6b3a';this.style.background='#f0fdf4'"
                  onmouseout="this.style.borderColor='#e2e8f0';this.style.background='white'">
            ${doc.icon} ${doc.titre}
          </button>`).join('')}
      </div>
    </div>`;
}

// ── GESTION DU MENU OVERRIDE ─────────────────────────────────────────
var _currentOverrideTarget = { empId: null, checkId: null };

function showCheckOverrideMenu(empId, checkId, el) {
  _currentOverrideTarget = { empId, checkId };
  
  const menu = document.getElementById(`override-menu-${empId}`);
  const label = document.getElementById(`override-menu-label-${empId}`);
  if (!menu) return;
  
  // Labels lisibles
  const labels = {
    contrat:'Contrat de travail', cni:"Pièce d'identité", rib:'RIB',
    vitale:'Carte vitale', mutuelle:'Mutuelle', visite_med:'Visite médicale',
    entretien_pro:'Entretien professionnel', dpae:'DPAE'
  };
  if (label) label.textContent = `✎ ${labels[checkId] || checkId}`;

  // Positionner le menu près de l'élément cliqué
  const rect = el.getBoundingClientRect();
  menu.style.display = 'block';
  menu.style.top  = (rect.bottom + window.scrollY + 6) + 'px';
  menu.style.left = (rect.left + window.scrollX) + 'px';

  // Fermer en cliquant ailleurs
  setTimeout(() => {
    document.addEventListener('click', function closeMenu(e) {
      if (!menu.contains(e.target)) {
        menu.style.display = 'none';
        document.removeEventListener('click', closeMenu);
      }
    });
  }, 50);
}

async function applyOverride(empId, state) {
  const { checkId } = _currentOverrideTarget;
  if (!checkId) return;
  
  closeOverrideMenu(empId);
  await saveConformiteOverride(empId, checkId, state);
  
  // Toast feedback
  const msgs = { ok:'✅ Validé manuellement', warn:'⚠️ Marqué à vérifier', nok:'❌ Marqué non conforme', null:'↺ Remis en automatique' };
  if (window.showToast) window.showToast(msgs[state] || 'Mis à jour', 'success');
}

function closeOverrideMenu(empId) {
  const menu = document.getElementById(`override-menu-${empId}`);
  if (menu) menu.style.display = 'none';
}

window.showCheckOverrideMenu = showCheckOverrideMenu;
window.applyOverride = applyOverride;
window.closeOverrideMenu = closeOverrideMenu;
window.renderFicheSalarie = renderFicheSalarie;

// ── CHARGER LES OVERRIDES AU MOMENT D'OUVRIR UNE FICHE ──────────────
// Patch de openFicheSalarie pour charger les overrides avant le rendu
const _openFicheSalarieOriginal = window.openFicheSalarie;
window.openFicheSalarie = async function(empId) {
  await loadConformiteOverrides(empId);
  if (_openFicheSalarieOriginal) _openFicheSalarieOriginal(empId);
};
