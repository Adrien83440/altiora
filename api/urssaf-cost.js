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

// SMIC mensuel brut temps plein (35 h). Plancher anti sur-réduction.
// ⚠️ À actualiser à chaque revalorisation du SMIC (révision annuelle au 1ᵉʳ janvier).
const SMIC_MENSUEL_TEMPS_PLEIN = 1850;

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
    }

    const response = await fetch('https://mon-entreprise.urssaf.fr/api/v1/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ expressions, situation }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('URSSAF API error:', response.status, text);
      return res.status(502).json({ error: 'URSSAF API error', status: response.status });
    }

    const data = await response.json();
    const extract = (evalResult) => {
      if (!evalResult) return null;
      if (typeof evalResult.nodeValue === 'number') return Math.round(evalResult.nodeValue * 100) / 100;
      if (typeof evalResult === 'number') return Math.round(evalResult * 100) / 100;
      return null;
    };

    const evaluate = data.evaluate || data;
    if (!Array.isArray(evaluate)) {
      return res.status(502).json({ error: 'Format URSSAF inattendu', raw: data });
    }

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
