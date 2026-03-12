// /api/urssaf-cost.js — Proxy vers l'API mon-entreprise.urssaf.fr
// Calcule le coût employeur réel à partir du brut mensuel
// Usage : POST /api/urssaf-cost { brutMensuel: 1800, cadre: false, apprenti: false, cdd: false }

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { brutMensuel, cadre, apprenti, cdd } = req.body || {};
    const brut = parseFloat(brutMensuel);
    if (!brut || brut <= 0) return res.status(400).json({ error: 'brutMensuel requis (> 0)' });

    // Construire la situation pour l'API URSSAF
    const situation = {
      'salarié . contrat . salaire brut': `${brut} €/mois`,
    };

    if (cadre) situation['salarié . contrat . statut cadre'] = 'oui';
    else situation['salarié . contrat . statut cadre'] = 'non';

    if (apprenti) situation['salarié . contrat . apprentissage'] = 'oui';
    if (cdd) situation['salarié . contrat . CDD'] = 'oui';

    const expressions = [
      'salarié . coût total employeur',
      'salarié . cotisations . employeur',
      'salarié . rémunération . net . à payer avant impôt',
    ];

    const response = await fetch('https://mon-entreprise.urssaf.fr/api/v1/evaluate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ expressions, situation }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('URSSAF API error:', response.status, text);
      return res.status(502).json({ error: 'URSSAF API error', status: response.status });
    }

    const data = await response.json();

    // Extraire les valeurs
    const extract = (evalResult) => {
      if (!evalResult) return null;
      // L'API renvoie { nodeValue: number, unit: {...} } ou directement un nombre
      if (typeof evalResult.nodeValue === 'number') return Math.round(evalResult.nodeValue * 100) / 100;
      if (typeof evalResult === 'number') return Math.round(evalResult * 100) / 100;
      return null;
    };

    const evaluate = data.evaluate || data;
    let coutTotal = null, cotisPatronales = null, netAvantImpot = null;

    if (Array.isArray(evaluate)) {
      coutTotal = extract(evaluate[0]);
      cotisPatronales = extract(evaluate[1]);
      netAvantImpot = extract(evaluate[2]);
    }

    // Calculer le taux effectif de charges patronales
    const tauxEffectif = (cotisPatronales && brut > 0)
      ? Math.round((cotisPatronales / brut) * 10000) / 100
      : null;

    return res.status(200).json({
      brutMensuel: brut,
      coutEmployeur: coutTotal,
      cotisationsPatronales: cotisPatronales,
      netAvantImpot,
      tauxEffectif,
      source: 'mon-entreprise.urssaf.fr',
      annee: new Date().getFullYear(),
    });

  } catch (e) {
    console.error('urssaf-cost error:', e);
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
};
