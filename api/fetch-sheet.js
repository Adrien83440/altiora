// api/fetch-sheet.js
// Proxy Vercel : liste les onglets d'un Google Sheet public via API v4, puis fetch un onglet en CSV + analyse IA

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url, gid, analyze = false, headerRow = 1 } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL manquante' });

  const GOOGLE_API_KEY = process.env.GOOGLE_SHEETS_API_KEY;
  if (!GOOGLE_API_KEY) return res.status(500).json({ error: 'Clé API Google manquante (GOOGLE_SHEETS_API_KEY)' });

  // ── Extraire l'ID du sheet ──
  const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!idMatch) return res.status(400).json({ error: 'Lien Google Sheets invalide' });
  const sheetId = idMatch[1];

  // ── MODE 1 : Liste des onglets via API v4 ──
  if (gid === undefined || gid === null) {
    try {
      const metaResp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?key=${GOOGLE_API_KEY}&fields=sheets.properties`
      );

      if (!metaResp.ok) {
        const err = await metaResp.json().catch(() => ({}));
        if (metaResp.status === 403) return res.status(403).json({ error: 'Feuille privée — partagez-la en lecture publique.' });
        if (metaResp.status === 404) return res.status(404).json({ error: 'Feuille introuvable — vérifiez le lien.' });
        return res.status(metaResp.status).json({ error: err?.error?.message || `Erreur Google (${metaResp.status})` });
      }

      const meta = await metaResp.json();
      const tabs = (meta.sheets || []).map(s => ({
        gid: String(s.properties.sheetId),
        name: s.properties.title,
      }));

      if (!tabs.length) return res.status(400).json({ error: 'Aucun onglet trouvé dans ce sheet.' });

      return res.status(200).json({ success: true, sheetId, tabs, mode: 'tabs' });

    } catch (e) {
      return res.status(500).json({ error: 'Impossible de lire le sheet : ' + e.message });
    }
  }

  // ── MODE 2 : Charger un onglet spécifique en CSV + analyse IA ──
  // On utilise toujours le CSV export (gratuit, pas de quota) pour les données
  const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  let csvText;
  try {
    const r = await fetch(csvUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Alteore/1.0)' },
      redirect: 'follow',
    });
    if (!r.ok) {
      if (r.status === 403) return res.status(403).json({ error: 'Feuille privée — partagez en lecture publique.' });
      return res.status(r.status).json({ error: `Erreur Google (${r.status})` });
    }
    csvText = await r.text();
  } catch (e) {
    return res.status(500).json({ error: 'Fetch CSV échoué : ' + e.message });
  }

  // ── Parser le CSV ──
  function splitCsvLine(line, sep) {
    const result = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQ = !inQ; }
      else if (c === sep && !inQ) { result.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    result.push(cur.trim());
    return result.map(v => v.replace(/^"|"$/g, '').trim());
  }

  const lines = csvText.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return res.status(400).json({ error: 'Onglet vide ou sans données' });

  // Ligne d'en-tête configurable (1-based), par défaut ligne 1
  const headerIdx = Math.max(0, (parseInt(headerRow) || 1) - 1);
  const firstLine = lines[headerIdx] || lines[0];
  const sep = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
  const headers = splitCsvLine(firstLine, sep).filter(h => h);
  const rows = lines.slice(headerIdx + 1)
    .map(l => {
      const vals = splitCsvLine(l, sep);
      const obj = {};
      headers.forEach((h, i) => { obj[h] = vals[i] !== undefined ? vals[i] : ''; });
      return obj;
    })
    .filter(r => Object.values(r).some(v => String(v).trim()));

  // Nettoyer les valeurs monétaires françaises (20 000,00 € → 20000.00)
  rows.forEach(r => {
    headers.forEach(h => {
      const v = String(r[h] || '');
      const cleaned = v.replace(/\s/g, '').replace('€', '').replace(',', '.');
      if (!isNaN(parseFloat(cleaned)) && cleaned !== '') r[h] = cleaned;
    });
  });

  // ── Analyse IA optionnelle ──
  let aiAnalysis = null;
  if (analyze) {
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
    if (ANTHROPIC_KEY) {
      const sample = rows.slice(0, 8).map(r =>
        headers.map(h => `${h}: ${r[h]}`).join(' | ')
      ).join('\n');

      const prompt = `Tu analyses un onglet Google Sheets importé dans Alteore, SaaS de gestion pour commerçants français.

Entêtes : ${headers.join(', ')}
Exemples (8 lignes) :
${sample}

Réponds UNIQUEMENT en JSON valide, format exact :
{
  "module": "stock" | "pilotage_ca" | "pilotage_charges" | "dettes" | "fidelite_clients" | "mouvements_stock" | "marges" | "inconnu",
  "confidence": 0.0-1.0,
  "reason": "explication courte (<80 chars)",
  "mapping": { "champ_alteore": "nom_colonne_fichier_ou_null" }
}

Champs disponibles par module :
- stock: ref, name, cat, fournisseur, pa, pv, stockBase, min, unite, notes
- pilotage_ca: date, ht055, ht10, ht20, montantHT
- pilotage_charges: fournisseur, type, montantHT, tvaRate, deductible
- dettes: nom, montant, taux, duree, debut, type
- fidelite_clients: prenom, nom, email, telephone, points, dateInscription
- mouvements_stock: date, type, ref, qty, note
- marges: nom, prixVente, coutMP, coutMain, coutIndirect, tvaRate

Attention aux colonnes calculées (Coût total, Coût/unité) → NE PAS mapper, ce sont des formules.
Ne mappe que les colonnes sources. Met null pour les colonnes non trouvées.`;

      try {
        const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 600,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        if (aiResp.ok) {
          const aiData = await aiResp.json();
          const text = aiData.content?.[0]?.text || '';
          try { aiAnalysis = JSON.parse(text.replace(/```json|```/g, '').trim()); }
          catch (e) { aiAnalysis = { module: 'inconnu', confidence: 0, reason: 'Parsing échoué', mapping: {} }; }
        }
      } catch (e) { /* IA optionnelle */ }
    }
  }

  return res.status(200).json({
    success: true,
    sheetId,
    gid,
    headers,
    totalRows: rows.length,
    preview: rows.slice(0, 10),
    rows,
    aiAnalysis,
  });
}
