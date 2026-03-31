// api/fetch-sheet.js
// Proxy Vercel : liste les onglets d'un Google Sheet public via API v4, puis fetch un onglet en CSV + analyse IA
// SÉCURISÉ : vérification token Firebase

export const config = { maxDuration: 30 };

// ── Vérification du token Firebase côté serveur ──
async function verifyFirebaseToken(idToken) {
  const fbKey = process.env.FIREBASE_API_KEY;
  if (!fbKey) throw new Error('FIREBASE_API_KEY non configurée');
  const res = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + fbKey,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    }
  );
  if (!res.ok) throw new Error('Token invalide');
  const data = await res.json();
  const uid = data.users?.[0]?.localId;
  if (!uid) throw new Error('Utilisateur introuvable');
  return uid;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://alteore.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── AUTH : vérifier le token Firebase ──
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    return res.status(401).json({ error: "Token d'authentification manquant." });
  }
  try {
    await verifyFirebaseToken(token);
  } catch (e) {
    return res.status(401).json({ error: 'Token invalide.' });
  }

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

  // Détecter le séparateur depuis la première ligne non-vide
  const firstLine = lines[0];
  const sep = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';

  // ── Auto-détection de la ligne d'en-tête ──
  // Si headerRow=1 (défaut), on vérifie si la ligne 1 est un titre (beaucoup de cellules vides)
  // et on descend automatiquement à la prochaine ligne avec plus de colonnes remplies
  let headerIdx = Math.max(0, (parseInt(headerRow) || 1) - 1);

  if (headerIdx === 0 && lines.length >= 3) {
    const countNonEmpty = (line) => splitCsvLine(line, sep).filter(h => h && h.trim()).length;
    const countTotal = (line) => splitCsvLine(line, sep).length;
    const row1filled = countNonEmpty(lines[0]);
    const row1total = countTotal(lines[0]);
    const row2filled = countNonEmpty(lines[1]);

    // Si la ligne 1 a < 50% de cellules remplies ET la ligne 2 en a plus → c'est un titre
    if (row1total > 3 && row1filled < row1total * 0.5 && row2filled > row1filled) {
      headerIdx = 1; // utiliser la ligne 2 comme en-tête
    }
  }

  const headerLine = lines[headerIdx] || lines[0];
  const rawHeaders = splitCsvLine(headerLine, sep);

  // Construire les headers avec index correct + déduplication
  // On garde la position réelle de chaque colonne pour aligner avec les données
  const headerMap = []; // [{name, idx}] — colonnes non-vides avec leur position
  const seen = {};
  rawHeaders.forEach((h, idx) => {
    if (!h || !h.trim()) return; // ignorer les colonnes vides
    let name = h.trim();
    // Dédupliquer : FOURNISSEUR, FOURNISSEUR (2), FOURNISSEUR (3)...
    if (seen[name]) {
      seen[name]++;
      name = `${name} (${seen[name]})`;
    } else {
      seen[name] = 1;
    }
    headerMap.push({ name, idx });
  });

  const headers = headerMap.map(h => h.name);
  const rows = lines.slice(headerIdx + 1)
    .map(l => {
      const vals = splitCsvLine(l, sep);
      const obj = {};
      headerMap.forEach(h => { obj[h.name] = vals[h.idx] !== undefined ? vals[h.idx] : ''; });
      return obj;
    })
    .filter(r => Object.values(r).some(v => String(v).trim()));

  // Nettoyer les valeurs monétaires françaises (20 000,00 € → 20000.00)
  function cleanMonetary(rows2, headers2) {
    rows2.forEach(r => {
      headers2.forEach(h => {
        const v = String(r[h] || '');
        const cleaned = v.replace(/\s/g, '').replace('€', '').replace(',', '.');
        if (!isNaN(parseFloat(cleaned)) && cleaned !== '') r[h] = cleaned;
      });
    });
  }
  cleanMonetary(rows, headers);

  // ── Détection automatique des sections (multi-blocs dans un même onglet) ──
  let sections = null;
  if (headerIdx === 1 && lines.length >= 3) {
    const titleCells = splitCsvLine(lines[0], sep);
    const sectionDefs = [];

    titleCells.forEach((cell, colIdx) => {
      const t = String(cell || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
      if (!t || t.length < 4) return;
      // Ignorer les lignes de total / TVA déductible
      if (t.includes('TOTAL') && !t.includes('PREVISIONNEL') && !t.includes('PREVISION')) return;
      if (t.includes('TVA DEDUCTIBLE') || t.includes('TVA DUE')) return;

      if (t.includes('CHARGES FIXES') || t.includes('CHARGE FIXE')) {
        sectionDefs.push({ startCol: colIdx, module: 'pilotage_charges_fixe', name: 'Charges fixes' });
      } else if (t.includes('CHARGES VARIABLES') || t.includes('CHARGE VARIABLE')) {
        sectionDefs.push({ startCol: colIdx, module: 'pilotage_charges_var', name: 'Charges variables' });
      } else if (t.includes('CA JOURNALIER') || t.includes('CA JOUR')) {
        sectionDefs.push({ startCol: colIdx, module: 'pilotage_ca', name: 'CA Journalier' });
      } else if ((t.includes('CREDIT') || t.includes('EMPRUNT')) && !t.includes('RESULTAT')) {
        sectionDefs.push({ startCol: colIdx, module: 'dettes', name: 'Crédits & Emprunts' });
      } else if (t.includes('LEASING') || t.includes('LOA') || t.includes('LLD')) {
        sectionDefs.push({ startCol: colIdx, module: 'leasing', name: 'Leasing / LOA' });
      }
    });

    if (sectionDefs.length >= 2) {
      sectionDefs.sort((a, b) => a.startCol - b.startCol);
      for (let i = 0; i < sectionDefs.length; i++) {
        sectionDefs[i].endCol = (i + 1 < sectionDefs.length) ? sectionDefs[i + 1].startCol : rawHeaders.length;
      }

      sections = sectionDefs.map(sec => {
        // Headers de cette section (sans suffixe de déduplication)
        const secHeaders = headerMap
          .filter(h => h.idx >= sec.startCol && h.idx < sec.endCol)
          .map(h => ({ name: h.name.replace(/ \(\d+\)$/, ''), idx: h.idx }));
        const secHeaderNames = secHeaders.map(h => h.name);

        // Extraire les lignes de cette section
        const secRows = lines.slice(headerIdx + 1)
          .map(l => {
            const vals = splitCsvLine(l, sep);
            const obj = {};
            secHeaders.forEach(h => { obj[h.name] = vals[h.idx] !== undefined ? vals[h.idx] : ''; });
            return obj;
          })
          .filter(r => {
            return Object.values(r).some(v => {
              const s = String(v).replace(/\s/g, '').replace('€', '').replace(',', '.').trim();
              return s && s !== '0' && s !== '0.00' && s !== '0,00' && s !== '-' && s !== 'POINTE';
            });
          });

        cleanMonetary(secRows, secHeaderNames);

        // Mapping déterministe selon le type de section
        const mapping = {};
        const lower = secHeaderNames.map(n => n.toLowerCase());

        if (sec.module === 'pilotage_ca') {
          const dateCol = secHeaderNames.find((_, i) => lower[i].includes('date'));
          const htCol = secHeaderNames.find((_, i) => lower[i] === 'montant ht' || lower[i] === 'montantht');
          if (dateCol) mapping.date = dateCol;
          if (htCol) mapping.montantHT = htCol;
        } else {
          const fournCol = secHeaderNames.find((_, i) => lower[i].includes('fournisseur'));
          const typeCol = secHeaderNames.find((_, i) => lower[i] === 'type');
          const htCol = secHeaderNames.find((_, i) => (lower[i].includes('montant ht') || lower[i] === 'montant') && !lower[i].includes('total'));
          const deducCol = secHeaderNames.find((_, i) => lower[i].includes('deductible'));
          if (fournCol) mapping.fournisseur = fournCol;
          if (typeCol) mapping.type = typeCol;
          if (htCol) mapping.montantHT = htCol;
          if (deducCol) mapping.deductible = deducCol;
        }

        return {
          name: sec.name,
          module: sec.module,
          headers: secHeaderNames,
          totalRows: secRows.length,
          rows: secRows,
          mapping,
        };
      }).filter(s => s.totalRows > 0);

      if (sections.length < 2) sections = null; // Pas assez de sections valides → fallback normal
    }
  }

  // ── Analyse IA optionnelle (seulement si pas de sections détectées) ──
  let aiAnalysis = null;
  if (analyze && !sections) {
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
  "module": "stock" | "pilotage_ca" | "pilotage_charges_fixe" | "pilotage_charges_var" | "pilotage_charges" | "dettes" | "fidelite_clients" | "mouvements_stock" | "marges" | "inconnu",
  "confidence": 0.0-1.0,
  "reason": "explication courte (<80 chars)",
  "mapping": { "champ_alteore": "nom_colonne_fichier_ou_null" }
}

Champs disponibles par module :
- stock: ref, name, cat, fournisseur, pa, pv, stockBase, min, unite, notes
- pilotage_ca: date, ht055, ht10, ht20, montantHT
- pilotage_charges_fixe: fournisseur, type, montantHT, tvaRate, deductible
- pilotage_charges_var: fournisseur, type, montantHT, tvaRate, deductible
- pilotage_charges: fournisseur, type, montantHT, tvaRate, deductible
- dettes: nom, montant, taux, duree, debut, type
- fidelite_clients: prenom, nom, email, telephone, points, dateInscription
- mouvements_stock: date, type, ref, qty, note
- marges: nom, prixVente, coutMP, coutMain, coutIndirect, tvaRate

RÈGLES IMPORTANTES :
- Si un onglet contient des colonnes dédupliquées (ex: "FOURNISSEUR" et "FOURNISSEUR (2)"), c'est que le tableur a 2 sections côte à côte (souvent charges fixes + charges variables). Utilise les colonnes SANS suffixe "(2)" pour le mapping et choisis le module "pilotage_charges_fixe".
- Les colonnes "POINTÉ", "Total TTC" sont des colonnes UI/calculées → ne PAS mapper.
- Colonne TVA : si les valeurs sont 1.2, 1.1, 1.055 c'est un coefficient, PAS un taux. Ne pas mapper en tvaRate.
- Attention aux colonnes calculées (Coût total, Coût/unité) → NE PAS mapper, ce sont des formules.
- Ne mappe que les colonnes sources. Met null pour les colonnes non trouvées.`;

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
    sections: sections || null,
  });
}
