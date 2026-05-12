// api/admin-migrate-cout-revient.js
// ══════════════════════════════════════════════════════════════════
// Migre l'intégralité du module Coût de revient d'un utilisateur
// vers un autre. Utilisé quand un admin a saisi des données sur le
// mauvais compte (typiquement : Adrien a importé les recettes d'une
// cliente sur son propre profil au lieu du sien).
//
// Copie :
//   • produits/{src}/items/*               → produits/{dst}/items/*
//   • produits/{src}/meta/categories       → produits/{dst}/meta/categories
//   • fiches/{src}/items/*                 → fiches/{dst}/items/*
//
// Préserve les IDs (donc les articleRef restent valides entre recettes
// et fournisseurs). N'écrase JAMAIS un doc existant côté destination
// sauf si overwrite=true (sécurité).
//
// Sécurité :
//   • POST avec header Authorization: Bearer <idToken>
//   • L'idToken doit appartenir à contact@adrienemily.com
//
// Body :
//   {
//     sourceUid: string,
//     targetUid: string,
//     dryRun:    boolean,   // true = aperçu sans écriture
//     overwrite: boolean,   // false par défaut, true pour forcer
//     scope: {              // que migrer (tout = true par défaut)
//       produits:     boolean,
//       categories:   boolean,
//       fournisseurs: boolean
//     }
//   }
// ══════════════════════════════════════════════════════════════════

const FIREBASE_PROJECT = 'altiora-70599';
const FB_KEY = 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
const ADMIN_EMAIL = 'contact@adrienemily.com';

// ══════════════════════════════════════════════════════════════════
// AUTH — Admin token serveur (api@altiora.app)
// ══════════════════════════════════════════════════════════════════

let _adminToken = null;
let _adminTokenExp = 0;

async function getAdminToken() {
  if (_adminToken && Date.now() < _adminTokenExp - 300000) return _adminToken;
  const fbKey = process.env.FIREBASE_API_KEY || FB_KEY;
  const email = process.env.FIREBASE_API_EMAIL;
  const password = process.env.FIREBASE_API_PASSWORD;
  if (!email || !password) throw new Error('Missing FIREBASE_API_EMAIL/PASSWORD env vars');
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${fbKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) }
  );
  const data = await r.json();
  if (!data.idToken) throw new Error('Admin login failed: ' + (data.error?.message || 'unknown'));
  _adminToken = data.idToken;
  _adminTokenExp = Date.now() + (parseInt(data.expiresIn || '3600') * 1000);
  return _adminToken;
}

async function verifyAdminIdToken(idToken) {
  if (!idToken) return null;
  const fbKey = process.env.FIREBASE_API_KEY || FB_KEY;
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${fbKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
  );
  const data = await r.json();
  if (!data.users || !data.users[0]) return null;
  const user = data.users[0];
  if (user.email !== ADMIN_EMAIL) return null;
  return { uid: user.localId, email: user.email };
}

// ══════════════════════════════════════════════════════════════════
// FIRESTORE REST — Helpers
// ══════════════════════════════════════════════════════════════════

function authHeaders(token) {
  return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
}

// Liste tous les docs d'une collection (gère la pagination)
async function fsListAll(collectionPath, token) {
  const docs = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({ pageSize: '300' });
    if (pageToken) params.set('pageToken', pageToken);
    const url = `${FS_BASE}/${collectionPath}?${params.toString()}`;
    const r = await fetch(url, { headers: authHeaders(token) });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`fsListAll ${collectionPath} → HTTP ${r.status} ${txt}`);
    }
    const data = await r.json();
    if (data.documents) docs.push(...data.documents);
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return docs;
}

// GET un doc unique (renvoie null si 404)
async function fsGet(docPath, token) {
  const r = await fetch(`${FS_BASE}/${docPath}`, { headers: authHeaders(token) });
  if (r.status === 404) return null;
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`fsGet ${docPath} → HTTP ${r.status} ${txt}`);
  }
  return r.json();
}

// PATCH un doc — recrée si absent, écrase si présent (selon updateMask)
// On écrit le `fields` tel quel pour préserver les types Firestore.
async function fsWrite(docPath, fields, token) {
  const r = await fetch(`${FS_BASE}/${docPath}`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`fsWrite ${docPath} → HTTP ${r.status} ${txt}`);
  }
  return r.json();
}

// Extrait l'ID terminal d'un document.name Firestore
function extractDocId(fullName) {
  // 'projects/X/databases/(default)/documents/produits/UID/items/abc' → 'abc'
  const parts = fullName.split('/');
  return parts[parts.length - 1];
}

// ══════════════════════════════════════════════════════════════════
// MIGRATION D'UNE SOUS-COLLECTION — docs uniques (pas de sous-niveau)
// ══════════════════════════════════════════════════════════════════

async function migrateCollection({ srcPath, dstBase, token, dryRun, overwrite, logs }) {
  const docs = await fsListAll(srcPath, token);
  let copied = 0;
  let skipped = 0;
  let errors = 0;

  for (const doc of docs) {
    const id = extractDocId(doc.name);
    const dstDocPath = `${dstBase}/${id}`;

    try {
      if (!overwrite) {
        const existing = await fsGet(dstDocPath, token);
        if (existing) {
          skipped++;
          logs.push(`  ↳ ${id} → SKIP (existe déjà côté destination)`);
          continue;
        }
      }
      if (dryRun) {
        copied++;
        logs.push(`  ↳ ${id} → (dryRun) prêt à copier`);
      } else {
        await fsWrite(dstDocPath, doc.fields || {}, token);
        copied++;
        logs.push(`  ↳ ${id} → ✅ copié`);
      }
    } catch (e) {
      errors++;
      logs.push(`  ↳ ${id} → ❌ ${e.message}`);
    }
  }

  return { total: docs.length, copied, skipped, errors };
}

// ══════════════════════════════════════════════════════════════════
// MIGRATION D'UN DOCUMENT UNIQUE (categories par exemple)
// ══════════════════════════════════════════════════════════════════

async function migrateSingleDoc({ srcPath, dstPath, token, dryRun, overwrite, logs }) {
  const src = await fsGet(srcPath, token);
  if (!src) {
    logs.push(`  ↳ doc source absent (rien à migrer)`);
    return { total: 0, copied: 0, skipped: 0, errors: 0 };
  }
  if (!overwrite) {
    const dst = await fsGet(dstPath, token);
    if (dst) {
      logs.push(`  ↳ doc destination existe déjà → SKIP`);
      return { total: 1, copied: 0, skipped: 1, errors: 0 };
    }
  }
  if (dryRun) {
    logs.push(`  ↳ (dryRun) prêt à copier`);
    return { total: 1, copied: 1, skipped: 0, errors: 0 };
  }
  try {
    await fsWrite(dstPath, src.fields || {}, token);
    logs.push(`  ↳ ✅ copié`);
    return { total: 1, copied: 1, skipped: 0, errors: 0 };
  } catch (e) {
    logs.push(`  ↳ ❌ ${e.message}`);
    return { total: 1, copied: 0, skipped: 0, errors: 1 };
  }
}

// ══════════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Auth caller ──
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const caller = await verifyAdminIdToken(idToken).catch(() => null);
  if (!caller) {
    return res.status(403).json({ error: 'Forbidden — admin only (' + ADMIN_EMAIL + ')' });
  }

  // ── Body ──
  const body = req.body || {};
  const sourceUid = (body.sourceUid || '').trim();
  const targetUid = (body.targetUid || '').trim();
  const dryRun = body.dryRun !== false; // safe par défaut
  const overwrite = body.overwrite === true;
  const scope = Object.assign(
    { produits: true, categories: true, fournisseurs: true },
    body.scope || {}
  );

  if (!sourceUid || !targetUid) {
    return res.status(400).json({ error: 'sourceUid et targetUid requis' });
  }
  if (sourceUid === targetUid) {
    return res.status(400).json({ error: 'sourceUid et targetUid identiques' });
  }

  const logs = [];
  logs.push(`[migrate] caller=${caller.email}`);
  logs.push(`[migrate] source=${sourceUid}`);
  logs.push(`[migrate] target=${targetUid}`);
  logs.push(`[migrate] dryRun=${dryRun} overwrite=${overwrite}`);
  logs.push(`[migrate] scope=${JSON.stringify(scope)}`);

  try {
    const token = await getAdminToken();

    const result = { sourceUid, targetUid, dryRun, overwrite, scope, counts: {} };

    // ── 1. Produits / recettes ──
    if (scope.produits) {
      logs.push(`▶ Migration produits/items :`);
      result.counts.produits = await migrateCollection({
        srcPath: `produits/${sourceUid}/items`,
        dstBase: `produits/${targetUid}/items`,
        token, dryRun, overwrite, logs,
      });
    }

    // ── 2. Catégories manuelles ──
    if (scope.categories) {
      logs.push(`▶ Migration produits/meta/categories :`);
      result.counts.categories = await migrateSingleDoc({
        srcPath: `produits/${sourceUid}/meta/categories`,
        dstPath: `produits/${targetUid}/meta/categories`,
        token, dryRun, overwrite, logs,
      });
    }

    // ── 3. Fournisseurs ──
    if (scope.fournisseurs) {
      logs.push(`▶ Migration fiches/items :`);
      result.counts.fournisseurs = await migrateCollection({
        srcPath: `fiches/${sourceUid}/items`,
        dstBase: `fiches/${targetUid}/items`,
        token, dryRun, overwrite, logs,
      });
    }

    logs.push(`✅ Terminé`);
    return res.status(200).json({ ok: true, result, logs });
  } catch (e) {
    logs.push(`❌ FATAL : ${e.message}`);
    console.error('[admin-migrate-cout-revient]', e);
    return res.status(500).json({ ok: false, error: e.message, logs });
  }
}
