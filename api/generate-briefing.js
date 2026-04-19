// api/generate-briefing.js
// ══════════════════════════════════════════════════════════════════
// WAVE 4.1 — Génération du briefing matinal quotidien
//
// Génère un briefing personnalisé pour un user avec addon Léa :
//   1. Collecte : données pilotage (hier), CA 30 derniers jours, banque,
//      stock (ruptures), RH (congés du jour), dettes (échéances proches)
//   2. Calcul score santé (0-100) : tréso + marge + tendance CA + ruptures
//   3. Détection alertes : tréso tendue, ruptures imminentes, pic/chute CA
//   4. Génération par Claude Sonnet : résumé veille + 2-4 actions du jour
//   5. Stockage dans agent/{uid}/briefings/{YYYY-MM-DD}
//
// Utilisations :
//   - Appelé par le cron quotidien (Wave 4.3) → génère pour tous les users
//     avec hasAgentFullAccess
//   - Appel direct authentifié → génère pour 1 user spécifique (test/manuel)
//
// Appels prévus (Wave 4.2 et 4.3) :
//   - envoi email Resend (Wave 4.2)
//   - envoi SMS (Wave 4.2, optionnel selon quota)
//   - notification push PWA (Wave 4.3)
//
// Sécurité :
//   - Appel interne (cron) : header x-cron-secret = CRON_SECRET
//   - Appel authentifié user : Authorization Bearer <idToken>
// ══════════════════════════════════════════════════════════════════

const FIREBASE_PROJECT = 'altiora-70599';
const FB_KEY = 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

const CLAUDE_MODEL = 'claude-sonnet-4-5-20250929';
const CLAUDE_MAX_TOKENS = 1500;

// ══════════════════════════════════════════════════════════════════
// FIREBASE REST HELPERS (admin auth)
// ══════════════════════════════════════════════════════════════════

let _adminToken = null;
let _adminTokenExp = 0;

async function getAdminToken() {
  if (_adminToken && Date.now() < _adminTokenExp - 300000) return _adminToken;
  const fbKey = process.env.FIREBASE_API_KEY || FB_KEY;
  const email = process.env.FIREBASE_API_EMAIL;
  const password = process.env.FIREBASE_API_PASSWORD;
  if (!email || !password) {
    console.error('[briefing] Credentials admin manquants');
    return null;
  }
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${fbKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) }
  );
  const data = await r.json();
  if (data.idToken) {
    _adminToken = data.idToken;
    _adminTokenExp = Date.now() + (parseInt(data.expiresIn || '3600') * 1000);
    return _adminToken;
  }
  console.error('[briefing] Admin login failed:', data.error?.message);
  return null;
}

function authHeaders(token) {
  return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
}

async function fsGet(path, token) {
  const res = await fetch(`${FS_BASE}/${path}`, { headers: authHeaders(token) });
  if (!res.ok) return null;
  return res.json();
}

async function fsList(parentPath, token, pageSize = 100) {
  const res = await fetch(`${FS_BASE}/${parentPath}?pageSize=${pageSize}`, { headers: authHeaders(token) });
  if (!res.ok) return null;
  return res.json();
}

async function fsCreateWithId(parentPath, docId, data, token) {
  const fields = {};
  for (const [k, v] of Object.entries(data)) fields[k] = toFsValue(v);
  const res = await fetch(
    `${FS_BASE}/${parentPath}?documentId=${encodeURIComponent(docId)}`,
    { method: 'POST', headers: authHeaders(token), body: JSON.stringify({ fields }) }
  );
  if (!res.ok) {
    // Si doc existe déjà → PATCH
    if (res.status === 409) {
      const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
      const patchRes = await fetch(
        `${FS_BASE}/${parentPath}/${encodeURIComponent(docId)}?${mask}`,
        { method: 'PATCH', headers: authHeaders(token), body: JSON.stringify({ fields }) }
      );
      if (!patchRes.ok) throw new Error('fsPatch failed: ' + (await patchRes.text()).slice(0, 200));
      return patchRes.json();
    }
    throw new Error('fsCreate failed: ' + (await res.text()).slice(0, 200));
  }
  return res.json();
}

function toFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) fields[k] = toFsValue(val);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function docToObject(doc) {
  if (!doc || !doc.fields) return {};
  const obj = {};
  for (const [k, v] of Object.entries(doc.fields)) obj[k] = fromFsValue(v);
  return obj;
}

function fromFsValue(v) {
  if (!v) return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ('mapValue' in v) {
    const obj = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) obj[k] = fromFsValue(val);
    return obj;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════
// COLLECTE DES DONNÉES USER
// ══════════════════════════════════════════════════════════════════

function fmtDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function fmtDateFr(d) {
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
}

// Collecte les données du user pour générer le briefing
async function collectBriefingData(uid, token) {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
  const todayKey = fmtDate(now);
  const yesterdayKey = fmtDate(yesterday);
  const monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthKey = prevMonthDate.getFullYear() + '-' + String(prevMonthDate.getMonth() + 1).padStart(2, '0');

  const data = {
    date: todayKey,
    yesterday: yesterdayKey,
    jour_semaine: ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'][now.getDay()],
  };

  // ── Profil entreprise ──
  const profilDoc = await fsGet(`profil/${uid}/data/profil`, token);
  if (profilDoc) {
    const p = docToObject(profilDoc);
    data.entreprise = {
      nom: p.raisonSociale || p.nomEntreprise || null,
      activite: p.activite || p.typeActivite || null,
      secteur: p.secteur || null,
    };
  }

  // ── Pilotage mois courant ──
  const pilotageDoc = await fsGet(`pilotage/${uid}/months/${monthKey}`, token);
  const pilotage = pilotageDoc ? docToObject(pilotageDoc) : {};

  // Calcul CA mois et CA hier
  let caMoisHt = 0, caHier = 0;
  if (Array.isArray(pilotage.ca)) {
    for (const row of pilotage.ca) {
      const h055 = parseFloat(row.ht055) || 0;
      const h10  = parseFloat(row.ht10) || 0;
      const h20  = parseFloat(row.ht20) || 0;
      const multi = h055 + h10 + h20;
      const ht = multi > 0 ? multi : (parseFloat(row.montantHT) || 0);
      caMoisHt += ht;
      // Ligne d'hier ?
      const rowDate = String(row.date || '');
      const expectedYesterday = yesterday.getDate() + '/' + (yesterday.getMonth() + 1) + '/' + yesterday.getFullYear();
      if (rowDate === expectedYesterday) caHier = ht;
    }
  }
  data.ca_mois_ht = Math.round(caMoisHt * 100) / 100;
  data.ca_hier_ht = Math.round(caHier * 100) / 100;

  // Charges mois
  const chargesFixes = (pilotage.chargesFixe || []).reduce(function (s, r) { return s + (parseFloat(r.montantHT || r.montant) || 0); }, 0);
  const chargesVar = (pilotage.chargesVar || []).reduce(function (s, r) { return s + (parseFloat(r.montantHT || r.montant) || 0); }, 0);
  data.charges_fixes_mois = Math.round(chargesFixes * 100) / 100;
  data.charges_variables_mois = Math.round(chargesVar * 100) / 100;

  const credits = (pilotage.credits || []).reduce(function (s, r) { return s + (parseFloat(r.mensualite || r.montant) || 0); }, 0);
  const leasing = (pilotage.leasing || []).reduce(function (s, r) { return s + (parseFloat(r.mensualite || r.montant) || 0); }, 0);
  data.credits_mensuel = Math.round(credits * 100) / 100;
  data.leasing_mensuel = Math.round(leasing * 100) / 100;

  // ── Pilotage mois précédent (pour comparaison) ──
  try {
    const prevDoc = await fsGet(`pilotage/${uid}/months/${prevMonthKey}`, token);
    if (prevDoc) {
      const prev = docToObject(prevDoc);
      let caPrev = 0;
      if (Array.isArray(prev.ca)) {
        for (const row of prev.ca) {
          const h055 = parseFloat(row.ht055) || 0;
          const h10  = parseFloat(row.ht10) || 0;
          const h20  = parseFloat(row.ht20) || 0;
          const multi = h055 + h10 + h20;
          caPrev += multi > 0 ? multi : (parseFloat(row.montantHT) || 0);
        }
      }
      data.ca_mois_precedent = Math.round(caPrev * 100) / 100;
      // Même jour mois précédent
      let caHierMoisPrev = 0;
      if (Array.isArray(prev.ca)) {
        const sameDayInPrev = new Date(prevMonthDate.getFullYear(), prevMonthDate.getMonth(), yesterday.getDate());
        const expected = sameDayInPrev.getDate() + '/' + (sameDayInPrev.getMonth() + 1) + '/' + sameDayInPrev.getFullYear();
        for (const row of prev.ca) {
          if (String(row.date) === expected) {
            const h055 = parseFloat(row.ht055) || 0;
            const h10  = parseFloat(row.ht10) || 0;
            const h20  = parseFloat(row.ht20) || 0;
            const multi = h055 + h10 + h20;
            caHierMoisPrev = multi > 0 ? multi : (parseFloat(row.montantHT) || 0);
            break;
          }
        }
      }
      data.ca_meme_jour_mois_precedent = Math.round(caHierMoisPrev * 100) / 100;
    }
  } catch (e) { /* skip */ }

  // ── Trésorerie (solde de départ configuré) ──
  try {
    const cashDoc = await fsGet(`cashflow/${uid}/config/tresorerie`, token);
    if (cashDoc) {
      const c = docToObject(cashDoc);
      data.solde_treso_depart = typeof c.solde === 'number' ? c.solde : parseFloat(c.solde) || null;
      data.date_solde_depart = c.date || null;
    }
  } catch (e) { /* skip */ }

  // ── Banque (solde réel le plus à jour) ──
  try {
    const banksRes = await fsList(`bank_connections/${uid}/banks`, token, 10);
    if (banksRes?.documents) {
      let soldeTotal = 0;
      let nbComptes = 0;
      for (const d of banksRes.documents) {
        const b = docToObject(d);
        const accounts = b.accounts || [];
        for (const acc of accounts) {
          if (typeof acc.balance === 'number' || typeof acc.solde === 'number') {
            soldeTotal += acc.balance || acc.solde || 0;
            nbComptes++;
          }
        }
      }
      if (nbComptes > 0) {
        data.solde_banque_actuel = Math.round(soldeTotal * 100) / 100;
        data.nombre_comptes_bancaires = nbComptes;
      }
    }
  } catch (e) { /* skip */ }

  // ── Stock : ruptures ──
  try {
    const prodRes = await fsList(`stock/${uid}/products`, token, 500);
    const movRes = await fsList(`stock/${uid}/movements`, token, 500);
    if (prodRes?.documents) {
      const movs = (movRes?.documents || []).map(d => docToObject(d));
      const ruptures = [];
      const bas = [];
      for (const d of prodRes.documents) {
        const p = docToObject(d);
        if (!p.name) continue;
        // Calcul stock actuel
        let qty = parseFloat(p.stockBase) || 0;
        for (const m of movs) {
          if ((m.ref || '').toLowerCase() !== (p.ref || '').toLowerCase()) continue;
          if (m.type === 'ADJUST') qty = parseFloat(m.qty) || 0;
          else if (m.type === 'IN' || m.type === 'RETURN_IN') qty += parseFloat(m.qty) || 0;
          else if (m.type === 'OUT' || m.type === 'LOSS' || m.type === 'RETURN_OUT') qty -= parseFloat(m.qty) || 0;
        }
        if (qty <= 0) ruptures.push({ nom: p.name, ref: p.ref });
        else if (qty <= 3) bas.push({ nom: p.name, ref: p.ref, quantite: qty });
      }
      data.stock_ruptures = ruptures.slice(0, 10);
      data.stock_bas = bas.slice(0, 10);
      data.nombre_ruptures = ruptures.length;
      data.nombre_stock_bas = bas.length;
    }
  } catch (e) { /* skip */ }

  // ── RH : congés du jour / cette semaine ──
  try {
    const congesRes = await fsList(`rh_conges/${uid}/demandes`, token, 100);
    if (congesRes?.documents) {
      // Récupérer les noms des employés
      const empRes = await fsList(`rh/${uid}/employes`, token, 100);
      const empMap = {};
      if (empRes?.documents) {
        for (const d of empRes.documents) {
          const data = docToObject(d);
          const id = (d.name || '').split('/').pop();
          empMap[id] = (data.prenom || '') + ' ' + (data.nom || '');
        }
      }
      const today = fmtDate(now);
      const in7days = fmtDate(new Date(now.getTime() + 7 * 24 * 3600 * 1000));
      const enAttente = [];
      const aujourdhui = [];
      const semaine = [];
      for (const d of congesRes.documents) {
        const c = docToObject(d);
        const debut = c.dateDebut || '';
        const fin = c.dateFin || debut;
        const statut = c.statut || 'en_attente';
        const empName = empMap[c.employeId || c.employe] || '?';
        if (statut === 'en_attente') {
          enAttente.push({ employe: empName, debut, fin, type: c.type || 'CP' });
        }
        if (statut === 'approuve' && debut && fin) {
          if (debut <= today && today <= fin) {
            aujourdhui.push({ employe: empName, type: c.type || 'CP', fin });
          }
          if (debut > today && debut <= in7days) {
            semaine.push({ employe: empName, type: c.type || 'CP', debut });
          }
        }
      }
      data.conges_aujourdhui = aujourdhui;
      data.conges_a_venir_7j = semaine.slice(0, 10);
      data.conges_en_attente = enAttente.slice(0, 10);
    }
  } catch (e) { /* skip */ }

  // ── Dettes : échéances proches (emprunts, leasings) ──
  try {
    const dettesDoc = await fsGet(`dettes/${uid}/data/all`, token);
    if (dettesDoc) {
      const dObj = docToObject(dettesDoc);
      const list = Array.isArray(dObj.list) ? dObj.list : [];
      const actives = list.filter(d => d.active !== false);
      const mensualitesTotal = actives.reduce(function (s, d) {
        if (d.type === 'emprunt') {
          const mens = d.mensualite ? parseFloat(d.mensualite) : (d.montant && d.duree ? d.montant / d.duree : 0);
          return s + (mens || 0);
        }
        if (d.type === 'leasing') return s + (parseFloat(d.loyer) || 0);
        return s;
      }, 0);
      data.mensualites_credits_leasings = Math.round(mensualitesTotal * 100) / 100;
      data.nombre_emprunts_actifs = actives.filter(d => d.type === 'emprunt').length;
      data.nombre_leasings_actifs = actives.filter(d => d.type === 'leasing').length;
    }
  } catch (e) { /* skip */ }

  // ── Fidélisation (briefing client) ──
  try {
    const clientsRes = await fsList(`fidelite/${uid}/clients`, token, 500);
    if (clientsRes?.documents) {
      const clients = clientsRes.documents.map(d => docToObject(d));
      const SIXTY_DAYS_MS = 60 * 24 * 3600 * 1000;
      const nowTs = Date.now();
      const actifs = clients.filter(c => {
        const last = c.lastVisit || c.dernierPassage;
        if (!last) return false;
        const diff = nowTs - new Date(last).getTime();
        return diff <= SIXTY_DAYS_MS;
      });
      data.nombre_clients_fid = clients.length;
      data.nombre_clients_actifs = actifs.length;
    }
  } catch (e) { /* skip */ }

  return data;
}

// ══════════════════════════════════════════════════════════════════
// CALCUL SCORE SANTÉ
// ══════════════════════════════════════════════════════════════════

// Score 0-100 : 40 pts tréso, 25 pts tendance CA, 20 pts ruptures stock, 15 pts marge
function computeHealthScore(data) {
  let score = 0;
  const details = {};

  // ── Trésorerie (40 pts) ──
  // Si solde banque > mensualités × 3 → 40, dégressif jusqu'à 0 si solde < 0
  const solde = data.solde_banque_actuel !== undefined ? data.solde_banque_actuel : data.solde_treso_depart;
  const chargesMensuelles = (data.charges_fixes_mois || 0) + (data.credits_mensuel || 0) + (data.leasing_mensuel || 0);
  if (solde !== null && solde !== undefined) {
    if (chargesMensuelles > 0) {
      const ratio = solde / chargesMensuelles;
      if (ratio >= 3) { score += 40; details.treso = 'solide (3+ mois de réserve)'; }
      else if (ratio >= 1.5) { score += 30; details.treso = 'saine (1.5-3 mois)'; }
      else if (ratio >= 0.5) { score += 15; details.treso = 'tendue (0.5-1.5 mois)'; }
      else if (ratio >= 0) { score += 5; details.treso = 'critique (< 2 semaines)'; }
      else { score += 0; details.treso = 'négative'; }
    } else {
      if (solde > 0) { score += 25; details.treso = 'positive, pas de charges récurrentes connues'; }
      else { score += 0; details.treso = 'négative'; }
    }
  } else {
    score += 20; // neutre si pas de données
    details.treso = 'non configurée';
  }

  // ── Tendance CA (25 pts) ──
  // Comparaison CA mois courant vs mois précédent à jour équivalent
  if (data.ca_hier_ht !== undefined && data.ca_meme_jour_mois_precedent !== undefined && data.ca_meme_jour_mois_precedent > 0) {
    const ratio = data.ca_hier_ht / data.ca_meme_jour_mois_precedent;
    if (ratio >= 1.1) { score += 25; details.ca_tendance = `+${Math.round((ratio - 1) * 100)}% vs mois dernier (jour équivalent)`; }
    else if (ratio >= 0.95) { score += 20; details.ca_tendance = 'stable vs mois dernier'; }
    else if (ratio >= 0.8) { score += 12; details.ca_tendance = `${Math.round((ratio - 1) * 100)}% vs mois dernier`; }
    else { score += 5; details.ca_tendance = `en baisse de ${Math.round((1 - ratio) * 100)}% vs mois dernier`; }
  } else if (data.ca_hier_ht > 0) {
    score += 15;
    details.ca_tendance = 'pas assez d\'historique pour comparer';
  } else {
    score += 10;
    details.ca_tendance = 'pas de CA hier';
  }

  // ── Stock (20 pts) ──
  const rup = data.nombre_ruptures || 0;
  const bas = data.nombre_stock_bas || 0;
  if (rup === 0 && bas === 0) { score += 20; details.stock = 'OK'; }
  else if (rup === 0 && bas <= 3) { score += 15; details.stock = `${bas} produit(s) en stock bas`; }
  else if (rup <= 2) { score += 10; details.stock = `${rup} rupture(s), ${bas} stock bas`; }
  else { score += 3; details.stock = `${rup} ruptures, ${bas} stock bas — action urgente`; }

  // ── Marge indicative (15 pts) ──
  // Basé sur CA mois - charges variables (approximation grossière)
  if (data.ca_mois_ht > 0) {
    const margeBrute = data.ca_mois_ht - (data.charges_variables_mois || 0);
    const margePct = (margeBrute / data.ca_mois_ht) * 100;
    if (margePct >= 70) { score += 15; details.marge = `${Math.round(margePct)}% (excellente)`; }
    else if (margePct >= 50) { score += 12; details.marge = `${Math.round(margePct)}% (correcte)`; }
    else if (margePct >= 30) { score += 8; details.marge = `${Math.round(margePct)}% (faible)`; }
    else { score += 3; details.marge = `${Math.round(margePct)}% (très faible)`; }
  } else {
    score += 7; // neutre
    details.marge = 'pas encore calculable ce mois';
  }

  return { score: Math.round(score), details };
}

// ══════════════════════════════════════════════════════════════════
// DÉTECTION ALERTES
// ══════════════════════════════════════════════════════════════════

function detectAlerts(data, health) {
  const alerts = [];

  // Tréso critique
  const solde = data.solde_banque_actuel !== undefined ? data.solde_banque_actuel : data.solde_treso_depart;
  const chargesMensuelles = (data.charges_fixes_mois || 0) + (data.credits_mensuel || 0) + (data.leasing_mensuel || 0);
  if (solde !== null && solde !== undefined) {
    if (solde < 0) {
      alerts.push({ niveau: 'critique', type: 'treso', message: `Trésorerie négative (${solde}€). Action immédiate requise.` });
    } else if (chargesMensuelles > 0 && solde / chargesMensuelles < 0.5) {
      alerts.push({ niveau: 'alerte', type: 'treso', message: `Trésorerie tendue : ${solde}€ pour ${Math.round(chargesMensuelles)}€ de charges mensuelles.` });
    }
  }

  // Ruptures stock
  if ((data.nombre_ruptures || 0) >= 3) {
    alerts.push({ niveau: 'alerte', type: 'stock', message: `${data.nombre_ruptures} produits en rupture.` });
  }

  // Chute CA
  if (data.ca_hier_ht !== undefined && data.ca_meme_jour_mois_precedent > 0) {
    const ratio = data.ca_hier_ht / data.ca_meme_jour_mois_precedent;
    if (ratio < 0.6) {
      alerts.push({ niveau: 'alerte', type: 'ca', message: `CA d'hier en baisse de ${Math.round((1 - ratio) * 100)}% vs même jour mois précédent.` });
    }
  }

  // Congés en attente à traiter
  if ((data.conges_en_attente || []).length > 0) {
    alerts.push({ niveau: 'info', type: 'rh', message: `${data.conges_en_attente.length} demande(s) de congé en attente de ta décision.` });
  }

  // Absences du jour
  if ((data.conges_aujourdhui || []).length > 0) {
    const noms = data.conges_aujourdhui.map(c => c.employe).join(', ');
    alerts.push({ niveau: 'info', type: 'rh', message: `Absent(s) aujourd'hui : ${noms}.` });
  }

  return alerts;
}

// ══════════════════════════════════════════════════════════════════
// GÉNÉRATION DU BRIEFING PAR CLAUDE
// ══════════════════════════════════════════════════════════════════

async function generateBriefingText(data, health, alerts, prenom) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY manquante');

  const prompt = `Tu es Léa, l'assistante IA business du dirigeant. Génère son briefing matinal du ${data.date} (${data.jour_semaine}).

# DONNÉES DU JOUR
${JSON.stringify({ data, health, alerts }, null, 2)}

# INSTRUCTIONS

Génère un briefing structuré au format JSON strict avec cette structure exacte :

{
  "salutation": "Bonjour ${prenom || '[prénom]'}, ...",   // 1 phrase chaleureuse + météo business
  "resume_veille": "...",                                  // 2-3 phrases : ce qu'il s'est passé hier
  "points_cles": [                                         // 3-5 points factuels avec chiffres
    { "emoji": "💰", "label": "CA hier", "valeur": "XXX €", "tendance": "+X% vs mois dernier" },
    ...
  ],
  "alertes": [                                             // 0-3 alertes importantes
    { "niveau": "critique|alerte|info", "message": "..." }
  ],
  "actions_du_jour": [                                     // 2-4 actions prioritaires
    { "emoji": "✅", "titre": "Titre court", "detail": "Description courte" }
  ],
  "conclusion": "..."                                      // 1 phrase motivante ou conseil
}

# RÈGLES

- Ton : tutoiement, professionnel mais chaleureux, direct comme un DAF humain
- Longueur totale : max 200 mots tout compris (briefing matinal = concis)
- Chiffres : formate en français (15 420,50 €, 12,5 %)
- Si aucune donnée (boîte qui démarre) : briefing court d'encouragement
- Priorise la TRÉSORERIE et les ALERTES en premier
- Actions du jour : concrètes et réalisables dans la journée
- NE JAMAIS inventer des chiffres qui ne sont pas dans les données
- N'emploie PAS de markdown (pas de **, pas de #) — ce sera rendu en HTML

Réponds UNIQUEMENT avec le JSON, sans préambule ni commentaire.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: CLAUDE_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const out = await res.json();
  if (!res.ok) {
    throw new Error('Claude API: ' + (out.error?.message || JSON.stringify(out).slice(0, 200)));
  }
  if (out.stop_reason === 'max_tokens') {
    throw new Error('Réponse Claude tronquée (max_tokens atteint)');
  }
  const text = (out.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  // Extraire le JSON (Claude peut encadrer en ```json ... ```)
  let jsonStr = text;
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) jsonStr = codeBlock[1].trim();
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    throw new Error('JSON invalide de Claude: ' + e.message + ' — réponse: ' + text.slice(0, 300));
  }
}

// ══════════════════════════════════════════════════════════════════
// ORCHESTRATION : génération complète pour un user
// ══════════════════════════════════════════════════════════════════

async function generateForUser(uid, token) {
  // 1. Récupérer les infos user
  const userDoc = await fsGet(`users/${uid}`, token);
  if (!userDoc) throw new Error('User introuvable');
  const user = docToObject(userDoc);

  const prenom = (user.name || user.firstName || '').split(' ')[0] || '';
  const email = user.email || null;

  // 2. Collecter les données business
  const data = await collectBriefingData(uid, token);

  // 3. Calcul score + alertes
  const health = computeHealthScore(data);
  const alerts = detectAlerts(data, health);

  // 4. Génération par Claude
  const briefing = await generateBriefingText(data, health, alerts, prenom);

  // 5. Sauvegarde dans agent/{uid}/briefings/{YYYY-MM-DD}
  const briefingDoc = {
    date: data.date,
    jour_semaine: data.jour_semaine,
    score_sante: health.score,
    score_details: health.details,
    alertes: alerts,
    briefing: briefing,
    raw_data: data,
    generated_at: new Date().toISOString(),
    delivered_email: false,
    delivered_sms: false,
    delivered_push: false,
  };
  await fsCreateWithId(`agent/${uid}/briefings`, data.date, briefingDoc, token);

  return {
    uid,
    date: data.date,
    score: health.score,
    nombre_alertes: alerts.length,
    briefing,
    email,
    prenom,
  };
}

// ══════════════════════════════════════════════════════════════════
// HANDLER HTTP
// ══════════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  // CORS
  const origin = req.headers.origin || '';
  if (['https://alteore.com', 'https://www.alteore.com', 'http://localhost:3000'].includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-cron-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const cronSecret = req.headers['x-cron-secret'];
    const isCron = cronSecret && cronSecret === process.env.CRON_SECRET;

    let uid = null;

    if (isCron) {
      // Appel cron : uid peut être dans le body (pour tester un user spécifique)
      uid = req.body?.uid || null;
      if (!uid) return res.status(400).json({ error: 'uid requis dans le body pour appel cron single-user' });
    } else {
      // Appel authentifié user
      const authHeader = req.headers.authorization || '';
      const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (!idToken) return res.status(401).json({ error: 'Non authentifié' });

      // Vérifier le token user
      const fbKey = process.env.FIREBASE_API_KEY || FB_KEY;
      const verifyRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${fbKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
      );
      if (!verifyRes.ok) return res.status(401).json({ error: 'Token invalide' });
      const verifyData = await verifyRes.json();
      const u = verifyData.users?.[0];
      if (!u?.localId) return res.status(401).json({ error: 'Utilisateur introuvable' });
      uid = u.localId;
    }

    // Obtenir un token admin pour lire tout Firestore
    const adminToken = await getAdminToken();
    if (!adminToken) return res.status(500).json({ error: 'Admin token indisponible' });

    console.log(`[briefing] Génération pour uid=${uid}`);
    const result = await generateForUser(uid, adminToken);
    console.log(`[briefing] ✅ uid=${uid} score=${result.score} alertes=${result.nombre_alertes}`);

    return res.status(200).json({
      ok: true,
      uid: result.uid,
      date: result.date,
      score: result.score,
      nombre_alertes: result.nombre_alertes,
      briefing: result.briefing,
    });
  } catch (e) {
    console.error('[briefing] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
