// api/cron-backup.js
// ══════════════════════════════════════════════════════════════════
// CRON quotidien — Sauvegarde externe des données clients (copie hors Google)
// ✅ REST API only — pas de Firebase Admin SDK
//
// Stratégie 3-2-1 :
//   Copie 1 = Firestore (prod) · Copie 2 = CE CRON → Cloudflare R2 (chiffré)
//   Copie 3 = export local via admin-backup.html
//
// Ce que fait ce cron :
//   1. Exporte TOUTES les collections clients (manifeste ci-dessous) en JSON brut
//      Firestore (format `fields` natif → restauration sans perte via PATCH).
//   2. Un fichier par client (auto-suffisant pour restaurer 1 client) + un fichier
//      global (collections transverses + docs uid-keyed, couvre les orphelins).
//   3. gzip → AES-256-GCM (clé BACKUP_ENC_KEY, hors Google) → PUT sur R2.
//   4. Arborescence : daily/YYYY-MM-DD/… ; le 1er du mois, copie vers monthly/YYYY-MM/.
//   5. Rétention : 30 quotidiennes + 12 mensuelles (purge auto → conforme RGPD :
//      les données d'un client effacé disparaissent des sauvegardes à l'expiration).
//   6. Reprise multi-passes : l'état vit dans backups_log/{date} ; le cron est
//      planifié 2× (04:00 et 04:45 UTC) — la 2e passe reprend ou s'arrête si fini.
//
// Endpoints utilitaires (auth CRON_SECRET) :
//   GET /api/cron-backup?test=r2   → teste R2 (put/list/delete) + clé AES, sans backup
//   GET /api/cron-backup?force=1   → relance même si la sauvegarde du jour est "done"
//
// Variables d'env requises (en plus de l'existant) :
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, BACKUP_ENC_KEY
//
// EXCLUSIONS assumées : urssaf_cache (cache reconstructible), backups_log (opérationnel).
// LIMITE connue : plannings RH `plan_YYYYMMDD` (noms dynamiques) couverts sur une
// fenêtre glissante (26 semaines passées + 9 futures) — les émargements légaux
// (rh_emargements) sont eux couverts intégralement.
// ══════════════════════════════════════════════════════════════════

const zlib = require('zlib');
const crypto = require('crypto');

const FIREBASE_PROJECT = 'altiora-70599';
const FB_KEY = 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
const FS_PREFIX = `projects/${FIREBASE_PROJECT}/databases/(default)/documents/`;

const DAILY_KEEP = 30;      // profondeur des sauvegardes quotidiennes
const MONTHLY_KEEP = 12;    // profondeur des sauvegardes mensuelles
const TIME_BUDGET_MS = 240000;   // ~240s de travail par passe (maxDuration 300s)
const USER_CONCURRENCY = 4;      // clients traités en parallèle
const REQ_BATCH = 15;            // requêtes Firestore parallèles par client
const PLAN_WEEKS_BACK = 26;      // fenêtre plannings RH dynamiques (plan_YYYYMMDD)
const PLAN_WEEKS_FWD = 9;

// ══════════════════════════════════════════════════════════════════
// MANIFESTE DES COLLECTIONS
// ⚠️ À GARDER SYNCHRONISÉ avec : firestore.rules, cron-trial-check.js (deleteUserData),
//    admin-backup.html et admin-restore.html. Toute NOUVELLE collection doit être
//    ajoutée ici, sinon elle ne sera PAS sauvegardée.
// ══════════════════════════════════════════════════════════════════

// Collections par client : {collection}/{uid}/{souscollection}/{docId}
const USER_SUBCOLS = {
  pilotage:              ['months', 'cartes_cadeaux'],
  marges:                ['produits', 'params'],
  produits:              ['items', 'meta'],
  panier:                ['data'],
  dettes:                ['data'],
  bilans:                ['years'],
  copilote:              ['briefings'],
  cashflow:              ['config'],
  stock:                 ['config', 'data', 'families', 'import_batches', 'movements', 'products', 'snapshots'],
  fidelite:              ['clients', 'config', 'copilot'],
  fidelite_tablet:       ['clients'],
  sms_credits:           ['history'],
  rh:                    ['employes', 'objectifs', 'paie', 'temps', 'config', 'conformite', 'contrats',
                          'doc_history', 'entretiens_annuels', 'pointages', 'recompenses', 'ccn_cache', 'params'],
  rh_conges:             ['demandes'],
  rh_conges_public:      ['demandes'],
  rh_onboarding:         ['dossiers'],
  rh_recrutement:        ['offres', 'candidats', 'entretiens', 'config'],
  rh_docs_gen:           ['items'],
  rh_emargements:        ['fiches', 'daily', 'planning_acks', 'audit'],
  rh_emargements_public: ['signatures'],
  rh_pointages_public:   ['events'],
  rh_objectifs_public:   ['items'],
  fiches:                ['items'],
  profil:                ['data'],
  tickets:               ['list'],
  previsions:            ['config', 'predictions', 'historique'],
  agent:                 ['notes', 'memory', 'memory-facts', 'profile', 'usage', 'briefings', 'conversations'],
  bank_connections:      ['banks'],
  client_access:         ['grants'],
  conseillers:           ['clients'],
};

// Docs simples par client : {collection}/{uid}
const USER_SIMPLE = [
  'users', 'users_activity', 'catalogues', 'suppliers', 'fournisseurs',
  'bank_pending', 'bank_rules', 'fidelite_public_cfg', 'rh_params', 'tuto_progress',
];

// Collections indexées par un champ uid (incluses dans le fichier client via runQuery)
const USER_QUERIES = [
  { col: 'fidelite_public',           field: 'merchantUid' },
  { col: 'rh_employes_public',        field: 'ownerUid' },
  { col: 'rh_employes_public_profil', field: 'ownerUid' },
];

// Collections transverses (fichier global) — listées intégralement
const GLOBAL_COLS = [
  'users', 'users_activity', 'catalogues', 'suppliers', 'fournisseurs',
  'bank_pending', 'bank_rules', 'fidelite_public_cfg', 'rh_params', 'tuto_progress',
  'fidelite_public', 'rh_employes_public', 'rh_employes_public_profil', 'rh_auth_salaries',
  'retention_logs', 'debug_reports', 'updates', 'tuto_videos',
  'blog_drafts', 'blog_published', 'blog_topics', 'conseil_invitations', 'conseillers',
];
// + traités à part dans le global : referrals (+ uses), conseillers/{uid}/clients

// ══════════════════════════════════════════════════════════════════
// FIREBASE REST HELPERS (pattern maison — cf. cron-trial-check.js)
// ══════════════════════════════════════════════════════════════════

let _adminToken = null;
let _adminTokenExp = 0;

async function getAdminToken() {
  if (_adminToken && Date.now() < _adminTokenExp - 300000) return _adminToken;
  const fbKey = process.env.FIREBASE_API_KEY || FB_KEY;
  const email = process.env.FIREBASE_API_EMAIL;
  const password = process.env.FIREBASE_API_PASSWORD;
  if (!email || !password) throw new Error('FIREBASE_API_EMAIL / FIREBASE_API_PASSWORD manquants');
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${fbKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) }
  );
  const data = await r.json();
  if (!data.idToken) throw new Error('Login admin Firebase échoué: ' + (data.error && data.error.message));
  _adminToken = data.idToken;
  _adminTokenExp = Date.now() + (parseInt(data.expiresIn || '3600') * 1000);
  return _adminToken;
}

function authHeaders(token) {
  return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
}

// GET un doc → { fields } brut, ou null si absent/refusé
async function fsGetRaw(path, token) {
  const res = await fetch(`${FS_BASE}/${path}`, { headers: authHeaders(token) });
  if (!res.ok) return null;
  const data = await res.json();
  return data.fields ? data.fields : {};
}

// Liste TOUS les docs d'une (sous-)collection, paginé → [{ path, fields }]
async function fsListRaw(path, token) {
  const out = [];
  let pageToken = '';
  for (let guard = 0; guard < 200; guard++) {
    const url = `${FS_BASE}/${path}?pageSize=300${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`;
    const res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) return out; // collection absente ou refusée → vide
    const data = await res.json();
    for (const d of (data.documents || [])) {
      out.push({ path: d.name.replace(FS_PREFIX, ''), fields: d.fields || {} });
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return out;
}

// runQuery champ == valeur → [{ path, fields }]
async function fsQueryRaw(collectionId, field, value, token) {
  const body = {
    structuredQuery: {
      from: [{ collectionId }],
      where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: value } } },
    },
  };
  const res = await fetch(`${FS_BASE}:runQuery`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) });
  if (!res.ok) return [];
  const rows = await res.json();
  const out = [];
  for (const r of (rows || [])) {
    if (r.document && r.document.name) out.push({ path: r.document.name.replace(FS_PREFIX, ''), fields: r.document.fields || {} });
  }
  return out;
}

// Encode un objet JS plat simple → format fields Firestore (pour le doc d'état)
function encodeFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) fields[k] = { nullValue: null };
    else if (typeof v === 'number') fields[k] = Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
    else fields[k] = { stringValue: String(v) };
  }
  return fields;
}
function decodeField(f) {
  if (!f) return null;
  if ('stringValue' in f) return f.stringValue;
  if ('integerValue' in f) return parseInt(f.integerValue);
  if ('doubleValue' in f) return f.doubleValue;
  if ('booleanValue' in f) return f.booleanValue;
  return null;
}

// Écrit/patch le doc d'état backups_log/{dateKey}
async function saveState(dateKey, state, token) {
  const fieldPaths = Object.keys(state).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const res = await fetch(`${FS_BASE}/backups_log/${dateKey}?${fieldPaths}`, {
    method: 'PATCH', headers: authHeaders(token), body: JSON.stringify({ fields: encodeFields(state) }),
  });
  if (!res.ok) console.warn('[backup] saveState HTTP', res.status);
}
async function loadState(dateKey, token) {
  const raw = await fsGetRaw(`backups_log/${dateKey}`, token);
  if (!raw) return null;
  const st = {};
  for (const [k, v] of Object.entries(raw)) st[k] = decodeField(v);
  return st;
}

// ══════════════════════════════════════════════════════════════════
// COMPRESSION + CHIFFREMENT (AES-256-GCM, clé hors Google)
// Format binaire : [IV 12 octets][ciphertext][TAG 16 octets]
// Déchiffrable côté navigateur avec WebCrypto (admin-restore.html).
// ══════════════════════════════════════════════════════════════════

function getEncKey() {
  const hex = (process.env.BACKUP_ENC_KEY || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('BACKUP_ENC_KEY manquante ou invalide (attendu : 64 caractères hexadécimaux — `openssl rand -hex 32`)');
  return Buffer.from(hex, 'hex');
}

function packBackup(jsonObj) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(jsonObj), 'utf8'), { level: 6 });
  const key = getEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(gz), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]);
}

// ══════════════════════════════════════════════════════════════════
// CLIENT R2 (S3-compatible) — signature AWS SigV4 inlinée, zéro dépendance
// Implémentation vérifiée contre le vecteur de test officiel AWS (cf. doc BACKUPS.md).
// Contrainte assumée : les clés d'objets sont restreintes à [A-Za-z0-9/._-]
// (nos clés : daily/YYYY-MM-DD/users/{uid}.json.gz.enc) → pas de double-encodage URI.
// ══════════════════════════════════════════════════════════════════

function hmac(key, data) { return crypto.createHmac('sha256', key).update(data, 'utf8').digest(); }
function sha256hex(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function rfc3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// Signe et exécute une requête S3/R2 (SigV4). headers extra: Content-Type, x-amz-copy-source…
async function s3Fetch(method, urlStr, opts) {
  opts = opts || {};
  const accessKey = opts.accessKey || process.env.R2_ACCESS_KEY_ID;
  const secretKey = opts.secretKey || process.env.R2_SECRET_ACCESS_KEY;
  const region = opts.region || 'auto';
  const service = opts.service || 's3';
  const url = new URL(urlStr);
  const body = opts.body || null;

  const amzDate = (opts.amzDate || new Date().toISOString().replace(/\.\d{3}/, '').replace(/[-:]/g, ''));
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body || '');

  // Headers canoniques (tout en minuscules, triés)
  // noContentSha : utilisé uniquement par le vecteur de test AWS (service iam sans ce header)
  const h = { 'host': url.host, 'x-amz-date': amzDate };
  if (!opts.noContentSha) h['x-amz-content-sha256'] = payloadHash;
  for (const [k, v] of Object.entries(opts.headers || {})) h[k.toLowerCase()] = v;
  const signedNames = Object.keys(h).sort();
  const canonicalHeaders = signedNames.map(k => k + ':' + String(h[k]).trim().replace(/\s+/g, ' ') + '\n').join('');
  const signedHeaders = signedNames.join(';');

  // Query string canonique (clés/valeurs ré-encodées RFC3986, triées)
  const canonicalQuery = Array.from(url.searchParams.entries())
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : 1)))
    .map(([k, v]) => k + '=' + v).join('&');

  const canonicalRequest = [method, url.pathname || '/', canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretKey, dateStamp), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  if (opts.signOnly) return { signature, canonicalRequest, stringToSign, authorization };

  const reqHeaders = { ...h, 'Authorization': authorization };
  delete reqHeaders.host; // fetch le pose lui-même
  const res = await fetch(url.toString(), { method, headers: reqHeaders, body });
  return res;
}

function assertSafeKey(key) {
  if (!/^[A-Za-z0-9/._-]+$/.test(key)) throw new Error('Clé R2 non conforme [A-Za-z0-9/._-]: ' + key);
}

function r2Client() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    throw new Error('Variables R2 manquantes (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET)');
  }
  // Bucket créé avec une juridiction (ex: UE) → endpoint dédié {account}.eu.r2.cloudflarestorage.com
  // R2_JURISDICTION = 'eu' pour le bucket alteore-backups (créé en "Specify jurisdiction: European Union")
  const jur = (process.env.R2_JURISDICTION || '').trim().toLowerCase();
  const host = jur ? `${R2_ACCOUNT_ID}.${jur}.r2.cloudflarestorage.com` : `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  return { base: `https://${host}/${R2_BUCKET}` };
}

async function r2Put(r2, key, buf, contentType) {
  assertSafeKey(key);
  const res = await s3Fetch('PUT', `${r2.base}/${key}`, {
    body: buf, headers: { 'content-type': contentType || 'application/octet-stream' },
  });
  if (!res.ok) throw new Error(`R2 PUT ${key} → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

async function r2Delete(r2, key) {
  assertSafeKey(key);
  const res = await s3Fetch('DELETE', `${r2.base}/${key}`);
  return res.ok || res.status === 404;
}

async function r2Copy(r2, srcKey, dstKey) {
  assertSafeKey(srcKey); assertSafeKey(dstKey);
  const res = await s3Fetch('PUT', `${r2.base}/${dstKey}`, {
    headers: { 'x-amz-copy-source': `/${process.env.R2_BUCKET}/${srcKey}` },
  });
  if (!res.ok) throw new Error(`R2 COPY ${srcKey} → HTTP ${res.status}`);
}

// ListObjectsV2 — retourne { keys:[{key,size,etag}], prefixes:[..] } (paginé)
async function r2List(r2, prefix, delimiter) {
  const keys = []; const prefixes = [];
  let contToken = '';
  for (let guard = 0; guard < 50; guard++) {
    let url = `${r2.base}?list-type=2&max-keys=1000&prefix=${encodeURIComponent(prefix)}`;
    if (delimiter) url += `&delimiter=${encodeURIComponent(delimiter)}`;
    if (contToken) url += `&continuation-token=${encodeURIComponent(contToken)}`;
    const res = await s3Fetch('GET', url);
    if (!res.ok) throw new Error(`R2 LIST ${prefix} → HTTP ${res.status}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const c = m[1];
      const k = (c.match(/<Key>([^<]+)<\/Key>/) || [])[1];
      const s = parseInt((c.match(/<Size>(\d+)<\/Size>/) || [])[1] || '0');
      const e = ((c.match(/<ETag>([^<]+)<\/ETag>/) || [])[1] || '').replace(/&quot;|"/g, '');
      if (k) keys.push({ key: k, size: s, etag: e });
    }
    for (const m of xml.matchAll(/<CommonPrefixes><Prefix>([^<]+)<\/Prefix><\/CommonPrefixes>/g)) prefixes.push(m[1]);
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    contToken = (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1] || '';
    if (!truncated || !contToken) break;
  }
  return { keys, prefixes };
}

// ══════════════════════════════════════════════════════════════════
// EXPORT D'UN CLIENT — fichier auto-suffisant { docs: { path: fields } }
// ══════════════════════════════════════════════════════════════════

// Lundis (UTC) sur la fenêtre glissante, format plan_YYYYMMDD
function planWeekNames(now) {
  const names = [];
  const d = new Date(now);
  d.setUTCHours(12, 0, 0, 0);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day)); // lundi de la semaine courante
  d.setUTCDate(d.getUTCDate() - PLAN_WEEKS_BACK * 7);
  for (let i = 0; i < PLAN_WEEKS_BACK + PLAN_WEEKS_FWD + 1; i++) {
    names.push('plan_' + d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0'));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return names;
}

async function runBatched(jobs, batchSize) {
  const results = [];
  for (let i = 0; i < jobs.length; i += batchSize) {
    const slice = jobs.slice(i, i + batchSize);
    const r = await Promise.all(slice.map(fn => fn().catch(() => null)));
    results.push(...r);
  }
  return results;
}

async function exportUser(uid, token, planNames) {
  const docs = {};
  const jobs = [];

  // 1. Docs simples + docs parents des collections à sous-collections
  const simplePaths = USER_SIMPLE.map(c => `${c}/${uid}`)
    .concat(Object.keys(USER_SUBCOLS).map(c => `${c}/${uid}`));
  for (const p of simplePaths) {
    jobs.push(async () => {
      const f = await fsGetRaw(p, token);
      if (f && Object.keys(f).length) docs[p] = f;
    });
  }

  // 2. Sous-collections statiques
  for (const [col, subs] of Object.entries(USER_SUBCOLS)) {
    for (const sub of subs) {
      jobs.push(async () => {
        const rows = await fsListRaw(`${col}/${uid}/${sub}`, token);
        for (const r of rows) docs[r.path] = r.fields;
      });
    }
  }

  // 3. Collections indexées par uid (fidelite_public, espace salarié public)
  for (const q of USER_QUERIES) {
    jobs.push(async () => {
      const rows = await fsQueryRaw(q.col, q.field, uid, token);
      for (const r of rows) docs[r.path] = r.fields;
    });
  }

  await runBatched(jobs, REQ_BATCH);

  // 4. Plannings RH dynamiques (uniquement si le client a des employés)
  const hasRH = Object.keys(docs).some(p => p.startsWith(`rh/${uid}/employes/`));
  if (hasRH) {
    const planJobs = [];
    for (const wk of planNames) {
      for (const col of ['rh', 'rh_planning_public']) {
        planJobs.push(async () => {
          const rows = await fsListRaw(`${col}/${uid}/${wk}`, token);
          for (const r of rows) docs[r.path] = r.fields;
        });
      }
    }
    await runBatched(planJobs, REQ_BATCH);
  }

  // 5. Messages de conversation Léa (3e niveau : agent/{uid}/conversations/{id}/messages)
  const convIds = Object.keys(docs)
    .filter(p => p.startsWith(`agent/${uid}/conversations/`))
    .map(p => p.split('/')[3]);
  if (convIds.length) {
    await runBatched(convIds.map(cid => async () => {
      const rows = await fsListRaw(`agent/${uid}/conversations/${cid}/messages`, token);
      for (const r of rows) docs[r.path] = r.fields;
    }), REQ_BATCH);
  }

  return docs;
}

// ══════════════════════════════════════════════════════════════════
// EXPORT GLOBAL — collections transverses + referrals/uses + conseillers/clients
// ══════════════════════════════════════════════════════════════════

async function exportGlobal(token) {
  const docs = {};
  await runBatched(GLOBAL_COLS.map(col => async () => {
    const rows = await fsListRaw(col, token);
    for (const r of rows) docs[r.path] = r.fields;
  }), 6);

  // referrals + sous-collection uses
  const refs = await fsListRaw('referrals', token);
  for (const r of refs) docs[r.path] = r.fields;
  await runBatched(refs.map(r => async () => {
    const code = r.path.split('/')[1];
    const uses = await fsListRaw(`referrals/${code}/uses`, token);
    for (const u of uses) docs[u.path] = u.fields;
  }), REQ_BATCH);

  // conseillers/{uid}/clients (index inverse)
  const cons = Object.keys(docs).filter(p => /^conseillers\/[^/]+$/.test(p));
  await runBatched(cons.map(p => async () => {
    const cuid = p.split('/')[1];
    const rows = await fsListRaw(`conseillers/${cuid}/clients`, token);
    for (const r of rows) docs[r.path] = r.fields;
  }), REQ_BATCH);

  return docs;
}

// ══════════════════════════════════════════════════════════════════
// RÉTENTION — purge daily/ > 30 j et monthly/ > 12 mois
// ══════════════════════════════════════════════════════════════════

async function pruneOld(r2, todayKey) {
  const pruned = [];
  const dayMs = 86400000;
  const today = new Date(todayKey + 'T00:00:00Z').getTime();

  const daily = await r2List(r2, 'daily/', '/');
  for (const p of daily.prefixes) {
    const dk = (p.match(/^daily\/(\d{4}-\d{2}-\d{2})\/$/) || [])[1];
    if (!dk) continue;
    const age = (today - new Date(dk + 'T00:00:00Z').getTime()) / dayMs;
    if (age > DAILY_KEEP) {
      const objs = await r2List(r2, p);
      await runBatched(objs.keys.map(o => () => r2Delete(r2, o.key)), 10);
      pruned.push(p + ' (' + objs.keys.length + ' fichiers)');
    }
  }

  const monthly = await r2List(r2, 'monthly/', '/');
  const months = monthly.prefixes
    .map(p => (p.match(/^monthly\/(\d{4}-\d{2})\/$/) || [])[1]).filter(Boolean).sort();
  const toDrop = months.slice(0, Math.max(0, months.length - MONTHLY_KEEP));
  for (const mk of toDrop) {
    const objs = await r2List(r2, `monthly/${mk}/`);
    await runBatched(objs.keys.map(o => () => r2Delete(r2, o.key)), 10);
    pruned.push(`monthly/${mk}/ (${objs.keys.length} fichiers)`);
  }
  return pruned;
}

// ══════════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  const t0 = Date.now();

  // ── Auth : Vercel Cron envoie Authorization: Bearer CRON_SECRET ──
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  const qKey = (req.query && req.query.key) || '';
  if (!secret || (auth !== `Bearer ${secret}` && qKey !== secret)) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);   // YYYY-MM-DD (UTC)
  const monthKey = dateKey.slice(0, 7);

  try {
    // ── Mode test : vérifie R2 + clé AES sans lancer de sauvegarde ──
    if (req.query && req.query.test === 'r2') {
      getEncKey(); // throw si clé absente/invalide
      const r2 = r2Client();
      const probe = `test/probe-${Date.now()}.txt`;
      await r2Put(r2, probe, Buffer.from('alteore backup probe'), 'text/plain');
      const listed = await r2List(r2, 'test/');
      await r2Delete(r2, probe);
      return res.status(200).json({
        ok: true, message: '✅ R2 opérationnel (put/list/delete) et clé AES valide.',
        bucket: process.env.R2_BUCKET, objetsTest: listed.keys.length,
      });
    }

    const token = await getAdminToken();
    const force = req.query && req.query.force === '1';

    // ── État du jour (reprise multi-passes) ──
    let state = await loadState(dateKey, token);
    if (state && state.status === 'done' && !force) {
      return res.status(200).json({ ok: true, message: `Sauvegarde ${dateKey} déjà terminée.`, state });
    }
    if (!state || force) {
      state = { status: 'running', stage: 'global', uCursor: '', usersDone: 0, docsTotal: 0, bytesTotal: 0, runs: 0, startedAt: now.toISOString(), error: '' };
    }
    state.runs = (state.runs || 0) + 1;
    state.updatedAt = now.toISOString();
    await saveState(dateKey, state, token);

    const r2 = r2Client();
    const planNames = planWeekNames(now);
    const timeLeft = () => TIME_BUDGET_MS - (Date.now() - t0);

    // ── Étape 1 : fichier global ──
    if (state.stage === 'global') {
      const gDocs = await exportGlobal(token);
      const payload = { format: 'alteore-backup-v1', scope: 'global', date: dateKey, exportedAt: new Date().toISOString(), docsCount: Object.keys(gDocs).length, docs: gDocs };
      const buf = packBackup(payload);
      await r2Put(r2, `daily/${dateKey}/global.json.gz.enc`, buf);
      state.stage = 'users';
      state.docsTotal += Object.keys(gDocs).length;
      state.bytesTotal += buf.length;
      await saveState(dateKey, state, token);
    }

    // ── Étape 2 : un fichier par client (curseur = uid, reprise possible) ──
    if (state.stage === 'users') {
      const allUsers = await fsListRaw('users', token);
      const uids = allUsers.map(u => u.path.split('/')[1]).sort();
      state.usersTotal = uids.length;
      let idx = state.uCursor ? uids.findIndex(u => u > state.uCursor) : 0;
      if (idx < 0) idx = uids.length;

      while (idx < uids.length) {
        if (timeLeft() < 25000) {
          // Budget épuisé → on sauvegarde le curseur, la passe suivante (cron 04:45) reprend
          state.status = 'partial';
          state.updatedAt = new Date().toISOString();
          await saveState(dateKey, state, token);
          return res.status(200).json({ ok: true, partial: true, message: `Passe ${state.runs} : ${state.usersDone}/${uids.length} clients — reprise à la prochaine passe.`, state });
        }
        const batch = uids.slice(idx, idx + USER_CONCURRENCY);
        await Promise.all(batch.map(async (uid) => {
          const docs = await exportUser(uid, token, planNames);
          const payload = { format: 'alteore-backup-v1', scope: 'user', uid, date: dateKey, exportedAt: new Date().toISOString(), docsCount: Object.keys(docs).length, docs };
          const buf = packBackup(payload);
          await r2Put(r2, `daily/${dateKey}/users/${uid}.json.gz.enc`, buf);
          state.docsTotal += Object.keys(docs).length;
          state.bytesTotal += buf.length;
        }));
        idx += batch.length;
        state.usersDone = idx;
        state.uCursor = uids[idx - 1];
        if (idx % (USER_CONCURRENCY * 3) === 0) await saveState(dateKey, state, token);
      }
      state.stage = 'finalize';
      await saveState(dateKey, state, token);
    }

    // ── Étape 3 : finalisation — manifest, copie mensuelle, rétention ──
    if (state.stage === 'finalize') {
      const objs = await r2List(r2, `daily/${dateKey}/`);
      const manifest = {
        format: 'alteore-backup-v1', date: dateKey, generatedAt: new Date().toISOString(),
        encrypted: true, compression: 'gzip', cipher: 'aes-256-gcm(iv12|data|tag16)',
        users: state.usersDone, docs: state.docsTotal, runs: state.runs,
        files: objs.keys.map(o => ({ key: o.key, size: o.size, etag: o.etag })),
      };
      await r2Put(r2, `daily/${dateKey}/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 1)), 'application/json');

      // Copie mensuelle le 1er du mois (avant la purge)
      if (dateKey.endsWith('-01')) {
        for (const o of objs.keys) {
          await r2Copy(r2, o.key, o.key.replace(`daily/${dateKey}/`, `monthly/${monthKey}/`));
        }
        await r2Copy(r2, `daily/${dateKey}/manifest.json`, `monthly/${monthKey}/manifest.json`);
      }

      const pruned = await pruneOld(r2, dateKey);

      state.status = 'done';
      state.stage = 'done';
      state.finishedAt = new Date().toISOString();
      state.durationMs = Date.now() - t0;
      state.pruned = pruned.join(' | ').slice(0, 900);
      await saveState(dateKey, state, token);

      console.log(`[backup] ${dateKey} OK — ${state.usersDone} clients, ${state.docsTotal} docs, ${(state.bytesTotal / 1048576).toFixed(1)} Mo, ${state.runs} passe(s)`);
      return res.status(200).json({ ok: true, message: `✅ Sauvegarde ${dateKey} terminée.`, users: state.usersDone, docs: state.docsTotal, mo: +(state.bytesTotal / 1048576).toFixed(1), pruned });
    }

    return res.status(200).json({ ok: true, state });

  } catch (e) {
    console.error('[backup] FATAL:', e);
    try {
      const token = await getAdminToken();
      await saveState(dateKey, { status: 'error', error: String(e.message || e).slice(0, 500), updatedAt: new Date().toISOString() }, token);
    } catch (e2) { /* état non sauvable */ }
    return res.status(500).json({ ok: false, error: e.message || 'Erreur interne' });
  }
};

// Hooks de test hors-ligne (n'affecte pas le handler Vercel)
module.exports._test = { s3Fetch, planWeekNames, packBackup, encodeFields, decodeField };
