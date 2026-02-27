/* ══════════════════════════════════════════
   CONSTANTES
══════════════════════════════════════════ */
var COLORS = {cp:'#059669',rtt:'#3b82f6',css:'#f59e0b',evenement:'#7c3aed',maladie:'#ef4444',recuperation:'#0891b2',formation:'#db2777'};
var LABELS  = {cp:'Cong\u00e9s pay\u00e9s',rtt:'RTT',css:'Sans solde',evenement:'\u00c9v\u00e9nement familial',maladie:'Maladie / Arr\u00eat',recuperation:'R\u00e9cup\u00e9ration heures',formation:'Formation'};
var ICONS   = {cp:'\ud83c\udfd6\ufe0f',rtt:'\u23f0',css:'\ud83d\udcbc',evenement:'\ud83c\udf89',maladie:'\ud83e\udd12',recuperation:'\ud83d\udd04',formation:'\ud83c\udf93'};
var SOLDE_K = {cp:'cpRestant',rtt:'rttRestant',recuperation:'recupRestant'};
var DOW_KEY = ['lundi','mardi','mercredi','jeudi','vendredi','samedi','dimanche'];

// Documents requis - labels en unicode pur pour compatibilite Safari
var DOCS_REQUIRED = [
  {id:"cni",         label:"Pi\u00e8ce d\u2019identit\u00e9",       desc:"CNI ou passeport en cours de validit\u00e9", icon:"\ud83e\udeb4"},
  {id:"rib",         label:"RIB",                                    desc:"Relev\u00e9 d\u2019identit\u00e9 bancaire", icon:"\ud83c\udfe6"},
  {id:"justif_dom",  label:"Justificatif de domicile",               desc:"Facture de moins de 3 mois", icon:"\ud83c\udfe0"},
  {id:"vitale",      label:"Carte vitale",                           desc:"Carte d\u2019assurance maladie", icon:"\ud83d\udc9a"},
  {id:"titre_sejour",label:"Titre de s\u00e9jour",                  desc:"Si ressortissant non-UE", icon:"\ud83d\udccb", optional:true},
  {id:"diplome",     label:"Justificatif de dipl\u00f4me",          desc:"Copie du dipl\u00f4me le plus \u00e9lev\u00e9", icon:"\ud83c\udf93", optional:true},
];
function escHtml(s){ return (s||"").replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
// Echapper les labels pour usage dans onclick HTML
function escHtml(s){ return (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* ══════════════════════════════════════════
   ÉTAT GLOBAL
══════════════════════════════════════════ */
var _uid='', _empId='', _emp={}, _params={}, _demandes=[];
var _soldes={};
var _selType='';
var _demFilter='all';
var _calMonth=new Date();
var _year=new Date().getFullYear();
var _planningCache={};
var _profilEdits={};       // modifications en attente
var _profilFields={};      // valeurs actuelles du profil étendu
var _docsEmployee={};      // {docId: {name, size, uploadedAt, data}}
var _docsEmployer=[];      // [{label, name, uploadedAt, data}]
var _uploadDocId='';       // document en cours d'upload
var _uploadB64=null;
var _uploadMeta=null;

/* ══════════════════════════════════════════
   DÉMARRAGE
══════════════════════════════════════════ */
window.startApp = function() {
  var p = new URLSearchParams(window.location.search);
  var pid = p.get('id') || '';
  if (!pid) { showNotFound(); return; }
  var t = setInterval(function() {
    if (window._dbReady) { clearInterval(t); loadEmploye(pid); }
  }, 80);
};

async function loadEmploye(pid) {
  try {
    var snap = await window._getDoc('rh_employes_public', pid);
    if (!snap.exists()) { showNotFound(); return; }
    var data = snap.data();
    _uid = data.uid; _empId = data.empId; _emp = data;

    // Charger le profil étendu (données saisies par le salarié)
    try {
      var profSnap = await window._getDoc('rh_employes_public_profil', pid);
      if (profSnap.exists()) {
        _profilFields = profSnap.data();
      }
    } catch(e) { _profilFields = {}; }

    // Charger params RH
    try {
      var ps = await window._getDoc('rh_params', _uid);
      _params = ps.exists() ? ps.data() : {};
    } catch(e) { _params = {}; }

    // Charger données employé privées (lecture seule)
    try {
      var empSnap = await window._getDoc('rh', _uid, 'employes', _empId);
      if (empSnap.exists()) {
        var ed = empSnap.data();
        // Fusion sécurisée des données RO
        ['salaireBrut','salaireNet','heuresHebdo','frequence','categoriePoste','ccn',
         'dateNaissance','nationalite','periodeEssai','noteMoyenne'].forEach(function(k){
          if(ed[k] !== undefined && _emp[k] === undefined) _emp[k] = ed[k];
        });
        // Documents déposés par l'employeur
        if(ed.documentsEmployeur) _docsEmployer = ed.documentsEmployeur;
        // Documents du salarié déjà stockés
        if(ed.documentsEmployee) _docsEmployee = ed.documentsEmployee;
      }
    } catch(e) {}

    await loadDemandes();
    await loadPlanningMonth(_calMonth.getFullYear(), _calMonth.getMonth());
    calcSoldes();
    renderAll();

    var lw = document.getElementById('loading-wrap');
    lw.classList.add('fade');
    setTimeout(function() { lw.style.display='none'; document.getElementById('main-wrap').style.display='block'; }, 400);
  } catch(e) { console.error(e); showNotFound(); }
}

/* ══════════════════════════════════════════
   CHARGEMENT DONNÉES
══════════════════════════════════════════ */
async function loadDemandes() {
  _demandes = [];
  try {
    var snap = await window._queryWhere(['rh_conges', _uid, 'demandes'], 'empId', _empId);
    snap.forEach(function(d) { _demandes.push(Object.assign({id:d.id}, d.data())); });
    _demandes.sort(function(a,b) { return (b.createdAt||'').localeCompare(a.createdAt||''); });
  } catch(e) { console.warn('Demandes:', e.message); }
}

async function loadPlanningMonth(y, m) {
  _planningCache = {};
  if (!_uid || !_empId) return;
  var weekKeys = {};
  var nb = new Date(y, m+1, 0).getDate();
  for (var d = 1; d <= nb; d++) {
    var dt = new Date(y, m, d);
    var mon = new Date(dt);
    var day = mon.getDay(), diff = (day === 0) ? -6 : 1 - day;
    mon.setDate(mon.getDate() + diff);
    mon.setHours(0,0,0,0);
    var wk = mon.toISOString().slice(0,10).replace(/-/g,'');
    weekKeys[wk] = true;
  }
  for (var wk in weekKeys) {
    try {
      var snap = await window._getDocs('rh', _uid, 'plan_'+wk);
      snap.forEach(function(doc) {
        if (doc.id.endsWith('_'+_empId)) {
          var dateStr = doc.id.replace('_'+_empId, '');
          var data = doc.data();
          _planningCache[dateStr] = (data.items || []).filter(function(it) {
            return it.type === 'travail' || it.type === 'formation' || it.type === 'astreinte';
          });
        }
      });
    } catch(e) {}
  }
}

/* ══════════════════════════════════════════
   CALCUL SOLDES
══════════════════════════════════════════ */
function calcSoldes() {
  var now = new Date();
  var y = _year;
  var cpAnnuels = parseFloat(_params.cpAnnuels) || 25;
  var cpPeriode = _params.cpPeriode || '1juin';
  var rttAnnuels = parseFloat(_params.rttAnnuels) || 0;
  var pDeb, pFin;
  if (cpPeriode === '1janv') { pDeb = new Date(y,0,1); pFin = new Date(y,11,31); }
  else { pDeb = new Date(y-1,5,1); pFin = new Date(y,4,31); }
  var entree = _emp.dateEntree ? new Date(_emp.dateEntree+'T12:00:00') : new Date(y-2,0,1);
  var debut = entree > pDeb ? entree : pDeb;
  var fin = now < pFin ? now : pFin;
  var mois = Math.max(0, (fin.getFullYear()-debut.getFullYear())*12 + (fin.getMonth()-debut.getMonth()));
  var ajust = parseFloat(_emp.cpAjustAcquis) || 0;
  var cpAcquis = Math.round(Math.max(0, mois*(cpAnnuels/12)+ajust)*10)/10;
  var cpPris = _demandes.filter(function(d) {
    if (!d.dateDebut || d.type !== 'cp' || d.statut !== 'approved') return false;
    var dt = new Date(d.dateDebut+'T12:00:00');
    return dt >= pDeb && dt <= pFin;
  }).reduce(function(s,d) { return s + (d.nbJours||0); }, 0);
  var rttBase = (parseFloat(_emp.rttAjust) >= 0) ? parseFloat(_emp.rttAjust) : rttAnnuels;
  var rttPris = _demandes.filter(function(d) { return d.type==='rtt' && d.statut==='approved' && new Date(d.dateDebut||0).getFullYear()===y; }).reduce(function(s,d) { return s+(d.nbJours||0); }, 0);
  _soldes = {
    cpAcquis: cpAcquis, cpPris: cpPris,
    cpRestant: Math.max(0, cpAcquis-cpPris),
    rttBase: rttBase, rttPris: rttPris,
    rttRestant: Math.max(0, rttBase-rttPris),
    recupRestant: parseFloat(_emp.recupHeures) || 0,
    pending: _demandes.filter(function(d) { return d.statut==='pending'; }).length,
  };
}

/* ══════════════════════════════════════════
   RENDER GLOBAL
══════════════════════════════════════════ */
function renderAll() {
  var col = _emp.couleur || '#059669';
  var av = document.getElementById('hero-av');
  av.textContent = (_emp.prenom||'?').charAt(0).toUpperCase();
  av.style.background = col;
  document.getElementById('hero-name').textContent = ((_emp.prenom||'')+' '+(_emp.nom||'')).trim();
  document.getElementById('hero-sub').textContent  = [_emp.poste,_emp.departement,_emp.typeContrat].filter(Boolean).join(' \u00b7 ');
  document.getElementById('year-lbl').textContent  = _year;

  // Chips hero
  var chips = [];
  if (_emp.typeContrat) chips.push(_emp.typeContrat);
  if (_emp.departement) chips.push(_emp.departement);
  if (_emp.heuresHebdo) chips.push(_emp.heuresHebdo+'h/sem');
  document.getElementById('hero-chips').innerHTML = chips.map(function(c){ return '<span class="hero-chip">'+c+'</span>'; }).join('');

  renderSoldesFlottants();
  renderAccueil();
  renderProfil();
  renderDocuments();
  renderSoldesDetail();
  renderTypeGrid();
  renderDemandes();
  renderCal();
  renderHoraires();
}

/* ══════════════════════════════════════════
   SOLDES FLOTTANTS
══════════════════════════════════════════ */
function renderSoldesFlottants() {
  var s = _soldes;
  var cpPct = s.cpAcquis>0 ? Math.min(s.cpPris/s.cpAcquis*100,100).toFixed(0) : 0;
  var rttPct = s.rttBase>0 ? Math.min(s.rttPris/s.rttBase*100,100).toFixed(0) : 0;
  document.getElementById('soldes-grid').innerHTML =
    sc('\ud83c\udfd6\ufe0f', s.cpRestant.toFixed(1), 'j', 'CP restants', s.cpAcquis.toFixed(1)+'j acquis', s.cpRestant>10?'g':s.cpRestant>5?'o':'r', cpPct, 'var(--orange)')
   +sc('\u23f0', s.rttRestant.toFixed(1), 'j', 'RTT restants', s.rttBase+'j allou\u00e9s', s.rttRestant>0?'g':'r', rttPct, 'var(--blue)')
   +sc('\ud83d\udd04', s.recupRestant.toFixed(1), 'h', 'R\u00e9cup\u00e9ration', 'Heures \u00e0 prendre', s.recupRestant>0?'g':'', 0, '')
   +sc('\u23f3', s.pending, '', 'En attente', 'demande'+(s.pending>1?'s':'')+' \u00e0 valider', s.pending>0?'o':'', 0, '');
}
function sc(icon, val, unit, lbl, sub, cls, pct, fillColor) {
  return '<div class="sc">'
    +'<div class="sc-icon">'+icon+'</div>'
    +'<div class="sc-val '+cls+'">'+val+'<span class="sc-unit">'+unit+'</span></div>'
    +'<div class="sc-lbl">'+lbl+'</div>'
    +'<div class="sc-sub">'+sub+'</div>'
    +(pct>0?'<div class="sc-bar"><div class="sc-fill" style="width:'+pct+'%;background:'+fillColor+'"></div></div>':'')
    +'</div>';
}

/* ══════════════════════════════════════════
   ACCUEIL
══════════════════════════════════════════ */
function renderAccueil() {
  var now = new Date();
  var jours = ['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'];
  document.getElementById('welcome-name').textContent = 'Bonjour '+(_emp.prenom||'') +' ! \ud83d\udc4b';
  document.getElementById('welcome-date').textContent = jours[now.getDay()]+' '+now.toLocaleDateString('fr-FR',{day:'numeric',month:'long',year:'numeric'});
  document.getElementById('accueil-annee-lbl').textContent = '\u2014 '+_year;
  document.getElementById('conges-annee-lbl').textContent = '\u2014 '+_year;

  // Infos contrat
  var infos = [];
  if(_emp.poste) infos.push({icon:'\ud83d\udcbc', label:'Poste', val:_emp.poste});
  if(_emp.dateEntree) infos.push({icon:'\ud83d\udcc5', label:'Entr\u00e9e', val:fmtDate(_emp.dateEntree)});
  if(_emp.typeContrat) infos.push({icon:'\ud83d\udcc4', label:'Contrat', val:_emp.typeContrat});
  if(_emp.departement) infos.push({icon:'\ud83c\udfe2', label:'\u00c9quipe', val:_emp.departement});
  document.getElementById('accueil-infos').innerHTML = infos.map(function(i){
    return '<div class="info-line"><span class="info-line-icon">'+i.icon+'</span><span class="info-line-label">'+i.label+'</span><span class="info-line-val">'+i.val+'</span></div>';
  }).join('');

  // Soldes accueil
  var s = _soldes;
  document.getElementById('accueil-soldes').innerHTML =
    soldeBar('\ud83c\udfd6\ufe0f CP restants', s.cpRestant, s.cpAcquis, 'j', s.cpRestant>10?'var(--g3)':s.cpRestant>5?'var(--orange)':'var(--red)')
   +soldeBar('\u23f0 RTT restants', s.rttRestant, s.rttBase, 'j', s.rttRestant>0?'var(--blue)':'var(--red)')
   +(s.recupRestant>0?soldeBar('\ud83d\udd04 R\u00e9cup\u00e9ration', s.recupRestant, s.recupRestant, 'h', 'var(--teal)'):'');

  // 3 dernières demandes
  var recent = _demandes.slice(0,3);
  var el = document.getElementById('accueil-demandes');
  if(!recent.length){ el.innerHTML='<div class="empty"><div class="empty-icon">\ud83d\udccb</div>Aucune demande.</div>'; return; }
  el.innerHTML = recent.map(function(d){
    return demItemHtml(d);
  }).join('');

  // Badge congés en attente
  var pendingCount = _soldes.pending;
  var tabBtn = document.getElementById('tab-conges-btn');
  if(pendingCount>0 && tabBtn){
    tabBtn.innerHTML = '\ud83c\udfd6\ufe0f Cong\u00e9s <span class="notif">'+pendingCount+'</span>';
  }

  // Badge documents manquants
  var missingDocs = DOCS_REQUIRED.filter(function(d){ return !d.optional && !_docsEmployee[d.id]; }).length;
  var tabDocsBtn = document.getElementById('tab-docs-btn');
  if(missingDocs>0 && tabDocsBtn){
    tabDocsBtn.innerHTML = '\ud83d\udcce Documents <span class="notif">'+missingDocs+'</span>';
  }
}

function soldeBar(label, val, max, unit, color) {
  var pct = max>0 ? Math.min(val/max*100,100).toFixed(0) : 0;
  return '<div style="margin-bottom:12px">'
    +'<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">'
      +'<span style="font-size:12px;font-weight:700">'+label+'</span>'
      +'<span style="font-size:14px;font-weight:800;color:'+color+'">'+val.toFixed(1)+'<span style="font-size:10px;font-weight:600"> '+unit+'</span></span>'
    +'</div>'
    +'<div style="height:6px;background:#f3f4f6;border-radius:99px;overflow:hidden">'
      +'<div style="height:100%;width:'+pct+'%;background:'+color+';border-radius:99px;transition:width .5s ease"></div>'
    +'</div>'
    +'<div style="font-size:10px;color:var(--muted);margin-top:2px">'+val.toFixed(1)+' / '+max.toFixed(1)+' '+unit+' ('+pct+'% utilis\u00e9s)</div>'
  +'</div>';
}

/* ══════════════════════════════════════════
   PROFIL
══════════════════════════════════════════ */
function renderProfil() {
  // Contrat card
  var dateEntree = _emp.dateEntree ? fmtDate(_emp.dateEntree) : '\u2014';
  var anciennete = _emp.dateEntree ? calcAnciennete(_emp.dateEntree) : '';
  document.getElementById('contrat-card-wrap').innerHTML =
    '<div class="contrat-card">'
      +'<div class="contrat-left">'
        +'<div class="contrat-type">'+((_emp.typeContrat||'Contrat'))+' \u00b7 '+(_emp.poste||'\u2014')+'</div>'
        +'<div class="contrat-sub">'
          +(_emp.departement?_emp.departement+' \u00b7 ':'')
          +(_emp.heuresHebdo?_emp.heuresHebdo+'h/semaine \u00b7 ':'')
          +(_emp.frequence?_emp.frequence.charAt(0).toUpperCase()+_emp.frequence.slice(1)+'':'')
        +'</div>'
        +'<div class="contrat-sub" style="margin-top:4px">Entr\u00e9e : '+dateEntree+'</div>'
      +'</div>'
      +(anciennete?'<div class="contrat-stat"><div class="cs-val">'+anciennete+'</div><div class="cs-lbl">Anciennet\u00e9</div></div>':'')
    +'</div>';

  // Infos personnelles
  var pf = _profilFields;
  setVal('pf-prenom', _emp.prenom||'\u2014');
  setVal('pf-nom', _emp.nom||'\u2014');
  setEditVal('pf-email-perso', pf.emailPerso, 'Ajouter email personnel');
  setEditVal('pf-tel', pf.telephone, 'Ajouter t\u00e9l\u00e9phone');
  setEditVal('pf-adresse', pf.adresse, 'Ajouter adresse');
  setEditVal('pf-ddn', pf.dateNaissance, 'Ajouter date de naissance');
  setEditVal('pf-nat', pf.nationalite, 'Ajouter nationalit\u00e9');
  setEditVal('pf-iban', pf.iban ? maskIban(pf.iban) : '', 'Ajouter IBAN');
  setEditVal('pf-titulaire', pf.ibanTitulaire, 'Ajouter titulaire');
  setEditVal('pf-urgence-nom', pf.contactUrgenceNom, 'Ajouter contact urgence');
  setEditVal('pf-urgence-lien', pf.contactUrgenceLien, 'Ex : conjoint, parent...');
  setEditVal('pf-urgence-tel', pf.contactUrgenceTel, 'T\u00e9l\u00e9phone urgence');

  // Urgence card
  var uw = document.getElementById('urgence-wrap');
  if(pf.contactUrgenceNom && pf.contactUrgenceTel){
    uw.innerHTML = '<div class="urgence-card">'
      +'<div class="urgence-ico">\ud83d\udea8</div>'
      +'<div class="urgence-body">'
        +'<div class="urgence-name">'+pf.contactUrgenceNom+'</div>'
        +(pf.contactUrgenceLien?'<div class="urgence-lien">'+pf.contactUrgenceLien+'</div>':'')
        +'<div class="urgence-tel">\ud83d\udcde '+pf.contactUrgenceTel+'</div>'
      +'</div>'
    +'</div>';
  } else { uw.innerHTML = ''; }

  // Contrat RO
  var contratRows = [];
  if(_emp.typeContrat) contratRows.push({icon:'\ud83d\udcc4', label:'Type', val:_emp.typeContrat});
  if(_emp.dateEntree) contratRows.push({icon:'\ud83d\udcc5', label:'Date entr\u00e9e', val:fmtDate(_emp.dateEntree)});
  if(_emp.heuresHebdo) contratRows.push({icon:'\u23f0', label:'Horaire', val:_emp.heuresHebdo+'h / semaine'});
  if(_emp.categoriePoste) contratRows.push({icon:'\ud83d\udcbc', label:'Cat\u00e9gorie', val:capitalize(_emp.categoriePoste)});
  if(_emp.ccn) contratRows.push({icon:'\ud83d\udccb', label:'Convention', val:_emp.ccn});
  if(_emp.periodeEssai && _emp.periodeEssai.active) contratRows.push({icon:'\u26a0\ufe0f', label:'P\u00e9riode essai', val:'En cours'});
  var cb = document.getElementById('contrat-body');
  if(contratRows.length){
    cb.innerHTML = contratRows.map(function(r){
      return '<div class="info-line"><span class="info-line-icon">'+r.icon+'</span><span class="info-line-label">'+r.label+'</span><span class="info-line-val">'+r.val+'</span></div>';
    }).join('');
  } else {
    cb.innerHTML = '<div class="empty"><div class="empty-icon">\ud83d\udccb</div><span>Infos de contrat \u00e0 renseigner par votre employeur.</span></div>';
  }
}

function setVal(id, val) { var el=document.getElementById(id); if(el) el.textContent=val; }
function setEditVal(id, val, placeholder) {
  var el = document.getElementById(id);
  if(!el) return;
  if(val) {
    el.textContent = val;
    el.style.color = 'var(--text)';
  } else {
    el.textContent = placeholder||'\u2014';
    el.style.color = 'var(--muted)';
  }
}

function editField(el, fieldKey) {
  var currentVal = _profilFields[fieldKey] || '';
  var input = document.createElement('input');
  input.className = 'profil-input';
  input.value = currentVal;
  input.placeholder = el.getAttribute('title') || 'Saisir...';
  el.replaceWith(input);
  input.focus();
  input.select();

  function save() {
    var newVal = input.value.trim();
    _profilEdits[fieldKey] = newVal;
    _profilFields[fieldKey] = newVal;
    var div = document.createElement('div');
    div.id = el.id;
    div.className = el.className;
    div.setAttribute('onclick', el.getAttribute('onclick'));
    div.setAttribute('title', el.getAttribute('title'));
    div.style.color = newVal ? 'var(--text)' : 'var(--muted)';
    if(fieldKey==='iban' && newVal) div.textContent = maskIban(newVal);
    else div.textContent = newVal || (el.getAttribute('title')||'\u2014');
    input.replaceWith(div);
    // Réattacher le event onclick
    div.addEventListener('click', function(){ editField(div, fieldKey); });
    // Afficher bouton save
    if(Object.keys(_profilEdits).length > 0){
      document.getElementById('btn-save-profil').classList.add('show');
    }
  }
  input.addEventListener('blur', save);
  input.addEventListener('keydown', function(e){ if(e.key==='Enter') input.blur(); if(e.key==='Escape'){ input.value=currentVal; input.blur(); } });
}
window.editField = editField;

async function saveProfil() {
  if(!Object.keys(_profilEdits).length) return;
  var btn = document.getElementById('btn-save-profil');
  btn.textContent = '\u23f3 Enregistrement...';
  btn.disabled = true;
  try {
    // Fusionner avec données existantes
    var toSave = Object.assign({}, _profilFields, _profilEdits, {
      empId: _empId,
      uid: _uid,
      updatedAt: new Date().toISOString()
    });
    await window._setDocFs('rh_employes_public_profil', _uid+'_'+_empId, toSave, {merge:true});
    // Aussi mettre à jour les champs non-sensibles sur le doc public
    var publicUpdate = {};
    if(_profilEdits.telephone) publicUpdate.telephone = _profilEdits.telephone;
    if(_profilEdits.contactUrgenceNom) publicUpdate.contactUrgenceNom = _profilEdits.contactUrgenceNom;
    if(_profilEdits.contactUrgenceTel) publicUpdate.contactUrgenceTel = _profilEdits.contactUrgenceTel;
    if(_profilEdits.contactUrgenceLien) publicUpdate.contactUrgenceLien = _profilEdits.contactUrgenceLien;
    if(Object.keys(publicUpdate).length){
      Object.assign(_emp, publicUpdate);
    }
    _profilEdits = {};
    btn.classList.remove('show');
    btn.textContent = '\ud83d\udcbe Enregistrer les modifications';
    btn.disabled = false;
    showToast('\u2705 Profil enregistr\u00e9','ok');
    renderProfil(); // re-render urgence card
  } catch(e) {
    console.error(e);
    showToast('Erreur : '+e.message,'err');
    btn.textContent = '\ud83d\udcbe Enregistrer les modifications';
    btn.disabled = false;
  }
}
window.saveProfil = saveProfil;

/* ══════════════════════════════════════════
   DOCUMENTS
══════════════════════════════════════════ */
function renderDocuments() {
  var total = DOCS_REQUIRED.filter(function(d){ return !d.optional; }).length;
  var done  = DOCS_REQUIRED.filter(function(d){ return !d.optional && _docsEmployee[d.id]; }).length;
  var pct   = total > 0 ? Math.round(done / total * 100) : 0;

  document.getElementById('docs-progress-lbl').textContent   = done + ' / ' + total + ' documents fournis';
  document.getElementById('docs-progress-fill').style.width  = pct + '%';
  document.getElementById('docs-required-count').textContent = done + '/' + total;

  // ── Construction DOM pure — zéro innerHTML avec accents ──
  var reqList = document.getElementById('docs-required-list');
  reqList.innerHTML = '';

  DOCS_REQUIRED.forEach(function(doc, idx) {
    var uploaded  = _docsEmployee[doc.id];
    var cls       = uploaded ? 'doc-item uploaded' : (doc.optional ? 'doc-item' : 'doc-item required');
    var icoClass  = uploaded ? 'g' : (doc.optional ? 'o' : 'r');
    var dateStr   = uploaded && uploaded.uploadedAt ? ' \u00b7 ' + fmtDate(uploaded.uploadedAt.split('T')[0]) : '';

    // Conteneur
    var item = document.createElement('div');
    item.className = cls;

    // Icône
    var ico = document.createElement('div');
    ico.className = 'doc-ico ' + icoClass;
    ico.textContent = doc.icon;
    item.appendChild(ico);

    // Infos
    var info = document.createElement('div');
    info.className = 'doc-info';

    var nameDiv = document.createElement('div');
    nameDiv.className = 'doc-name';
    nameDiv.textContent = doc.label;
    if (doc.optional) {
      var optSpan = document.createElement('span');
      optSpan.style.cssText = 'font-size:9px;font-weight:400;color:var(--muted);margin-left:4px';
      optSpan.textContent = '(facultatif)';
      nameDiv.appendChild(optSpan);
    }
    info.appendChild(nameDiv);

    var metaDiv = document.createElement('div');
    metaDiv.className = 'doc-meta';
    metaDiv.textContent = uploaded ? ('\u2705 ' + uploaded.name + dateStr) : doc.desc;
    info.appendChild(metaDiv);

    item.appendChild(info);

    // Bouton action
    var action = document.createElement('div');
    action.className = 'doc-action';
    var btn = document.createElement('button');
    btn.setAttribute('data-idx', idx);
    if (uploaded) {
      btn.className = 'btn-view';
      btn.textContent = '\ud83d\udc41 Voir';
      btn.onclick = function() { viewDocIdx(this); };
    } else {
      btn.className = 'btn-upload';
      btn.textContent = '\ud83d\udce4 D\u00e9poser';
      btn.onclick = function() { openUploadIdx(this); };
    }
    action.appendChild(btn);
    item.appendChild(action);

    reqList.appendChild(item);
  });

  // ── Docs reçus de l'employeur ──
  var empList = document.getElementById('docs-employer-list');
  document.getElementById('docs-employer-count').textContent = _docsEmployer.length || '0';
  empList.innerHTML = '';

  if (!_docsEmployer.length) {
    var empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '<div class="empty-icon">\ud83d\udce5</div>';
    var emptyTxt = document.createElement('span');
    emptyTxt.textContent = 'Aucun document transmis par votre employeur pour l\u2019instant.';
    empty.appendChild(emptyTxt);
    empList.appendChild(empty);
  } else {
    _docsEmployer.forEach(function(doc, i) {
      var dateStr = doc.uploadedAt ? fmtDate(doc.uploadedAt.split('T')[0]) : '';

      var item = document.createElement('div');
      item.className = 'doc-item employer';

      var ico = document.createElement('div');
      ico.className = 'doc-ico b';
      ico.textContent = '\ud83d\udcc4';
      item.appendChild(ico);

      var info = document.createElement('div');
      info.className = 'doc-info';

      var nameDiv = document.createElement('div');
      nameDiv.className = 'doc-name';
      nameDiv.textContent = doc.label || 'Document';
      info.appendChild(nameDiv);

      var metaDiv = document.createElement('div');
      metaDiv.className = 'doc-meta';
      metaDiv.textContent = (doc.name || '') + (dateStr ? ' \u00b7 ' + dateStr : '');
      info.appendChild(metaDiv);

      item.appendChild(info);

      if (doc.data) {
        var action = document.createElement('div');
        action.className = 'doc-action';
        var btn = document.createElement('button');
        btn.className = 'btn-view';
        btn.textContent = '\ud83d\udc41 Voir';
        (function(idx){ btn.onclick = function() { viewEmployerDoc(idx); }; })(i);
        action.appendChild(btn);
        item.appendChild(action);
      }

      empList.appendChild(item);
    });
  }
}

// Ouvre la modal via index (pas de string dans onclick)
function openUploadIdx(btn) {
  var idx = parseInt(btn.getAttribute('data-idx'));
  var docDef = DOCS_REQUIRED[idx] || {};
  openUploadModal(docDef.id, docDef.label, docDef.desc);
}
window.openUploadIdx = openUploadIdx;

function openUploadModal(docId, label, desc) {
  _uploadDocId = docId;
  _uploadB64 = null; _uploadMeta = null;
  document.getElementById('upload-modal-title').textContent = '\ud83d\udce4 '+(label||docId);
  document.getElementById('upload-modal-desc').textContent = desc||'';
  document.getElementById('upload-input').value = '';
  document.getElementById('upload-preview').style.display = 'none';
  document.getElementById('upload-submit-btn').disabled = true;
  document.getElementById('upload-modal').classList.add('show');
}
window.openUploadModal = openUploadModal;

function closeUploadModal() {
  document.getElementById('upload-modal').classList.remove('show');
  _uploadB64 = null; _uploadMeta = null;
}
window.closeUploadModal = closeUploadModal;

function onUploadChange(input) {
  var file = input.files[0];
  if (!file) return;
  if (file.size > 5*1024*1024) { showToast('Fichier trop lourd (max 5 Mo)','err'); return; }
  var reader = new FileReader();
  reader.onload = function(e) {
    _uploadB64 = e.target.result;
    _uploadMeta = { name: file.name, size: file.size, type: file.type };
    document.getElementById('upload-preview-name').textContent = file.name;
    document.getElementById('upload-preview-size').textContent = (file.size/1024).toFixed(0)+'Ko';
    document.getElementById('upload-preview').style.display = 'flex';
    document.getElementById('upload-submit-btn').disabled = false;
  };
  reader.readAsDataURL(file);
}
window.onUploadChange = onUploadChange;

function clearUpload() {
  _uploadB64 = null; _uploadMeta = null;
  document.getElementById('upload-input').value = '';
  document.getElementById('upload-preview').style.display = 'none';
  document.getElementById('upload-submit-btn').disabled = true;
}
window.clearUpload = clearUpload;

async function submitUpload() {
  if(!_uploadB64 || !_uploadDocId) return;
  var btn = document.getElementById('upload-submit-btn');
  btn.disabled = true; btn.textContent = '\u23f3 Envoi...';
  try {
    var docData = {
      name: _uploadMeta.name,
      size: _uploadMeta.size,
      type: _uploadMeta.type,
      data: _uploadB64,
      uploadedAt: new Date().toISOString()
    };
    _docsEmployee[_uploadDocId] = docData;
    // Sauvegarder dans Firestore (sur la fiche employé privée)
    var docsUpdate = {};
    docsUpdate['documentsEmployee'] = _docsEmployee;
    await window._setDocPath(['rh', _uid, 'employes', _empId], docsUpdate, {merge:true});
    closeUploadModal();
    renderDocuments();
    showToast('\u2705 Document d\u00e9pos\u00e9 avec succ\u00e8s','ok');
  } catch(e) {
    console.error(e);
    showToast('Erreur : '+e.message,'err');
    btn.disabled = false; btn.textContent = '\ud83d\udce4 Envoyer';
  }
}
window.submitUpload = submitUpload;

function viewDocIdx(btn) {
  var idx = parseInt(btn.getAttribute('data-idx'));
  var docDef = DOCS_REQUIRED[idx] || {};
  viewDoc(docDef.id);
}
window.viewDocIdx = viewDocIdx;

function viewDoc(docId) {
  var doc = _docsEmployee[docId];
  if(!doc || !doc.data) { showToast('Document non disponible','err'); return; }
  var win = window.open('','_blank');
  if(doc.type && doc.type.startsWith('image/')){
    win.document.write('<html><body style="margin:0;background:#111"><img src="'+doc.data+'" style="max-width:100%;display:block;margin:auto"/></body></html>');
  } else {
    win.location.href = doc.data;
  }
}
window.viewDoc = viewDoc;

function viewEmployerDoc(i) {
  var doc = _docsEmployer[i];
  if(!doc || !doc.data) { showToast('Document non disponible','err'); return; }
  var win = window.open('','_blank');
  if(doc.type && doc.type.startsWith('image/')){
    win.document.write('<html><body style="margin:0;background:#111"><img src="'+doc.data+'" style="max-width:100%;display:block;margin:auto"/></body></html>');
  } else {
    win.location.href = doc.data;
  }
}
window.viewEmployerDoc = viewEmployerDoc;

/* ══════════════════════════════════════════
   SOLDES DÉTAILLÉS (onglet congés)
══════════════════════════════════════════ */
function renderSoldesDetail() {
  var s = _soldes;
  var items = [
    {icon:'\ud83c\udfd6\ufe0f', label:'Cong\u00e9s pay\u00e9s', acquis:s.cpAcquis, pris:s.cpPris, restant:s.cpRestant, unit:'j', color:'var(--g3)'},
    {icon:'\u23f0', label:'RTT', acquis:s.rttBase, pris:s.rttPris, restant:s.rttRestant, unit:'j', color:'var(--blue)'},
    {icon:'\ud83d\udd04', label:'R\u00e9cup\u00e9ration', acquis:s.recupRestant, pris:0, restant:s.recupRestant, unit:'h', color:'var(--teal)'},
  ];
  document.getElementById('soldes-detail').innerHTML = items.map(function(it){
    var pct = it.acquis>0 ? Math.min(it.pris/it.acquis*100,100).toFixed(0) : 0;
    return '<div style="margin-bottom:12px;padding:10px 12px;background:#f9fafb;border-radius:10px;border:1px solid var(--border)">'
      +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">'
        +'<span style="font-size:12px;font-weight:700">'+it.icon+' '+it.label+'</span>'
        +'<span style="font-size:16px;font-weight:800;color:'+it.color+'">'+it.restant.toFixed(1)+'<span style="font-size:10px;font-weight:600"> '+it.unit+'</span></span>'
      +'</div>'
      +'<div style="height:6px;background:#e5e7eb;border-radius:99px;overflow:hidden;margin-bottom:5px">'
        +'<div style="height:100%;width:'+pct+'%;background:'+it.color+';border-radius:99px;transition:width .5s ease"></div>'
      +'</div>'
      +'<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted)">'
        +'<span>'+it.pris.toFixed(1)+' '+it.unit+' pris</span>'
        +'<span>'+it.acquis.toFixed(1)+' '+it.unit+' allou\u00e9s</span>'
      +'</div>'
    +'</div>';
  }).join('');
}

/* ══════════════════════════════════════════
   TYPE GRID (congés)
══════════════════════════════════════════ */
function renderTypeGrid() {
  var types = [
    {k:'cp',          sub: _soldes.cpRestant.toFixed(1)+'j disponibles'},
    {k:'rtt',         sub: _soldes.rttRestant.toFixed(1)+'j disponibles'},
    {k:'recuperation',sub:(_soldes.recupRestant||0)+'h disponibles'},
    {k:'css',         sub:'Non d\u00e9compt\u00e9 du solde'},
    {k:'evenement',   sub:'Dur\u00e9es l\u00e9gales'},
    {k:'maladie',     sub:'Arr\u00eat m\u00e9dical'},
    {k:'formation',   sub:'Formation professionnelle'},
  ];
  document.getElementById('type-grid').innerHTML = types.map(function(t) {
    return '<button class="tb '+((_selType===t.k)?'sel':'')+'" onclick="selType(\''+t.k+'\')">'
      +'<div class="tb-icon">'+ICONS[t.k]+'</div>'
      +'<span class="tb-lbl">'+LABELS[t.k]+'</span>'
      +'<span class="tb-sub">'+t.sub+'</span>'
      +'</button>';
  }).join('');
}

function setFilter(btn, f) {
  _demFilter = f;
  document.querySelectorAll('.ftab').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  renderDemandes();
}
window.setFilter = setFilter;

function renderDemandes() {
  var el = document.getElementById('dem-list');
  var cnt = document.getElementById('dem-count');
  var list = _demFilter === 'all' ? _demandes : _demandes.filter(function(d) { return d.statut === _demFilter; });
  cnt.textContent = _demandes.length+' demande'+(_demandes.length>1?'s':'');
  if (!list.length) { el.innerHTML='<div class="empty"><div class="empty-icon">\ud83d\udccb</div>Aucune demande.</div>'; return; }
  el.innerHTML = list.map(function(d){ return demItemHtml(d); }).join('');
}

function demItemHtml(d) {
  var db = d.dateDebut ? new Date(d.dateDebut+'T12:00:00').toLocaleDateString('fr-FR',{day:'numeric',month:'short',year:'numeric'}) : '?';
  var de = (d.dateFin && d.dateFin!==d.dateDebut) ? ' \u2192 '+new Date(d.dateFin+'T12:00:00').toLocaleDateString('fr-FR',{day:'numeric',month:'short'}) : '';
  var bTxt = {pending:'\u23f3 En attente',approved:'\u2705 Approuv\u00e9e',refused:'\u274c Refus\u00e9e',cancelled:'\ud83d\udeab Annul\u00e9e'}[d.statut] || d.statut;
  return '<div class="dem-item">'
    +'<div class="dem-ico" style="background:'+(COLORS[d.type]||'#6b7280')+'22">'+(ICONS[d.type]||'\ud83d\udccb')+'</div>'
    +'<div class="dem-body">'
      +'<div class="dem-name">'+(LABELS[d.type]||d.type)+' <strong style="color:'+(COLORS[d.type]||'var(--g3)')+'">'+(d.nbJours||0)+'j</strong></div>'
      +'<div class="dem-dates">'+db+de+'</div>'
      +(d.motif?'<div class="dem-motif">'+d.motif+'</div>':'')
      +(d.motifRefus?'<div class="dem-refus">Motif du refus : '+d.motifRefus+'</div>':'')
      +'<span class="badge badge-'+(d.statut||'pending')+'">'+bTxt+'</span>'
    +'</div>'
  +'</div>';
}

/* ══════════════════════════════════════════
   PLANNING & HORAIRES
══════════════════════════════════════════ */
function renderCal() {
  var y = _calMonth.getFullYear(), m = _calMonth.getMonth();
  var nb = new Date(y,m+1,0).getDate();
  var firstDow = (new Date(y,m,1).getDay()+6)%7;
  document.getElementById('cal-title').textContent = new Date(y,m,1).toLocaleDateString('fr-FR',{month:'long',year:'numeric'});
  var horaires = (_params && _params.horaires) || {
    lundi:{actif:true},mardi:{actif:true},mercredi:{actif:true},
    jeudi:{actif:true},vendredi:{actif:true},samedi:{actif:false},dimanche:{actif:false}
  };
  var absMap = {};
  _demandes.filter(function(d) { return d.statut==='approved'||d.statut==='pending'; }).forEach(function(d) {
    if (!d.dateDebut) return;
    var cur = new Date(d.dateDebut+'T12:00:00');
    var fin = new Date((d.dateFin||d.dateDebut)+'T12:00:00');
    while (cur <= fin) {
      if (cur.getFullYear()===y && cur.getMonth()===m)
        absMap[cur.getDate()] = {type:d.type, pending:d.statut==='pending'};
      cur.setDate(cur.getDate()+1);
    }
  });
  var today = new Date();
  var hdrs = ['L','M','M','J','V','S','D'];
  var calHtml = '';
  hdrs.forEach(function(h) { calHtml += '<div class="cal-hdr">'+h+'</div>'; });
  for (var i=0; i<firstDow; i++) calHtml += '<div></div>';
  var usedTypes = {};
  for (var d=1; d<=nb; d++) {
    var dow = (firstDow+d-1)%7;
    var jourKey = DOW_KEY[dow];
    var dateStr = y+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    var items = _planningCache[dateStr] || null;
    var hasPlan = items && items.length > 0;
    var abs = absMap[d];
    var isToday = d===today.getDate() && m===today.getMonth() && y===today.getFullYear();
    var bg='', col='', ttl='', cls='cal-day', extra='';
    if (isToday) cls += ' today';
    if (abs) {
      bg = abs.pending ? (COLORS[abs.type]+'cc') : COLORS[abs.type];
      col = 'white';
      ttl = LABELS[abs.type]+(abs.pending?' (en attente)':'');
      cls += ' abs'+(abs.pending?' abs-pending':'');
      usedTypes[abs.type] = true;
      if (hasPlan) extra = '<div style="font-size:7px;opacity:0.7;line-height:1;margin-top:2px">'+getPlagesStr(items[0])+'</div>';
    } else if (hasPlan) {
      var totalH = items.reduce(function(s,it) { return s + itemH(it); }, 0);
      bg = 'rgba(5,150,105,0.12)'; col = '#047857'; cls += ' work';
      ttl = getPlagesStr(items[0]) + ' (' + totalH.toFixed(1) + 'h)';
      extra = '<div style="font-size:7.5px;font-weight:700;line-height:1.2;margin-top:2px;opacity:0.85">'+getPlagesStr(items[0])+'</div>';
      usedTypes['__travail'] = true;
    } else if (horaires[jourKey] && horaires[jourKey].actif) {
      bg = 'rgba(5,150,105,0.06)'; col = '#6ee7b7'; cls += ' work work-generic';
      var h = horaires[jourKey];
      ttl = 'Horaire habituel'+(h.deb&&h.fin?' \u00b7 '+h.deb+' \u2013 '+h.fin:'');
    } else {
      bg = 'transparent'; col = '#d1d5db'; cls += ' off';
    }
    var style = 'background:'+bg+';color:'+col+';';
    if (isToday) style += 'outline:2px solid #059669;outline-offset:-2px;';
    calHtml += '<div class="'+cls+'" style="'+style+'" title="'+ttl+'">'+d+extra+'</div>';
  }
  document.getElementById('cal-grid').innerHTML = calHtml;
  var legHtml = '';
  if (Object.keys(_planningCache).length > 0)
    legHtml += '<div style="display:flex;align-items:center;gap:5px;font-size:10px;color:var(--muted)"><div style="width:9px;height:9px;border-radius:2px;background:rgba(5,150,105,0.4)"></div>Planifi\u00e9</div>';
  else
    legHtml += '<div style="display:flex;align-items:center;gap:5px;font-size:10px;color:var(--muted)"><div style="width:9px;height:9px;border-radius:2px;background:rgba(5,150,105,0.15)"></div>Horaire habituel</div>';
  legHtml += Object.keys(usedTypes).filter(function(t){ return t!=='__travail'; }).map(function(t) {
    return '<div style="display:flex;align-items:center;gap:5px;font-size:10px;color:var(--muted)"><div style="width:9px;height:9px;border-radius:2px;background:'+(COLORS[t]||'#6b7280')+'"></div>'+(LABELS[t]||t)+'</div>';
  }).join('');
  document.getElementById('cal-legend').innerHTML = legHtml;
}

function renderHoraires() {
  var horaires = (_params && _params.horaires) || {};
  var joursActifs = DOW_KEY.filter(function(j){ return horaires[j] && horaires[j].actif; });
  var card = document.getElementById('horaires-card');
  if(!joursActifs.length){ card.style.display='none'; return; }
  card.style.display='';
  var jLabels = {lundi:'Lundi',mardi:'Mardi',mercredi:'Mercredi',jeudi:'Jeudi',vendredi:'Vendredi',samedi:'Samedi',dimanche:'Dimanche'};
  document.getElementById('horaires-body').innerHTML = joursActifs.map(function(j){
    var h = horaires[j];
    return '<div class="info-line">'
      +'<span class="info-line-icon">\ud83d\udcc6</span>'
      +'<span class="info-line-label">'+jLabels[j]+'</span>'
      +'<span class="info-line-val" style="font-size:12px">'+(h.deb&&h.fin?h.deb+' \u2013 '+h.fin:'Actif')+'</span>'
    +'</div>';
  }).join('');
}

/* ══════════════════════════════════════════
   FORMULAIRE CONGÉS
══════════════════════════════════════════ */
var _curStep = 1;
var _justifB64 = null;
var _justifMeta = null;

function onJustifChange(input) {
  var file = input.files[0];
  if (!file) return;
  if (file.size > 5*1024*1024) { showToast('Fichier trop lourd (max 5 Mo)','err'); return; }
  var reader = new FileReader();
  reader.onload = function(e) {
    _justifB64 = e.target.result;
    _justifMeta = { name: file.name, size: file.size, type: file.type };
    document.getElementById('justif-name').textContent = file.name;
    document.getElementById('justif-size').textContent = (file.size/1024).toFixed(0)+'Ko';
    var prev = document.getElementById('justif-preview');
    prev.style.display = 'flex';
    document.getElementById('justif-drop').style.display = 'none';
  };
  reader.readAsDataURL(file);
}
window.onJustifChange = onJustifChange;

function clearJustif(e) {
  if (e) e.stopPropagation();
  _justifB64 = null; _justifMeta = null;
  var inp = document.getElementById('justif-input');
  if (inp) inp.value = '';
  document.getElementById('justif-preview').style.display = 'none';
  document.getElementById('justif-drop').style.display = '';
}
window.clearJustif = clearJustif;

function selType(k) {
  _selType = k;
  renderTypeGrid();
  document.getElementById('next1').disabled = false;
  document.getElementById('evenement-loi').className = 'alert alert-blue'+(k==='evenement'?' show':'');
  var jw = document.getElementById('justif-wrap');
  if (jw) jw.style.display = (k==='maladie' || k==='formation') ? '' : 'none';
  clearJustif();
}
window.selType = selType;

function goStep(n) {
  if (n===2 && !_selType) return;
  if (n===3) {
    var deb = document.getElementById('f-deb').value;
    if (!deb) { showToast('S\u00e9lectionnez une date de d\u00e9but','err'); return; }
    buildRecap();
  }
  _curStep = n;
  document.querySelectorAll('.form-step').forEach(function(e) { e.classList.remove('active'); });
  var st = document.getElementById('st'+n);
  if (st) st.classList.add('active');
  for (var i=1; i<=3; i++) {
    var dd = document.getElementById('s'+i);
    var ll = document.getElementById('sl'+i);
    if (dd) dd.className = 'step-dot'+(i<n?' done':i===n?' active':'');
    if (ll && i<3) ll.className = 'step-line'+(i<n?' done':'');
  }
  document.getElementById('step-lbl').textContent = '\u00c9tape '+n+' / 3';
}
window.goStep = goStep;

function joursOuvres(deb, fin) {
  if (!deb || !fin) return 0;
  var d = new Date(deb+'T12:00:00'), f = new Date(fin+'T12:00:00'), c = 0;
  while (d <= f) { var dw = d.getDay(); if (dw!==0 && dw!==6) c++; d.setDate(d.getDate()+1); }
  return c;
}

function onDateChg() {
  var deb = document.getElementById('f-deb').value;
  var fin = document.getElementById('f-fin').value;
  if (fin && fin < deb) { document.getElementById('f-fin').value = deb; fin = deb; }
  var ja = document.getElementById('jours-alert');
  var sa = document.getElementById('solde-alert');
  if (!deb) { ja.className='alert alert-green'; sa.className='alert alert-orange'; document.getElementById('next2').disabled=true; return; }
  var jours = joursOuvres(deb, fin||deb);
  ja.textContent = '\ud83d\udcc5 '+jours+' jour'+(jours>1?'s':'')+' ouvr\u00e9'+(jours>1?'s':'');
  ja.className = 'alert alert-green show';
  document.getElementById('next2').disabled = false;
  var sk = SOLDE_K[_selType];
  if (sk && _soldes[sk] !== undefined) {
    var solde = parseFloat(_soldes[sk]) || 0;
    if (jours > solde) {
      sa.textContent = '\u26a0\ufe0f Solde insuffisant : '+solde.toFixed(1)+(_selType==='recuperation'?'h':'j')+' disponibles, '+jours+'j demand\u00e9s';
      sa.className = 'alert alert-orange show';
    } else sa.className = 'alert alert-orange';
  } else sa.className = 'alert alert-orange';
}
window.onDateChg = onDateChg;

function buildRecap() {
  var deb    = document.getElementById('f-deb').value;
  var fin    = document.getElementById('f-fin').value || deb;
  var motif  = document.getElementById('f-motif').value.trim();
  var jours  = joursOuvres(deb, fin);
  var debFmt = new Date(deb+'T12:00:00').toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  var finFmt = new Date(fin+'T12:00:00').toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long'});
  var sk     = SOLDE_K[_selType];
  var solde  = (sk !== undefined) ? (parseFloat(_soldes[sk])||0) : null;
  var apres  = solde !== null ? Math.max(0, solde-jours) : null;
  var rw     = document.getElementById('recap-warn');
  if (solde !== null && jours > solde) {
    rw.textContent = '\u26a0\ufe0f Solde insuffisant ('+solde.toFixed(1)+'j dispo). Votre employeur en sera inform\u00e9.';
    rw.className = 'alert alert-orange show';
  } else rw.className = 'alert alert-orange';
  document.getElementById('recap').innerHTML =
    '<div class="resume-row"><span>Type</span><span>'+ICONS[_selType]+' '+LABELS[_selType]+'</span></div>'
    +'<div class="resume-row"><span>Du</span><span>'+debFmt+'</span></div>'
    +'<div class="resume-row"><span>Au</span><span>'+finFmt+'</span></div>'
    +(motif?'<div class="resume-row"><span>Motif</span><span>'+motif+'</span></div>':'')
    +'<div class="resume-row"><span>Total</span><span style="color:var(--g3)">'+jours+' jour'+(jours>1?'s':'')+' ouvr\u00e9'+(jours>1?'s':'')+'</span></div>'
    +(apres!==null?'<div class="resume-row"><span>Solde apr\u00e8s</span><span style="color:'+(apres>5?'var(--g3)':'var(--orange)')+'">'+apres.toFixed(1)+'j</span></div>':'')
    +(_justifB64?'<div class="resume-row"><span>Justificatif</span><span style="color:var(--g3)">\ud83d\udcce '+(_justifMeta?_justifMeta.name:'Fichier joint')+'</span></div>':'');
}

async function submitDemande() {
  var deb   = document.getElementById('f-deb').value;
  var fin   = document.getElementById('f-fin').value || deb;
  var motif = document.getElementById('f-motif').value.trim();
  var jours = joursOuvres(deb, fin);
  var btn = document.getElementById('btn-submit');
  btn.disabled = true; btn.textContent = 'Envoi\u2026';
  var demandeData = {
    empId:_empId, uid:_uid, type:_selType, dateDebut:deb, dateFin:fin, nbJours:jours,
    statut:'pending', motif:motif||null,
    createdAt:new Date().toISOString(), source:'salarie',
  };
  if (_justifB64 && _justifMeta) {
    demandeData.justificatif = { data:_justifB64, name:_justifMeta.name, size:_justifMeta.size, type:_justifMeta.type };
  }
  try {
    await window._addDoc(['rh_conges', _uid, 'demandes'], demandeData);
    _demandes.unshift({id:'tmp_'+Date.now(),empId:_empId,type:_selType,dateDebut:deb,dateFin:fin,nbJours:jours,statut:'pending',motif:motif||null,createdAt:new Date().toISOString()});
    calcSoldes(); renderSoldesFlottants(); renderDemandes(); renderCal(); renderAccueil();
    document.getElementById('st3').classList.remove('active');
    var sw = document.getElementById('success-wrap');
    sw.style.display = 'flex'; sw.classList.add('show');
    document.getElementById('success-sub').textContent = 'Votre demande de '+jours+'j ('+LABELS[_selType]+') a \u00e9t\u00e9 transmise. Votre employeur la traitera prochainement.';
  } catch(e) {
    console.error(e); showToast('Erreur : '+e.message, 'err');
    btn.disabled = false; btn.textContent = '\u2709\ufe0f Envoyer la demande';
  }
}
window.submitDemande = submitDemande;

function resetForm() {
  _selType = ''; _curStep = 1;
  var sw = document.getElementById('success-wrap');
  sw.style.display = 'none'; sw.classList.remove('show');
  document.getElementById('f-deb').value = '';
  document.getElementById('f-fin').value = '';
  document.getElementById('f-motif').value = '';
  document.getElementById('jours-alert').className = 'alert alert-green';
  document.getElementById('solde-alert').className = 'alert alert-orange';
  document.getElementById('next1').disabled = true;
  document.getElementById('next2').disabled = true;
  clearJustif();
  var jw = document.getElementById('justif-wrap');
  if (jw) jw.style.display = 'none';
  goStep(1); renderTypeGrid();
}
window.resetForm = resetForm;

/* ══════════════════════════════════════════
   NAVIGATION ONGLETS
══════════════════════════════════════════ */
function showTab(id, btn) {
  document.querySelectorAll('.tab-section').forEach(function(s){ s.classList.remove('active'); });
  document.querySelectorAll('.tnav').forEach(function(b){ b.classList.remove('active'); });
  var sec = document.getElementById('tab-'+id);
  if(sec) sec.classList.add('active');
  if(btn) btn.classList.add('active');
}
window.showTab = showTab;

function goTab(btn) {
  var tab = btn.getAttribute('data-tab');
  var el = document.querySelector('.tnav[onclick*="' + tab + '"]');
  showTab(tab, el);
}
window.goTab = goTab;


/* ══════════════════════════════════════════
   UTILS
══════════════════════════════════════════ */
function changeYear() {
  var v = prompt('Ann\u00e9e \u00e0 afficher :', _year);
  var n = parseInt(v)||0;
  if (n>=2020 && n<=2030) {
    _year = n;
    document.getElementById('year-lbl').textContent = _year;
    document.getElementById('accueil-annee-lbl').textContent = '\u2014 '+_year;
    document.getElementById('conges-annee-lbl').textContent = '\u2014 '+_year;
    calcSoldes(); renderSoldesFlottants(); renderAccueil(); renderSoldesDetail(); renderDemandes();
  }
}
window.changeYear = changeYear;

function prevM() {
  _calMonth.setMonth(_calMonth.getMonth()-1);
  loadPlanningMonth(_calMonth.getFullYear(), _calMonth.getMonth()).then(renderCal);
}
function nextM() {
  _calMonth.setMonth(_calMonth.getMonth()+1);
  loadPlanningMonth(_calMonth.getFullYear(), _calMonth.getMonth()).then(renderCal);
}
window.prevM = prevM; window.nextM = nextM;

function fmtDate(s) {
  if(!s) return '\u2014';
  try { return new Date(s+'T12:00:00').toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit',year:'numeric'}); } catch(e){ return s; }
}

function calcAnciennete(dateStr) {
  if(!dateStr) return '';
  var d = new Date(dateStr+'T12:00:00');
  var now = new Date();
  var mois = (now.getFullYear()-d.getFullYear())*12 + (now.getMonth()-d.getMonth());
  if(mois<1) return 'Nouveau';
  if(mois<12) return mois+' mois';
  var ans = Math.floor(mois/12);
  var rm = mois%12;
  return ans+'an'+(ans>1?'s':'')+(rm>0?' '+rm+'m':'');
}

function maskIban(iban) {
  if(!iban || iban.length<8) return iban;
  return iban.slice(0,4) + ' **** **** ' + iban.slice(-4);
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase()+s.slice(1) : s; }

function getPlagesStr(it) {
  if (!it) return '';
  if (it.plages && it.plages.length > 0) return it.plages.map(function(p){ return p.deb+'\u2013'+p.fin; }).join(' | ');
  return (it.deb||'') + (it.fin ? '\u2013'+it.fin : '');
}

function itemH(it) {
  if (it.plages && it.plages.length > 0) {
    return it.plages.reduce(function(s,p) {
      if (!p.deb||!p.fin) return s;
      var a=p.deb.split(':').map(Number), b=p.fin.split(':').map(Number);
      return s + Math.max(0, ((b[0]*60+b[1])-(a[0]*60+a[1]))/60);
    }, 0);
  }
  if (!it.deb||!it.fin) return 0;
  var a=it.deb.split(':').map(Number), b=it.fin.split(':').map(Number);
  return Math.max(0, ((b[0]*60+b[1])-(a[0]*60+a[1]))/60);
}

function showNotFound() {
  document.getElementById('loading-wrap').style.display = 'none';
  document.getElementById('not-found').classList.add('show');
}

function showToast(msg, type) {
  var t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show '+(type||'');
  setTimeout(function() { t.className='toast'; }, 3200);
}