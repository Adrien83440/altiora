// /api/urssaf-cost.js — Proxy vers l'API mon-entreprise.urssaf.fr
// Calcule le coût employeur réel (après RGDU/Fillon) pour salariés ET dirigeants
// POST { brutMensuel: 2000, cadre: false, apprenti: false, cdd: false }
// POST { brutMensuel: 2500, dirigeant: 'tns' }
// POST { brutMensuel: 2500, dirigeant: 'assimile' }

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

    let expressions, situation;

    if (dirigeant === 'tns') {
      situation = {
        'dirigeant . indépendant . revenu professionnel': `${brut * 12} €/an`,
      };
      expressions = [
        'dirigeant . indépendant . cotisations et contributions',
        'dirigeant . indépendant . revenu net de cotisations',
      ];
    } else if (dirigeant === 'assimile') {
      situation = {
        'salarié . contrat . salaire brut': `${brut} €/mois`,
        'salarié . contrat . statut cadre': 'oui',
      };
      expressions = [
        'salarié . coût total employeur',
        'salarié . cotisations . employeur',
        'salarié . rémunération . net . à payer avant impôt',
      ];
    } else {
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
      result = {
        mode: 'tns', brutMensuel: brut,
        cotisationsMensuelles: cotisMens,
        coutTotal: cotisMens !== null ? Math.round((brut + cotisMens) * 100) / 100 : null,
        netMensuel: netAnnuel !== null ? Math.round(netAnnuel / 12 * 100) / 100 : null,
        tauxEffectif,
      };
    } else {
      const coutTotal = extract(evaluate[0]);
      const cotisPatronales = extract(evaluate[1]);
      const netAvantImpot = extract(evaluate[2]);
      const tauxEffectif = (cotisPatronales !== null && brut > 0)
        ? Math.round((cotisPatronales / brut) * 10000) / 100 : null;
      result = {
        mode: dirigeant === 'assimile' ? 'assimile' : 'salarie',
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
