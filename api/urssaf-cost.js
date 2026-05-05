// /api/urssaf-cost.js — Proxy vers l'API mon-entreprise.urssaf.fr (TNS et salariés)
// + calcul forfaitaire pour dirigeants assimilés salariés (SAS/SASU/SARL minoritaire)
//
// Calcule le coût employeur et le net mensuel pour :
//   • Salarié classique : POST { brutMensuel, cadre, apprenti, cdd } → API URSSAF (RGDU/Fillon inclus)
//   • TNS               : POST { brutMensuel, dirigeant: 'tns' }     → API URSSAF (régime indépendant)
//   • Assimilé dirigeant : POST { brutMensuel, dirigeant: 'assimile' } → forfait 42% patronal / 22% salarial
//
// Pourquoi un forfait pour l'assimilé dirigeant ?
// Le moteur Publicodes URSSAF applique par défaut la réduction générale dégressive
// (RGDU / ex-Fillon) sur tout namespace `salarié . ...`. Or les mandataires sociaux
// (président SAS/SASU, gérant minoritaire SARL) en sont **explicitement exclus**.
// Source officielle : https://mon-entreprise.urssaf.fr/simulateurs/sasu
//   « Le dirigeant assimilé-salarié ne paye pas de cotisations chômage. Par ailleurs,
//     il ne bénéficie pas de la réduction générale dégressive unique de cotisations »
// Sans neutralisation explicite (catégorie juridique + ACRE non), l'API renvoie un
// taux faussement bas (~13-14% à 2 000 € au lieu de ~42%). On applique donc des
// taux URSSAF de référence stables qui ne dépendent pas du moteur Publicodes :
//   • Patronal : 42 % (URSSAF + Agirc-Arrco + AT/MP, hors chômage exclu)
//   • Salarial : 22 % (URSSAF + retraite cadre + CSG/CRDS)
// Précis à ±1-2 points sur la plage 1 500 € – 10 000 € de brut mensuel.

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { brutMensuel, cadre, apprenti, cdd, dirigeant } = req.body || {};
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

    if (dirigeant === 'tns') {
      situation = {
        'dirigeant . indépendant . revenu professionnel': `${brut * 12} €/an`,
      };
      expressions = [
        'dirigeant . indépendant . cotisations et contributions',
        'dirigeant . indépendant . revenu net de cotisations',
      ];
    } else {
      // Salarié classique (RGDU/Fillon appliquée par le moteur, c'est ce qu'on veut)
      situation = {
        'salarié . contrat . salaire brut': `${brut} €/mois`,
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
      // Le moteur Publicodes ne renvoie pas toujours `revenu net de cotisations` selon
      // les versions du modèle. Fallback fiable : net = brut - cotisations mensuelles.
      // (l'URSSAF prélève les cotisations sur la rémunération brute du TNS, donc
      // le net qui reste effectivement = brut - cotisations).
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
      const coutTotal = extract(evaluate[0]);
      const cotisPatronales = extract(evaluate[1]);
      const netAvantImpot = extract(evaluate[2]);
      const tauxEffectif = (cotisPatronales !== null && brut > 0)
        ? Math.round((cotisPatronales / brut) * 10000) / 100 : null;
      result = {
        mode: 'salarie',
        brutMensuel: brut, coutEmployeur: coutTotal,
        cotisationsPatronales: cotisPatronales,
        netAvantImpot, tauxEffectif,
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
