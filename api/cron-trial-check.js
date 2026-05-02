// api/cron-trial-check.js
// ══════════════════════════════════════════════════════════════════
// CRON quotidien — Gestion du cycle de vie des essais gratuits + promos
// ✅ REST API only — pas de Firebase Admin SDK
//
// Appelé chaque jour à 8h UTC (9-10h heure française) par Vercel Cron
//
// Actions :
//   Trial J-3  → email rappel « Plus que 3 jours »
//   Trial J-1  → email rappel « Dernier jour demain »
//   Trial J+0  → plan = trial_expired + email « Essai expiré »
//   Trial J+15 → suppression des données + email « Données supprimées »
//   Promo J-7  → email rappel « 7 jours restants »
//   Promo J-1  → email rappel « Dernier jour »
//   Promo J+0  → plan = promo_expired + email « Offre expirée »
//
// Sécurité : vérifie le CRON_SECRET (Vercel envoie Authorization: Bearer <secret>)
// ══════════════════════════════════════════════════════════════════

const FIREBASE_PROJECT = 'altiora-70599';
const FB_KEY = 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

// ══════════════════════════════════════════════════════════════════
// FIREBASE REST HELPERS
// ══════════════════════════════════════════════════════════════════

let _adminToken = null;
let _adminTokenExp = 0;

async function getAdminToken() {
  if (_adminToken && Date.now() < _adminTokenExp - 300000) return _adminToken;
  const fbKey = process.env.FIREBASE_API_KEY || FB_KEY;
  const email = process.env.FIREBASE_API_EMAIL;
  const password = process.env.FIREBASE_API_PASSWORD;
  if (!email || !password) { console.warn('[cron] No admin credentials'); return null; }
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
  console.error('[cron] Admin login failed:', data.error?.message);
  return null;
}

function authHeaders(token) {
  return token ? { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

// ── Query Firestore (replaces db.collection().where().get()) ──
async function fsQuery(collectionId, field, op, value, token) {
  const url = `${FS_BASE}:runQuery`;
  const fsValue = typeof value === 'string' ? { stringValue: value }
    : typeof value === 'number' ? { integerValue: String(value) }
    : Array.isArray(value) ? { arrayValue: { values: value.map(v => ({ stringValue: v })) } }
    : { stringValue: String(value) };

  // For 'in' operator, use unaryFilter or composite
  let where;
  if (op === 'IN') {
    where = {
      compositeFilter: {
        op: 'OR',
        filters: value.map(v => ({
          fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: v } }
        }))
      }
    };
  } else {
    where = { fieldFilter: { field: { fieldPath: field }, op, value: fsValue } };
  }

  const body = { structuredQuery: { from: [{ collectionId }], where } };
  const res = await fetch(url, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) });
  const results = await res.json();
  if (!Array.isArray(results)) return [];
  return results.filter(r => r.document).map(r => {
    const name = r.document.name;
    const uid = name.split('/').pop();
    const fields = r.document.fields || {};
    const data = {};
    for (const [k, v] of Object.entries(fields)) {
      data[k] = v.stringValue ?? v.integerValue ?? v.booleanValue ?? v.doubleValue ?? null;
      // Convert string numbers
      if (v.integerValue !== undefined) data[k] = parseInt(v.integerValue);
    }
    return { uid, data, _name: name };
  });
}

// ── Update a document (replaces userDoc.ref.update()) ──
async function fsUpdate(path, fields, token) {
  const ff = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string')       ff[k] = { stringValue: v };
    else if (typeof v === 'number')  ff[k] = { integerValue: String(v) };
    else if (typeof v === 'boolean') ff[k] = { booleanValue: v };
    else if (v === null)             ff[k] = { nullValue: null };
    else                             ff[k] = { stringValue: String(v) };
  }
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join('&');
  const url = `${FS_BASE}/${path}?${mask}`;
  const res = await fetch(url, { method: 'PATCH', headers: authHeaders(token), body: JSON.stringify({ fields: ff }) });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`fsUpdate ${path} failed: ${err}`);
  }
}

// ── Delete a document ──
async function fsDelete(path, token) {
  const url = `${FS_BASE}/${path}`;
  const res = await fetch(url, { method: 'DELETE', headers: authHeaders(token) });
  return res.ok;
}

// ── List documents in a collection (for recursive delete) ──
async function fsList(path, token) {
  const url = `${FS_BASE}/${path}?pageSize=300`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.documents || []).map(d => d.name.replace(`projects/${FIREBASE_PROJECT}/databases/(default)/documents/`, ''));
}

// ── Query by field (for fidelite_public etc.) ──
async function fsQueryByField(collectionId, field, value, token) {
  return fsQuery(collectionId, field, 'EQUAL', value, token);
}

// ══════════════════════════════════════════════════════════════════
// DATA DELETION
// ══════════════════════════════════════════════════════════════════

async function deleteUserData(uid, token) {
  const COLLECTIONS_WITH_SUBCOLS = [
    'pilotage', 'marges', 'produits', 'panier', 'dettes',
    'bilans', 'copilote', 'cashflow', 'stock', 'fidelite',
    'fidelite_tablet', 'sms_credits', 'rh',
    'rh_conges', 'rh_conges_public', 'rh_onboarding', 'rh_recrutement',
    'rh_docs_gen', 'rh_emargements', 'rh_emargements_public',
    'rh_planning_public', 'rh_pointages_public',
    'fiches', 'profil', 'tickets'
  ];

  const SIMPLE_DOCS = [
    'catalogues', 'bank_connections', 'bank_pending',
    'fidelite_public_cfg', 'rh_params', 'tuto_progress', 'previsions'
  ];

  const SUB_NAMES = ['months', 'produits', 'params', 'items', 'data', 'years', 'briefings',
    'config', 'clients', 'demandes', 'fiches', 'daily', 'planning_acks', 'audit',
    'signatures', 'offres', 'candidats', 'entretiens', 'dossiers', 'events', 'list'];

  const DELETE_BATCH = 20; // suppressions parallèles par batch (anti-throttling Firestore)
  let deleted = 0;

  // Helper : delete une liste de paths par batches parallèles
  async function deleteBatched(paths) {
    let count = 0;
    for (let i = 0; i < paths.length; i += DELETE_BATCH) {
      const slice = paths.slice(i, i + DELETE_BATCH);
      const results = await Promise.all(slice.map(p => fsDelete(p, token).catch(() => false)));
      count += results.filter(Boolean).length;
    }
    return count;
  }

  // ──────────────────────────────────────────────────────────────
  // 1. Collections with subcollections
  //    a) Lister TOUS les chemins de subcollections candidats EN PARALLELE
  //       (25 collections × 21 noms = 525 fsList → ~1-2s au lieu de ~80s)
  //    b) Aplatir et delete par batches parallèles
  //    c) Delete les parents en parallèle
  // ──────────────────────────────────────────────────────────────
  try {
    const subPaths = [];
    for (const col of COLLECTIONS_WITH_SUBCOLS) {
      for (const sub of SUB_NAMES) {
        subPaths.push(`${col}/${uid}/${sub}`);
      }
    }
    // a) fsList parallèles, on ignore les erreurs (collections inexistantes = []
    const listResults = await Promise.all(
      subPaths.map(p => fsList(p, token).catch(() => []))
    );
    // b) aplatir tous les docs trouvés et les supprimer par batch
    const docsToDelete = [];
    for (const docs of listResults) for (const d of docs) docsToDelete.push(d);
    deleted += await deleteBatched(docsToDelete);

    // c) parents en parallèle
    const parentPaths = COLLECTIONS_WITH_SUBCOLS.map(col => `${col}/${uid}`);
    deleted += await deleteBatched(parentPaths);
  } catch (e) {
    console.warn(`[cron-trial] deleteUserData(subcols) ${uid}:`, e.message);
  }

  // ──────────────────────────────────────────────────────────────
  // 2. Simple docs (1 seul niveau) — en parallèle
  // ──────────────────────────────────────────────────────────────
  try {
    const simplePaths = SIMPLE_DOCS.map(col => `${col}/${uid}`);
    deleted += await deleteBatched(simplePaths);
  } catch (e) {
    console.warn(`[cron-trial] deleteUserData(simple) ${uid}:`, e.message);
  }

  // ──────────────────────────────────────────────────────────────
  // 3. fidelite_public where merchantUid == uid
  // ──────────────────────────────────────────────────────────────
  try {
    const fidDocs = await fsQueryByField('fidelite_public', 'merchantUid', uid, token);
    const fidPaths = fidDocs.map(doc => `fidelite_public/${doc.uid}`);
    deleted += await deleteBatched(fidPaths);
  } catch (e) {
    console.warn(`[cron-trial] deleteUserData(fidelite_public) ${uid}:`, e.message);
  }

  // ──────────────────────────────────────────────────────────────
  // 4. rh_employes_public + rh_employes_public_profil where ownerUid == uid
  // ──────────────────────────────────────────────────────────────
  try {
    const [rhDocs, rhProfDocs] = await Promise.all([
      fsQueryByField('rh_employes_public', 'ownerUid', uid, token).catch(() => []),
      fsQueryByField('rh_employes_public_profil', 'ownerUid', uid, token).catch(() => []),
    ]);
    const rhPaths = [
      ...rhDocs.map(d => `rh_employes_public/${d.uid}`),
      ...rhProfDocs.map(d => `rh_employes_public_profil/${d.uid}`),
    ];
    deleted += await deleteBatched(rhPaths);
  } catch (e) {
    console.warn(`[cron-trial] deleteUserData(rh_employes) ${uid}:`, e.message);
  }

  return deleted;
}

// ══════════════════════════════════════════════════════════════════
// EMAIL
// ══════════════════════════════════════════════════════════════════

const TRUSTPILOT_SMA = 'alteore.com+1781349945@invite.trustpilot.com';

async function sendEmail(to, subject, html, bcc) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.warn('[cron] RESEND_API_KEY manquante'); return false; }
  const from = process.env.RESEND_FROM || 'ALTEORE <noreply@alteore.com>';
  try {
    const body = { from, to: [to], subject, html };
    if (bcc) body.bcc = Array.isArray(bcc) ? bcc : [bcc];
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (res.ok) { console.log(`[cron] ✅ Email → ${to}: ${subject}`); return true; }
    console.error('[cron] ❌ Resend:', data);
    return false;
  } catch (e) { console.error('[cron] ❌ Email:', e.message); return false; }
}

function daysDiff(dateStr) {
  const end = new Date(dateStr);
  if (isNaN(end.getTime())) return null;
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  end.setHours(12, 0, 0, 0);
  return Math.round((end - now) / (1000 * 60 * 60 * 24));
}

// ══════════════════════════════════════════════════════════════════
// EMAIL TEMPLATES
// ══════════════════════════════════════════════════════════════════

function ew(content) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f5f7ff;font-family:Arial,Helvetica,sans-serif">' +
    '<div style="max-width:560px;margin:0 auto;padding:20px">' +
    '<div style="text-align:center;padding:24px 0"><span style="font-size:22px;font-weight:800;color:#0f1f5c;letter-spacing:1px">ALTEORE</span></div>' +
    '<div style="background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(15,31,92,0.08)">' +
    content +
    '</div>' +
    '<div style="text-align:center;padding:20px 0;font-size:11px;color:#94a3b8;line-height:1.5">ALTEORE — Logiciel de gestion pour commerçants<br/><a href="https://alteore.com" style="color:#94a3b8">alteore.com</a></div>' +
    '</div></body></html>';
}

function btn(text, url) {
  return '<div style="text-align:center"><a href="' + url + '" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#1a3dce,#4f7ef8);color:white;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;box-shadow:0 4px 14px rgba(26,61,206,0.3)">' + text + '</a></div>';
}

function emailReminderJ3(name) {
  return ew(
    '<div style="background:linear-gradient(135deg,#f59e0b,#fbbf24);padding:28px 32px;color:#1a1f36"><div style="font-size:28px;margin-bottom:8px">⏳</div><h1 style="margin:0;font-size:20px;font-weight:800">Plus que 3 jours d\'essai</h1><p style="margin:8px 0 0;font-size:14px;opacity:0.85">Votre période d\'essai gratuite arrive bientôt à son terme.</p></div>' +
    '<div style="padding:28px 32px"><p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">Bonjour' + (name ? ' ' + name : '') + ',</p>' +
    '<p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">Votre essai gratuit d\'Alteore expire dans <strong>3 jours</strong>. Pour continuer à utiliser votre tableau de bord et toutes vos données, souscrivez à un abonnement dès maintenant.</p>' +
    '<p style="font-size:13px;color:#6b7280;line-height:1.7;margin:0 0 24px">💡 Toutes vos données seront conservées si vous souscrivez avant l\'expiration.</p>' +
    btn('Choisir mon plan →', 'https://alteore.com/pricing.html') +
    '<p style="font-size:12px;color:#94a3b8;text-align:center;margin:20px 0 0">Annulation à tout moment · Sans engagement</p></div>'
  );
}

function emailReminderJ1(name) {
  return ew(
    '<div style="background:linear-gradient(135deg,#ef4444,#f87171);padding:28px 32px;color:white"><div style="font-size:28px;margin-bottom:8px">🔔</div><h1 style="margin:0;font-size:20px;font-weight:800">Dernier jour d\'essai demain !</h1><p style="margin:8px 0 0;font-size:14px;opacity:0.85">Ne perdez pas vos données et votre historique.</p></div>' +
    '<div style="padding:28px 32px"><p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">Bonjour' + (name ? ' ' + name : '') + ',</p>' +
    '<p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">Votre essai gratuit expire <strong>demain</strong>. Après cette date, vous ne pourrez plus accéder à Alteore.</p>' +
    '<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px;margin:0 0 20px"><p style="margin:0;font-size:13px;color:#991b1b;line-height:1.6">⚠️ <strong>Sans abonnement, vos données seront définitivement supprimées 15 jours après l\'expiration.</strong></p></div>' +
    btn('Souscrire maintenant →', 'https://alteore.com/pricing.html') +
    '<p style="font-size:12px;color:#94a3b8;text-align:center;margin:20px 0 0">À partir de 55€/mois · Annulation à tout moment</p></div>'
  );
}

function emailExpired(name) {
  return ew(
    '<div style="background:linear-gradient(135deg,#1a1f36,#2d3561);padding:28px 32px;color:white"><div style="font-size:28px;margin-bottom:8px">🚫</div><h1 style="margin:0;font-size:20px;font-weight:800">Votre essai gratuit a expiré</h1><p style="margin:8px 0 0;font-size:14px;opacity:0.7">Votre accès à Alteore est désormais bloqué.</p></div>' +
    '<div style="padding:28px 32px"><p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">Bonjour' + (name ? ' ' + name : '') + ',</p>' +
    '<p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">Votre période d\'essai de 15 jours est terminée. L\'accès au logiciel est maintenant bloqué.</p>' +
    '<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px;margin:0 0 16px"><p style="margin:0;font-size:13px;color:#991b1b;line-height:1.6;font-weight:600">⏰ Vous avez 15 jours pour récupérer vos données en souscrivant. Passé ce délai, elles seront définitivement supprimées.</p></div>' +
    btn('Réactiver mon compte →', 'https://alteore.com/pricing.html') + '</div>'
  );
}

function emailDeleted(name) {
  return ew(
    '<div style="background:linear-gradient(135deg,#6b7280,#9ca3af);padding:28px 32px;color:white"><div style="font-size:28px;margin-bottom:8px">🗑</div><h1 style="margin:0;font-size:20px;font-weight:800">Vos données ont été supprimées</h1><p style="margin:8px 0 0;font-size:14px;opacity:0.7">Conformément à notre politique, vos données ont été effacées.</p></div>' +
    '<div style="padding:28px 32px"><p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">Bonjour' + (name ? ' ' + name : '') + ',</p>' +
    '<p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">Votre période d\'essai a expiré il y a plus de 15 jours. Toutes vos données ont été définitivement supprimées de nos serveurs.</p>' +
    '<p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 24px">Si vous souhaitez utiliser Alteore à l\'avenir, vous pouvez créer un nouveau compte.</p>' +
    '<div style="text-align:center"><a href="https://alteore.com" style="display:inline-block;padding:14px 32px;background:#e2e8f0;color:#374151;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px">Visiter Alteore</a></div></div>'
  );
}

function emailPromoReminder(name, daysLeft) {
  var urgentBg = daysLeft <= 1 ? 'linear-gradient(135deg,#ef4444,#f87171)' : 'linear-gradient(135deg,#f59e0b,#fbbf24)';
  var dayText = daysLeft <= 1 ? 'demain' : 'dans ' + daysLeft + ' jours';
  return ew(
    '<div style="background:' + urgentBg + ';padding:28px 32px;color:white"><div style="font-size:28px;margin-bottom:8px">⏳</div><h1 style="margin:0;font-size:20px;font-weight:800">Votre offre expire ' + dayText + '</h1><p style="margin:8px 0 0;font-size:14px;opacity:0.85">Votre accès Master gratuit arrive bientôt à son terme.</p></div>' +
    '<div style="padding:28px 32px"><p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">Bonjour' + (name ? ' ' + name : '') + ',</p>' +
    '<p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">Votre offre découverte Alteore expire <strong>' + dayText + '</strong>. Pour continuer et <strong>conserver toutes vos données</strong>, souscrivez dès maintenant.</p>' +
    btn('Choisir mon plan →', 'https://alteore.com/pricing.html') +
    '<p style="font-size:12px;color:#94a3b8;text-align:center;margin:20px 0 0">À partir de 55€/mois · Annulation à tout moment</p></div>'
  );
}

function emailPromoExpired(name) {
  return ew(
    '<div style="background:linear-gradient(135deg,#1a1f36,#2d3561);padding:28px 32px;color:white"><div style="font-size:28px;margin-bottom:8px">🚫</div><h1 style="margin:0;font-size:20px;font-weight:800">Votre offre découverte a expiré</h1><p style="margin:8px 0 0;font-size:14px;opacity:0.7">Votre accès gratuit à Alteore est terminé.</p></div>' +
    '<div style="padding:28px 32px"><p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">Bonjour' + (name ? ' ' + name : '') + ',</p>' +
    '<p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">Votre offre découverte de 2 mois est terminée. L\'accès est maintenant bloqué.</p>' +
    '<p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px"><strong>Bonne nouvelle :</strong> toutes vos données sont intactes et vous attendent !</p>' +
    btn('Choisir mon plan →', 'https://alteore.com/pricing.html') +
    '<p style="font-size:12px;color:#94a3b8;text-align:center;margin:20px 0 0">À partir de 55€/mois · Vos données sont conservées</p></div>'
  );
}

function emailReviewRequest(name) {
  return ew(
    '<div style="background:linear-gradient(135deg,#059669,#10b981);padding:28px 32px;color:white"><div style="font-size:28px;margin-bottom:8px">💬</div><h1 style="margin:0;font-size:20px;font-weight:800">Votre avis compte !</h1><p style="margin:8px 0 0;font-size:14px;opacity:0.85">Aidez-nous à améliorer Alteore.</p></div>' +
    '<div style="padding:28px 32px"><p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">Bonjour' + (name ? ' ' + name : '') + ',</p>' +
    '<p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">Cela fait maintenant une semaine que vous utilisez Alteore. Nous espérons que le logiciel vous aide au quotidien !</p>' +
    '<p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 20px">Votre retour est <strong>essentiel</strong> pour nous. En 30 secondes, partagez votre expérience — cela aide d\'autres entrepreneurs comme vous à nous découvrir.</p>' +
    '<div style="text-align:center;margin:24px 0"><a href="https://fr.trustpilot.com/review/alteore.com" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#059669,#10b981);color:white;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;box-shadow:0 4px 14px rgba(5,150,105,0.3)">Laisser un avis (30 sec) →</a></div>' +
    '<div style="background:#ecfdf5;border:1.5px solid #a7f3d0;border-radius:12px;padding:16px;margin:0 0 20px"><p style="font-size:13px;color:#065f46;line-height:1.7;margin:0">Vous avez une question ou un problème ? Répondez directement à cet email — nous lisons et répondons à chaque message personnellement.</p></div>' +
    '<p style="font-size:14px;color:#374151;line-height:1.7;margin:0"><strong>Merci pour votre confiance,</strong><br/><span style="font-size:13px;color:#6b7280">Adrien & Emily — Cofondateurs d\'Alteore</span></p></div>'
  );
}

// ══════════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ══════════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  // Sécurité
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'Non autorisé' });
  }
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const token = await getAdminToken();
  if (!token) return res.status(500).json({ error: 'Admin auth failed' });

  const stats = { checked: 0, reminderJ3: 0, reminderJ1: 0, expired: 0, deleted: 0, errors: 0, promoChecked: 0, promoReminder7: 0, promoReminder1: 0, promoExpired: 0 };

  try {
    // ══════════════════════════════════════════════════════════════
    // 1. TRIALS
    // ══════════════════════════════════════════════════════════════
    const trialUsers = await fsQuery('users', 'plan', 'EQUAL', 'trial', token);
    const expiredUsers = await fsQuery('users', 'plan', 'EQUAL', 'trial_expired', token);
    const allTrials = [...trialUsers, ...expiredUsers];

    console.log(`[cron-trial] 🔍 ${allTrials.length} utilisateur(s) en trial/trial_expired`);

    // ──────────────────────────────────────────────────────────────
    // PASSE 1 — Actions rapides (emails J-3, J-1, J+0, J+8, expirations)
    // Les suppressions J+15 sont JUSTE COLLECTÉES ici, pas exécutées,
    // pour qu'un timeout de suppression ne bloque pas les rappels.
    // ──────────────────────────────────────────────────────────────
    const toDelete = []; // collectés en passe 1, exécutés en passe 2

    for (const user of allTrials) {
      stats.checked++;
      const { uid, data } = user;
      const email = data.email;
      const name = data.name || '';
      const trialEnd = data.trialEnd;
      const plan = data.plan;

      if (!trialEnd) { console.warn(`[cron] ⚠️ ${uid} — pas de trialEnd`); continue; }
      const daysLeft = daysDiff(trialEnd);
      if (daysLeft === null) continue;

      console.log(`[cron-trial] 👤 ${uid} (${email || '?'}) — J${daysLeft >= 0 ? '-' + daysLeft : '+' + Math.abs(daysLeft)} — plan=${plan}`);

      try {
        // J+7 après inscription (= 8 jours avant fin trial) : email satisfaction + Trustpilot
        if (daysLeft === 8 && plan === 'trial' && !data.reviewEmailSent) {
          if (email) await sendEmail(email, '💬 Comment se passe votre essai ? — Alteore', emailReviewRequest(name), TRUSTPILOT_SMA);
          await fsUpdate(`users/${uid}`, { reviewEmailSent: true }, token);
          stats.reviewSent = (stats.reviewSent || 0) + 1;
        }
        // J-3
        else if (daysLeft === 3 && plan === 'trial' && !data.trialEmailJ3) {
          if (email) await sendEmail(email, '⏳ Plus que 3 jours d\'essai gratuit — Alteore', emailReminderJ3(name));
          await fsUpdate(`users/${uid}`, { trialEmailJ3: true }, token);
          stats.reminderJ3++;
        }
        // J-1
        else if (daysLeft === 1 && plan === 'trial' && !data.trialEmailJ1) {
          if (email) await sendEmail(email, '🔔 Dernier jour d\'essai demain ! — Alteore', emailReminderJ1(name));
          await fsUpdate(`users/${uid}`, { trialEmailJ1: true }, token);
          stats.reminderJ1++;
        }
        // J+0 : expire
        else if (daysLeft <= 0 && plan === 'trial') {
          if (email && !data.trialEmailExpired) {
            await sendEmail(email, '🚫 Votre essai gratuit a expiré — Alteore', emailExpired(name));
          }
          await fsUpdate(`users/${uid}`, { plan: 'trial_expired', trialEmailExpired: true, trialExpiredAt: new Date().toISOString() }, token);
          stats.expired++;
          console.log(`[cron-trial] 🔒 ${uid} → trial_expired`);
        }
        // J+15 : delete data → COLLECTÉ ICI, exécuté en passe 2
        else if (plan === 'trial_expired') {
          const expiredAt = data.trialExpiredAt || data.trialEnd;
          const daysSinceExpiry = expiredAt ? -daysDiff(expiredAt) : 999;

          if (daysSinceExpiry >= 15 && !data.trialDataDeleted) {
            toDelete.push({ uid, email, name, daysSinceExpiry });
          }
        }
      } catch (userErr) {
        stats.errors++;
        console.error(`[cron-trial] ❌ ${uid}:`, userErr.message);
      }
    }

    // ──────────────────────────────────────────────────────────────
    // PASSE 2 — Suppressions de données (lentes), capées à MAX_DELETES_PER_RUN
    // Si plus de N en attente, les suivantes passeront aux runs suivants.
    // ──────────────────────────────────────────────────────────────
    const MAX_DELETES_PER_RUN = 3;
    stats.deletePending = toDelete.length;

    if (toDelete.length > 0) {
      // Priorité aux plus anciens (plus longtemps expirés en premier)
      toDelete.sort((a, b) => b.daysSinceExpiry - a.daysSinceExpiry);
      const batch = toDelete.slice(0, MAX_DELETES_PER_RUN);

      if (toDelete.length > MAX_DELETES_PER_RUN) {
        console.warn(`[cron-trial] ⚠️ ${toDelete.length} suppressions en attente, traitement de ${MAX_DELETES_PER_RUN} ce run (les autres aux runs suivants)`);
      }

      for (const { uid, email, name, daysSinceExpiry } of batch) {
        try {
          console.log(`[cron-trial] 🗑 ${uid} — suppression des données (J+${daysSinceExpiry})`);
          const t0 = Date.now();
          const deletedCount = await deleteUserData(uid, token);
          const elapsed = Date.now() - t0;
          if (email) await sendEmail(email, '🗑 Vos données Alteore ont été supprimées', emailDeleted(name));
          await fsUpdate(`users/${uid}`, { plan: 'deleted', trialDataDeleted: true, trialDataDeletedAt: new Date().toISOString(), dataDeletedCount: deletedCount }, token);
          stats.deleted++;
          console.log(`[cron-trial] ✅ ${uid} — ${deletedCount} docs supprimés en ${elapsed}ms`);
        } catch (delErr) {
          stats.errors++;
          console.error(`[cron-trial] ❌ delete ${uid}:`, delErr.message);
        }
      }
    }

    console.log('[cron-trial] ✅ Trials:', stats);

    // ══════════════════════════════════════════════════════════════
    // 2. PROMOS
    // ══════════════════════════════════════════════════════════════
    try {
      const masterUsers = await fsQuery('users', 'plan', 'EQUAL', 'master', token);

      for (const user of masterUsers) {
        const { uid, data } = user;
        const promoEnd = data.promoEnd;
        if (!promoEnd) continue; // vrai abonné master
        if (data.stripeSubscriptionId && ['active', 'trialing'].includes(data.subscriptionStatus)) continue;

        stats.promoChecked++;
        const email = data.email;
        const name = data.name || '';
        const daysLeft = daysDiff(promoEnd);
        if (daysLeft === null) continue;

        console.log(`[cron-promo] 👤 ${uid} (${email || '?'}) — J${daysLeft >= 0 ? '-' + daysLeft : '+' + Math.abs(daysLeft)} — promo ${data.promoCode || '?'}`);

        try {
          // J-7
          if (daysLeft === 7 && !data.promoEmailJ7) {
            if (email) await sendEmail(email, '⏳ Votre offre Alteore expire dans 7 jours', emailPromoReminder(name, 7));
            await fsUpdate(`users/${uid}`, { promoEmailJ7: true }, token);
            stats.promoReminder7++;
          }
          // J-1
          else if (daysLeft === 1 && !data.promoEmailJ1) {
            if (email) await sendEmail(email, '🔔 Dernier jour de votre offre Alteore !', emailPromoReminder(name, 1));
            await fsUpdate(`users/${uid}`, { promoEmailJ1: true }, token);
            stats.promoReminder1++;
          }
          // J+0 : expire
          else if (daysLeft <= 0) {
            if (email && !data.promoEmailExpired) {
              await sendEmail(email, '🚫 Votre offre Alteore a expiré — Choisissez un plan', emailPromoExpired(name));
            }
            await fsUpdate(`users/${uid}`, { plan: 'promo_expired', promoEmailExpired: true, promoExpiredAt: new Date().toISOString() }, token);
            stats.promoExpired++;
            console.log(`[cron-promo] 🔒 ${uid} → promo_expired`);
          }
        } catch (promoErr) {
          stats.errors++;
          console.error(`[cron-promo] ❌ ${uid}:`, promoErr.message);
        }
      }

      console.log('[cron-promo] ✅ Promos:', { promoChecked: stats.promoChecked, promoReminder7: stats.promoReminder7, promoReminder1: stats.promoReminder1, promoExpired: stats.promoExpired });
    } catch (promoGlobalErr) {
      console.error('[cron-promo] ❌ Global:', promoGlobalErr.message);
    }

    // ══════════════════════════════════════════════════════════════
    // 3. DEMANDES D'AVIS — J+7 après premier paiement (Trustpilot SMA)
    // ══════════════════════════════════════════════════════════════
    try {
      stats.reviewSent = stats.reviewSent || 0;
      for (const planName of ['pro', 'max', 'master']) {
        const paidUsers = await fsQuery('users', 'plan', 'EQUAL', planName, token);
        for (const user of paidUsers) {
          const { uid, data } = user;
          if (data.reviewEmailSent) continue;
          if (data.promoEnd) continue;
          const payDate = data.lastPayment || data.createdAt;
          if (!payDate) continue;
          const daysSincePay = -daysDiff(payDate);
          if (daysSincePay >= 7 && daysSincePay <= 10) {
            const email = data.email;
            const name = data.name || '';
            if (email) {
              await sendEmail(email, '💬 Votre avis compte ! — Alteore', emailReviewRequest(name), TRUSTPILOT_SMA);
              await fsUpdate(`users/${uid}`, { reviewEmailSent: true }, token);
              stats.reviewSent++;
              console.log(`[cron-review] ✅ ${uid} (${email}) — avis demandé`);
            }
          }
        }
      }
      if (stats.reviewSent > 0) console.log(`[cron-review] ✅ ${stats.reviewSent} demande(s) d'avis envoyée(s)`);
    } catch (reviewErr) {
      console.error('[cron-review] ❌ Global:', reviewErr.message);
    }

    return res.status(200).json({ ok: true, stats });

  } catch (e) {
    console.error('[cron] ❌ Global:', e);
    return res.status(500).json({ error: e.message, stats });
  }
};
