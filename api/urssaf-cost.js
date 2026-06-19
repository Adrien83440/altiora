// /api/urssaf-cost.js — Proxy vers l'API mon-entreprise.urssaf.fr (TNS et salariés)
// + calcul forfaitaire pour dirigeants assimilés salariés (SAS/SASU/SARL minoritaire)
//
// Calcule le coût employeur et le net mensuel pour :
//   • Salarié classique : POST { brutMensuel, heuresHebdo, cadre, apprenti, cdd } → API URSSAF
//   • TNS               : POST { brutMensuel, dirigeant: 'tns' }      → API URSSAF (régime indépendant)
//   • Assimilé dirigeant : POST { brutMensuel, dirigeant: 'assimile' } → forfait 42% patronal / 22% salarial
//
// ─── Gestion du temps partiel (correctif réduction générale) ───────────────
// La réduction générale dégressive (RGDU / ex-Fillon) dépend du SALAIRE HORAIRE
// comparé au SMIC, pas du volume d'heures. Le moteur Publicodes URSSAF suppose
// par défaut un contrat temps plein 35 h : lui envoyer le brut mensuel brut d'un
// temps partiel (ex. 757 €) revient à lui décrire un temps plein très en dessous
// du SMIC → il applique une réduction générale aberrante → taux faussement bas
// (~5-6% au lieu de ~10-15%).
//
// Solution : le taux de charges effectif étant invariant d'échelle (il ne dépend
// que du salaire horaire), on évalue toujours sur l'ÉQUIVALENT TEMPS PLEIN :
//     brutETP = brutMensuel × 35 / heuresHebdo
// puis on ré-exprime coût / cotisations / net sur le brut réel du salarié.
//
// Garde-fou : un salaire temps plein ne peut pas être inférieur au SMIC. Si
// brutETP tombe sous le SMIC mensuel, on évalue AU SMIC (= point de réduction
// générale maximale légitime). Cela neutralise définitivement la sur-réduction,
// même quand les heures ne sont pas renseignées (défaut 35 h).
//
// ─── Pourquoi un forfait pour l'assimilé dirigeant ? ───────────────────────
// Le moteur Publicodes applique la réduction générale sur tout namespace
// `salarié . ...`. Or les mandataires sociaux (président SAS/SASU, gérant
// minoritaire SARL) en sont explicitement exclus.
// Source : https://mon-entreprise.urssaf.fr/simulateurs/sasu
// On applique donc des taux URSSAF de référence stables :
//   • Patronal : 42 %  • Salarial : 22 %  (précis à ±1-2 pts sur 1 500-10 000 €)
//
// ─── Anti 429 (rate-limit URSSAF) ──────────────────────────────────────────
// L'API mon-entreprise.urssaf.fr est publique et applique un rate-limit IP.
// Toutes les fonctions Vercel sortent sur un petit pool d'IPs partagées : un
// recalcul de plusieurs salariés (ou plusieurs users simultanés) sature vite
// la limite → 429. Et plus on tape sous rate-limit, plus on l'entretient.
//
// PRINCIPE NON NÉGOCIABLE (données de paie) : tout chiffre de charges servi au
// front provient EXCLUSIVEMENT de l'API URSSAF officielle, soit en direct soit
// via le cache (qui ne mémorise que SES réponses). On ne fabrique JAMAIS de taux
// estimé. Quand l'URSSAF est injoignable et que le profil n'est pas en cache, on
// renvoie 503 « indisponible » (sans chiffre) ; le front conserve la dernière
// valeur connue. Dès que l'API répond, le taux exact arrive et se met en cache.
//
// Trois parades, cumulées :
//   1. CACHE Firestore PARTAGÉ entre tous les users. Le taux de charges ne
//      dépend que de (brut équivalent, statut, type contrat, régime) et du
//      barème de l'année — il ne change qu'à chaque revalorisation (~1×/an).
//      Path : urssaf_cache/barometre_{année}/entries/{clé}
//      Accès 100% via admin token REST (pattern api@altiora.app) — le client
//      ne touche jamais cette collection.
//      ⚠️ REQUIERT le bloc Firestore :
//          match /urssaf_cache/{document=**} { allow read, write: if isAdmin(); }
//      Le token admin REST est soumis aux rules comme n'importe quel user :
//      sans ce bloc, il tombe dans le « refus par défaut » → 403 sur chaque
//      get/set → cache mort → 429 URSSAF en cascade.
//   2. CIRCUIT BREAKER partagé (doc urssaf_cache/_circuit). Au premier 429 on
//      cesse de taper l'URSSAF pendant un cooldown progressif (5 → 15 → 30 →
//      60 min). Toutes les instances Vercel le voient → l'IP refroidit au lieu
//      d'être martelée, l'API redevient joignable, puis le cache s'amorce. Le
//      breaker se réarme plus longtemps si le 429 persiste, et se réinitialise
//      dès qu'un appel réussit (half-open).
//   3. PAS DE RETRY sur 429 (un rate-limit ne se résout pas en réessayant : ça
//      l'aggrave). Un seul retry court reste autorisé sur 5xx (erreur serveur
//      transitoire URSSAF, ≠ rate-limit).
//
// Le front reste compatible sans modification : il traite tout statut non-ok
// comme un échec et conserve le dernier taux. Le 503 « indisponible » est
// simplement plus précis qu'un 502 (et expose `unavailable`/`reason` pour un
// éventuel message UX dédié plus tard).

// SMIC mensuel brut temps plein (35 h). Plancher anti sur-réduction.
// ⚠️ À actualiser à chaque revalorisation du SMIC (révision annuelle au 1ᵉʳ janvier).
const SMIC_MENSUEL_TEMPS_PLEIN = 1850;

const FIREBASE_PROJECT = 'altiora-70599';

// ───────────────────────────────────────────────────────────────────────────
// Admin token REST (pattern identique aux autres API : cancel-subscription.js).
// Mis en cache au niveau du module pour survivre entre invocations chaudes
// (le idToken Firebase vit ~1 h ; on le rafraîchit avec 5 min de marge).
// ───────────────────────────────────────────────────────────────────────────
let _adminTokenCache = { token: null, exp: 0 };

async function getAdminToken() {
  const now = Date.now();
  if (_adminTokenCache.token && now < _adminTokenCache.exp) return _adminTokenCache.token;

  const fbKey = process.env.FIREBASE_API_KEY || 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
  const email = process.env.FIREBASE_API_EMAIL;
  const password = process.env.FIREBASE_API_PASSWORD;
  if (!email || !password) return null;

  try {
    const r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${fbKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true })
      }
    );
    const data = await r.json();
    if (!data.idToken) return null;
    // expiresIn est en secondes (≈3600). On garde 5 min de marge.
    const ttlMs = ((parseInt(data.expiresIn, 10) || 3600) - 300) * 1000;
    _adminTokenCache = { token: data.idToken, exp: now + ttlMs };
    return data.idToken;
  } catch (e) {
    console.error('[urssaf-cost] admin token error:', e.message);
    return null;
  }
}

// Lecture d'un doc de cache. Renvoie l'objet { ...payload } ou null.
async function cacheGet(key, token) {
  if (!token) return null;
  const year = new Date().getFullYear();
  const path = `urssaf_cache/barometre_${year}/entries/${key}`;
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`;
  try {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 404) return null; // pas en cache : comportement normal
    if (!res.ok) {
      // 403 = bloc Firestore `urssaf_cache` manquant → cache HS → 429 en cascade.
      // Tout autre statut = anomalie Firestore/réseau. On le rend visible.
      console.error('[urssaf-cost] cacheGet HTTP ' + res.status +
        ' — cache désactivé ? Vérifier la règle match /urssaf_cache/{document=**}');
      return null;
    }
    const doc = await res.json();
    const f = doc?.fields?.payload?.stringValue;
    if (!f) return null;
    return JSON.parse(f);
  } catch (e) {
    console.error('[urssaf-cost] cacheGet error:', e.message);
    return null;
  }
}

// Écriture d'un doc de cache (best-effort, n'interrompt jamais la réponse).
// On stocke le payload sérialisé en un seul champ pour rester agnostique du schéma.
async function cacheSet(key, payload, token) {
  if (!token) return;
  const year = new Date().getFullYear();
  const path = `urssaf_cache/barometre_${year}/entries/${key}`;
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?updateMask.fieldPaths=payload&updateMask.fieldPaths=cachedAt`;
  const fields = {
    payload: { stringValue: JSON.stringify(payload) },
    cachedAt: { stringValue: new Date().toISOString() }
  };
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ fields })
    });
    if (!res.ok) {
      console.error('[urssaf-cost] cacheSet HTTP ' + res.status +
        ' — écriture cache refusée ? Vérifier la règle match /urssaf_cache/{document=**}');
    }
  } catch (e) {
    console.error('[urssaf-cost] cacheSet error:', e.message);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// CIRCUIT BREAKER partagé (doc urssaf_cache/_circuit)
//
// But : dès qu'un 429 est rencontré, on cesse de taper l'URSSAF pendant un
// cooldown — toutes les instances Vercel le voient via Firestore, l'IP de
// sortie refroidit au lieu d'être martelée. Le cooldown grandit si le 429
// persiste (5 → 15 → 30 → 60 min) et se réinitialise dès qu'un appel réussit.
//
// Couvert par la même règle que le cache : match /urssaf_cache/{document=**}.
// Lecture fail-open : si Firestore hoquette, on n'empêche pas le calcul.
// ───────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CIRCUIT_COOLDOWNS_MS = [5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000];
function circuitCooldownMs(strikes) {
  const i = Math.min(Math.max(strikes - 1, 0), CIRCUIT_COOLDOWNS_MS.length - 1);
  return CIRCUIT_COOLDOWNS_MS[i];
}

const CIRCUIT_URL =
  `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/urssaf_cache/_circuit`;

// Renvoie { untilMs, strikes }. untilMs = epoch ms jusqu'où le circuit est ouvert.
async function circuitGet(token) {
  const fallback = { untilMs: 0, strikes: 0 };
  if (!token) return fallback;
  try {
    const res = await fetch(CIRCUIT_URL, { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 404) return fallback;       // jamais armé : circuit fermé
    if (!res.ok) {
      console.error('[urssaf-cost] circuitGet HTTP ' + res.status);
      return fallback;                              // fail-open
    }
    const f = (await res.json())?.fields || {};
    return {
      untilMs: parseInt(f.untilMs?.integerValue || '0', 10) || 0,
      strikes: parseInt(f.strikes?.integerValue || '0', 10) || 0
    };
  } catch (e) {
    console.error('[urssaf-cost] circuitGet error:', e.message);
    return fallback;
  }
}

// Écrit l'état du circuit (best-effort, ne bloque jamais la réponse).
async function circuitSet(token, strikes, untilMs) {
  if (!token) return;
  const url = CIRCUIT_URL
    + '?updateMask.fieldPaths=untilMs&updateMask.fieldPaths=strikes&updateMask.fieldPaths=updatedAt';
  const fields = {
    untilMs: { integerValue: String(untilMs) },
    strikes: { integerValue: String(strikes) },
    updatedAt: { stringValue: new Date().toISOString() }
  };
  try {
    await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ fields })
    });
  } catch (e) {
    console.error('[urssaf-cost] circuitSet error:', e.message);
  }
}

// Clé de cache déterministe à partir des paramètres normalisés de l'évaluation.
// On hashe le brut RÉELLEMENT évalué (ETP plafonné au SMIC) + les drapeaux qui
// changent le résultat. Deux salariés au même profil → même clé → 1 seul appel
// URSSAF, ensuite plus jamais. (mode assimilé exclu : pas d'appel API.)
function buildCacheKey(parts) {
  // parts : objet plat de primitives
  const norm = Object.keys(parts).sort().map(k => `${k}=${parts[k]}`).join('|');
  // hash léger (djb2) → string compacte, sûr comme ID de doc Firestore
  let h = 5381;
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) >>> 0;
  return 'k' + h.toString(36);
}

// Appel URSSAF — PAS de retry sur 429 (un rate-limit ne se résout pas en
// réessayant : on le confie au circuit breaker). Un seul retry court reste
// autorisé sur 5xx / erreur réseau (transitoire, ≠ rate-limit).
// Renvoie un résultat discriminé :
//   { ok: Response } | { rateLimited: true } | { error: true, status, body }
async function callUrssaf(expressions, situation) {
  const MAX_5XX_RETRY = 1;
  for (let attempt = 0; ; attempt++) {
    let resp;
    try {
      resp = await fetch('https://mon-entreprise.urssaf.fr/api/v1/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ expressions, situation })
      });
    } catch (e) {
      // Erreur réseau = transitoire → traitée comme un 5xx.
      if (attempt < MAX_5XX_RETRY) { await sleep(800); continue; }
      return { error: true, status: 0, body: e.message || 'network error' };
    }
    if (resp.ok) return { ok: resp };
    if (resp.status === 429) return { rateLimited: true };   // ne PAS réessayer
    if (resp.status >= 500 && resp.status < 600) {
      if (attempt < MAX_5XX_RETRY) {
        await sleep(800 + Math.floor(Math.random() * 300));
        continue;
      }
      const body = await resp.text().catch(() => '');
      return { error: true, status: resp.status, body };
    }
    // Autre 4xx (400, etc.) : erreur de requête, non transitoire.
    const body = await resp.text().catch(() => '');
    return { error: true, status: resp.status, body };
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { brutMensuel, heuresHebdo, cadre, apprenti, cdd, dirigeant } = req.body || {};
    const brut = parseFloat(brutMensuel);
    if (!brut || brut <= 0) return res.status(400).json({ error: 'brutMensuel requis (> 0)' });

    // ─── Court-circuit : dirigeant assimilé salarié (forfait, sans API URSSAF) ───
    // Instantané et déterministe → pas de cache nécessaire.
    if (dirigeant === 'assimile') {
      const TAUX_PATRONAL = 42; // Charges patronales dirigeant SAS/SASU (RGDU exclue)
      const TAUX_SALARIAL = 22; // Charges salariales dirigeant SAS/SASU (cadre, hors chômage)
      const cotisPatronales = Math.round(brut * TAUX_PATRONAL) / 100;
      const cotisSalariales = Math.round(brut * TAUX_SALARIAL) / 100;
      return res.status(200).json({
        mode: 'assimile',
        brutMensuel: brut,
        coutEmployeur: Math.round((brut + cotisPatronales) * 100) / 100,
        cotisationsPatronales: cotisPatronales,
        cotisationsSalariales: cotisSalariales,
        netAvantImpot: Math.round((brut - cotisSalariales) * 100) / 100,
        tauxEffectif: TAUX_PATRONAL,
        source: 'forfait dirigeant assimilé (taux URSSAF de référence, RGDU non applicable)',
        annee: new Date().getFullYear(),
      });
    }

    let expressions, situation;
    let brutEvalue = brut;   // brut réellement transmis au moteur URSSAF
    let heuresUsed = 35;
    let cacheParts;          // paramètres qui déterminent le résultat (→ clé)

    if (dirigeant === 'tns') {
      situation = {
        'dirigeant . indépendant . revenu professionnel': `${brut * 12} €/an`,
      };
      expressions = [
        'dirigeant . indépendant . cotisations et contributions',
        'dirigeant . indépendant . revenu net de cotisations',
      ];
      // Pour le TNS le résultat n'est pas un simple taux invariant (barème par
      // tranches) → la clé inclut le brut exact.
      cacheParts = { m: 'tns', brut: brut };
    } else {
      // ─── Salarié classique ───────────────────────────────────────────────
      // Conversion en équivalent temps plein pour que la réduction générale
      // soit calculée sur le bon salaire horaire (cf. en-tête du fichier).
      let heures = parseFloat(heuresHebdo);
      if (!heures || heures <= 0) heures = 35;
      if (heures > 35) heures = 35; // >35 h : pas de prorata (heures supp = régime spécifique)
      heuresUsed = heures;
      const ratioETP = 35 / heures;
      const brutETP = Math.round(brut * ratioETP * 100) / 100;
      // Garde-fou : un temps plein ne descend jamais sous le SMIC. En dessous,
      // le moteur applique une réduction générale supérieure aux cotisations
      // réductibles → on évalue au SMIC, point de réduction maximale légitime.
      brutEvalue = Math.max(brutETP, SMIC_MENSUEL_TEMPS_PLEIN);

      situation = {
        'salarié . contrat . salaire brut': `${brutEvalue} €/mois`,
      };
      if (cadre) situation['salarié . contrat . statut cadre'] = 'oui';
      else situation['salarié . contrat . statut cadre'] = 'non';
      if (apprenti) situation['salarié . contrat . apprentissage'] = 'oui';
      if (cdd) situation['salarié . contrat . CDD'] = 'oui';
      expressions = [
        'salarié . coût total employeur',
        'salarié . cotisations . employeur',
        'salarié . rémunération . net . à payer avant impôt',
      ];
      // Le taux salarié est invariant d'échelle : il ne dépend que du brut
      // ÉVALUÉ (ETP plafonné SMIC) et des drapeaux de statut/contrat. La clé
      // n'inclut donc PAS le brut réel ni les heures → forte mutualisation.
      cacheParts = {
        m: 'salarie',
        be: brutEvalue,
        cadre: cadre ? 1 : 0,
        appr: apprenti ? 1 : 0,
        cdd: cdd ? 1 : 0,
      };
    }

    // ─── Cache Firestore partagé (lecture) ───────────────────────────────────
    const token = await getAdminToken();
    const cacheKey = buildCacheKey(cacheParts);
    const cached = await cacheGet(cacheKey, token);

    let evaluate;
    if (cached && Array.isArray(cached.evaluate)) {
      evaluate = cached.evaluate;   // profil déjà connu : taux officiel mémorisé
    } else {
      // ─── Circuit breaker : ne pas taper l'URSSAF si l'IP est en cooldown ────
      const now = Date.now();
      const circuit = await circuitGet(token);
      if (circuit.untilMs && now < circuit.untilMs) {
        // Rate-limit en cours → on ne fabrique AUCUN chiffre, on signale juste
        // l'indisponibilité. Le front conserve la dernière valeur connue.
        return res.status(503).json({
          error: 'URSSAF temporairement indisponible',
          unavailable: true,
          reason: 'circuit_open',
          retryAfterSec: Math.ceil((circuit.untilMs - now) / 1000),
        });
      }

      // ─── Appel URSSAF (source de vérité unique pour les taux) ───────────────
      const call = await callUrssaf(expressions, situation);

      if (call.rateLimited) {
        // 429 : armer le breaker (cooldown progressif) et signaler l'indispo.
        const strikes = (circuit.strikes || 0) + 1;
        const cooldownMs = circuitCooldownMs(strikes);
        await circuitSet(token, strikes, now + cooldownMs);
        console.error('[urssaf-cost] 429 → circuit ouvert ' +
          Math.round(cooldownMs / 60000) + ' min (strike ' + strikes + ')');
        return res.status(503).json({
          error: 'URSSAF temporairement indisponible',
          unavailable: true,
          reason: 'rate_limited',
          retryAfterSec: Math.ceil(cooldownMs / 1000),
        });
      }

      if (call.error) {
        console.error('URSSAF API error:', call.status, call.body);
        return res.status(502).json({ error: 'URSSAF API error', status: call.status || 0 });
      }

      const data = await call.ok.json();
      evaluate = data.evaluate || data;
      if (!Array.isArray(evaluate)) {
        return res.status(502).json({ error: 'Format URSSAF inattendu', raw: data });
      }
      // Succès : écriture cache best-effort + réinitialisation du breaker s'il
      // était armé (half-open → fermé).
      cacheSet(cacheKey, { evaluate }, token);
      if (circuit.strikes && circuit.strikes > 0) circuitSet(token, 0, 0);
    }

    const extract = (evalResult) => {
      if (!evalResult) return null;
      if (typeof evalResult.nodeValue === 'number') return Math.round(evalResult.nodeValue * 100) / 100;
      if (typeof evalResult === 'number') return Math.round(evalResult * 100) / 100;
      return null;
    };

    let result;
    if (dirigeant === 'tns') {
      const cotisAnnuelles = extract(evaluate[0]);
      const netAnnuel = extract(evaluate[1]);
      const cotisMens = cotisAnnuelles !== null ? Math.round(cotisAnnuelles / 12 * 100) / 100 : null;
      const tauxEffectif = (cotisMens !== null && brut > 0)
        ? Math.round((cotisMens / brut) * 10000) / 100 : null;
      let netMensuel = netAnnuel !== null ? Math.round(netAnnuel / 12 * 100) / 100 : null;
      if (netMensuel === null && cotisMens !== null) {
        netMensuel = Math.round((brut - cotisMens) * 100) / 100;
      }
      result = {
        mode: 'tns', brutMensuel: brut,
        cotisationsMensuelles: cotisMens,
        coutTotal: cotisMens !== null ? Math.round((brut + cotisMens) * 100) / 100 : null,
        netMensuel,
        tauxEffectif,
      };
    } else {
      // ─── Salarié : taux calculés sur l'ETP, ré-exprimés sur le brut réel ───
      const cotisPatronalesETP = extract(evaluate[1]);
      const netETP = extract(evaluate[2]);

      // Taux effectifs (fractions) — invariants d'échelle : valables aussi bien
      // pour l'équivalent temps plein que pour le brut partiel réel.
      const tauxPatronal = (cotisPatronalesETP !== null && brutEvalue > 0)
        ? cotisPatronalesETP / brutEvalue : null;
      const tauxSalarial = (netETP !== null && brutEvalue > 0)
        ? (brutEvalue - netETP) / brutEvalue : null;

      // Ré-expression sur le brut RÉEL du salarié (temps partiel inclus).
      const cotisationsPatronales = tauxPatronal !== null
        ? Math.round(brut * tauxPatronal * 100) / 100 : null;
      const coutEmployeur = cotisationsPatronales !== null
        ? Math.round((brut + cotisationsPatronales) * 100) / 100 : null;
      const netAvantImpot = tauxSalarial !== null
        ? Math.round(brut * (1 - tauxSalarial) * 100) / 100 : null;
      const tauxEffectif = tauxPatronal !== null
        ? Math.round(tauxPatronal * 10000) / 100 : null;

      result = {
        mode: 'salarie',
        brutMensuel: brut,
        heuresHebdo: heuresUsed,
        brutEquivalentTempsPlein: brutEvalue,
        coutEmployeur,
        cotisationsPatronales,
        netAvantImpot,
        tauxEffectif,
      };
    }
    result.source = 'mon-entreprise.urssaf.fr';
    result.annee = new Date().getFullYear();
    return res.status(200).json(result);
  } catch (e) {
    console.error('urssaf-cost error:', e);
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
};
