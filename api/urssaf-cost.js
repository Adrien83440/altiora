// /api/urssaf-cost.js — Coût employeur / net via le MODÈLE OFFICIEL URSSAF
// (paquets npm publicodes + modele-social), exécuté EN LOCAL dans la fonction.
//
// ─── Pourquoi en local (et plus via l'API HTTP) ────────────────────────────
// mon-entreprise.urssaf.fr expose une API publique /api/v1/evaluate, mais elle
// est rate-limitée par IP. Les fonctions Vercel sortent sur des IP mutualisées
// → 429 « Too Many Requests » dès que le volume monte, indépendamment de notre
// code. Or le moteur de ce service est open-source : `publicodes` (l'inter-
// préteur) + `modele-social` (les règles URSSAF). On les embarque et on calcule
// DANS la fonction → AUCUN appel réseau → aucun 429 possible, et EXACTEMENT le
// même résultat que le simulateur officiel (même modèle, même précision).
// Réf : https://mon-entreprise.urssaf.fr/développeur/bibliothèque-de-calcul
//
// Modes :
//   • Salarié classique  : POST { brutMensuel, heuresHebdo, cadre, apprenti, cdd }
//   • TNS                : POST { brutMensuel, dirigeant: 'tns' }
//   • Assimilé dirigeant : POST { brutMensuel, dirigeant: 'assimile' } → forfait
//
// ─── Gestion du temps partiel (correctif réduction générale) ───────────────
// La réduction générale dégressive (RGDU / ex-Fillon) dépend du SALAIRE HORAIRE
// comparé au SMIC, pas du volume d'heures. Le moteur suppose par défaut un
// temps plein 35 h : lui envoyer le brut d'un temps partiel revient à décrire
// un temps plein très en dessous du SMIC → réduction aberrante → taux faussé.
// Solution : le taux de charges étant invariant d'échelle (il ne dépend que du
// salaire horaire), on évalue toujours sur l'ÉQUIVALENT TEMPS PLEIN
//     brutETP = brutMensuel × 35 / heuresHebdo
// puis on ré-exprime coût / cotisations / net sur le brut réel du salarié.
// Garde-fou : un temps plein ne peut être sous le SMIC → on plafonne au SMIC.
//
// ─── Pourquoi un forfait pour l'assimilé dirigeant ? ───────────────────────
// Les mandataires sociaux (président SAS/SASU, gérant minoritaire SARL) sont
// exclus de la réduction générale. On applique des taux URSSAF de référence
// stables : Patronal 42 % / Salarial 22 % (précis à ±1-2 pts sur 1 500-10 000 €).

// SMIC mensuel brut temps plein (35 h). Plancher anti sur-réduction.
// ⚠️ À actualiser à chaque revalorisation du SMIC (révision annuelle au 1ᵉʳ janvier).
const SMIC_MENSUEL_TEMPS_PLEIN = 1850;

// ───────────────────────────────────────────────────────────────────────────
// Moteur officiel (publicodes + modele-social), chargé EN LOCAL.
//
// Les deux paquets sont publiés en ESM ; ce fichier est en CommonJS → on les
// charge via import() dynamique (supporté Node 18+ / Vercel).
//
// Le parsing du modèle (des centaines de règles) est coûteux : on instancie le
// moteur UNE fois par instance chaude (promesse mémorisée). Chaque requête
// travaille ensuite sur une COPIE isolée (shallowCopy) afin de ne JAMAIS
// mélanger les situations entre requêtes concurrentes (runtime Fluid). Si
// shallowCopy n'est pas disponible, on ré-instancie (plus lent mais sûr).
// En cas d'échec d'import, la promesse est réinitialisée pour permettre un
// nouvel essai à la requête suivante (pas de blocage figé).
// ───────────────────────────────────────────────────────────────────────────
let _rulesPromise = null;
let _baseEnginePromise = null;

async function loadEngineClass() {
  const mod = await import('publicodes');
  return mod.default || mod.Engine || mod;
}

async function loadRules() {
  if (!_rulesPromise) {
    _rulesPromise = import('modele-social')
      .then((m) => m.default || m)
      .catch((e) => { _rulesPromise = null; throw e; });
  }
  return _rulesPromise;
}

async function getBaseEngine() {
  if (!_baseEnginePromise) {
    _baseEnginePromise = (async () => {
      const Engine = await loadEngineClass();
      const rules = await loadRules();
      return new Engine(rules);
    })().catch((e) => { _baseEnginePromise = null; throw e; });
  }
  return _baseEnginePromise;
}

// Renvoie un moteur isolé pour CETTE requête (situation propre).
async function freshEngine() {
  const base = await getBaseEngine();
  if (base && typeof base.shallowCopy === 'function') {
    return base.shallowCopy();
  }
  // Fallback ultra-sûr : nouvelle instance (re-parse le modèle).
  const Engine = await loadEngineClass();
  const rules = await loadRules();
  return new Engine(rules);
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

    // ─── Court-circuit : dirigeant assimilé salarié (forfait, déterministe) ───
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
    let brutEvalue = brut;   // brut réellement transmis au moteur
    let heuresUsed = 35;

    if (dirigeant === 'tns') {
      situation = {
        'dirigeant . indépendant . revenu professionnel': `${brut * 12} €/an`,
      };
      expressions = [
        'dirigeant . indépendant . cotisations et contributions',
        'dirigeant . indépendant . revenu net de cotisations',
      ];
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
      // Garde-fou : un temps plein ne descend jamais sous le SMIC.
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
    }

    // ─── Calcul LOCAL via le moteur officiel (publicodes + modele-social) ────
    // Aucun appel réseau : le calcul tourne dans la fonction, avec le MÊME
    // modèle que mon-entreprise.urssaf.fr. Plus de 429, plus de dépendance IP.
    let evaluate;
    try {
      const engine = await freshEngine();
      engine.setSituation(situation);
      evaluate = expressions.map((expr) => engine.evaluate(expr));
    } catch (e) {
      console.error('[urssaf-cost] moteur publicodes indisponible:', e && e.message);
      return res.status(503).json({
        error: 'Calcul URSSAF momentanément indisponible',
        unavailable: true,
        reason: 'engine_error',
      });
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
    result.source = 'modele-social (URSSAF · calcul local)';
    result.annee = new Date().getFullYear();
    return res.status(200).json(result);
  } catch (e) {
    console.error('urssaf-cost error:', e);
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
};
