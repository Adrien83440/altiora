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

  // Détecter le séparateur
  const sampleLines = lines.slice(0, 3).join('\n');
  const sep = sampleLines.split(';').length > sampleLines.split(',').length ? ';' : ',';

  // ── Utilitaires ──
  function norm(s) { return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim(); }

  function cleanMonetary(rows2, headers2) {
    rows2.forEach(r => {
      headers2.forEach(h => {
        const v = String(r[h] || '');
        const cleaned = v.replace(/\s/g, '').replace('€', '').replace(',', '.');
        if (!isNaN(parseFloat(cleaned)) && cleaned !== '') r[h] = cleaned;
      });
    });
  }

  // ── Trouver la ligne d'en-tête (scoring) ──
  const HEADER_KW = ['fournisseur','type','montant','date','tva','deductible','pointe','total','nom','ref','prix','stock','email'];

  function scoreRow(line) {
    const cells = splitCsvLine(line, sep);
    const nonEmpty = cells.filter(c => c && c.trim());
    if (nonEmpty.length < 3) return -1;
    let score = nonEmpty.length;
    nonEmpty.forEach(c => {
      const low = norm(c);
      if (HEADER_KW.some(k => low.includes(k))) score += 5;
      if (low.length < 20) score += 1;
      if (/^\d+([.,]\d+)?$/.test(low.replace(/\s/g, ''))) score -= 3;
      if (low.length > 30) score -= 3;
    });
    return score;
  }

  let headerIdx = Math.max(0, (parseInt(headerRow) || 1) - 1);
  if (headerIdx === 0 && lines.length >= 3) {
    const maxCheck = Math.min(5, lines.length);
    let bestScore = scoreRow(lines[0]), bestIdx = 0;
    for (let i = 1; i < maxCheck; i++) {
      const s = scoreRow(lines[i]);
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    headerIdx = bestIdx;
  }

  // ── Parser les headers avec déduplication + index positionnel ──
  const rawHeaders = splitCsvLine(lines[headerIdx] || lines[0], sep);
  const headerMap = [], seen = {};
  rawHeaders.forEach((h, idx) => {
    if (!h || !h.trim()) return;
    let name = h.trim();
    if (seen[name]) { seen[name]++; name = `${name} (${seen[name]})`; } else { seen[name] = 1; }
    headerMap.push({ name, idx });
  });
  const headers = headerMap.map(h => h.name);

  // ── Parser les lignes de données ──
  const rows = lines.slice(headerIdx + 1)
    .map(l => {
      const vals = splitCsvLine(l, sep);
      const obj = {};
      headerMap.forEach(h => { obj[h.name] = vals[h.idx] !== undefined ? vals[h.idx] : ''; });
      return obj;
    })
    .filter(r => Object.values(r).some(v => String(v).trim()));
  cleanMonetary(rows, headers);

  // ══════════════════════════════════════════════════════════════════
  // DÉTECTION DU TEMPLATE "TABLEAU PILOTAGE COMPLET ALTEORE"
  // Signature : POINTÉ ×2+, FOURNISSEUR ×2+, DATE ×1, MONTANT HT ×2+
  // Structure fixe : Charges fixes | Charges variables | [Crédits] | CA journalier
  // ══════════════════════════════════════════════════════════════════
  let sections = null;

  const normHeaders = rawHeaders.map(h => norm(h));
  const pointeCount = normHeaders.filter(h => h === 'pointe').length;
  const fournCount = normHeaders.filter(h => h === 'fournisseur').length;
  const hasDate = normHeaders.some(h => h === 'date');
  const isAlteoreTemplate = pointeCount >= 2 && fournCount >= 2 && hasDate;

  if (isAlteoreTemplate) {
    console.log(`[fetch-sheet] ✅ Template Alteore détecté (POINTÉ×${pointeCount} FOURNISSEUR×${fournCount} DATE=true)`);

    // Trouver les positions clés dans les headers bruts
    const pointePositions = [];
    const datePosition = normHeaders.indexOf('date');
    normHeaders.forEach((h, i) => { if (h === 'pointe') pointePositions.push(i); });

    // Section definitions basées sur les positions réelles
    const secDefs = [];

    // Charges fixes : du 1er POINTÉ au 2ème POINTÉ
    if (pointePositions.length >= 2) {
      secDefs.push({
        name: 'Charges fixes', module: 'pilotage_charges_fixe',
        startCol: pointePositions[0], endCol: pointePositions[1]
      });
    }

    // Charges variables : du 2ème POINTÉ au 3ème POINTÉ (ou au DATE, ou au prochain bloc)
    if (pointePositions.length >= 2) {
      const endCV = pointePositions.length >= 3 ? pointePositions[2] : (datePosition > pointePositions[1] ? datePosition : rawHeaders.length);
      secDefs.push({
        name: 'Charges variables', module: 'pilotage_charges_var',
        startCol: pointePositions[1], endCol: endCV
      });
    }

    // CA journalier : à partir de DATE
    if (datePosition >= 0) {
      // Trouver la fin du bloc CA : 5 colonnes après DATE (DATE, MONTANT HT, TVA, Total TTC, COLLECTÉE)
      const endCA = Math.min(datePosition + 5, rawHeaders.length);
      secDefs.push({
        name: 'CA Journalier', module: 'pilotage_ca',
        startCol: datePosition, endCol: endCA
      });
    }

    // Construire les sections
    if (secDefs.length >= 2) {
      sections = secDefs.map(sec => {
        const secHeaders = [];
        for (let i = sec.startCol; i < sec.endCol; i++) {
          const raw = (rawHeaders[i] || '').trim();
          if (!raw) continue;
          secHeaders.push({ name: raw, idx: i });
        }
        const secHeaderNames = secHeaders.map(h => h.name);

        const secRows = lines.slice(headerIdx + 1)
          .map(l => {
            const vals = splitCsvLine(l, sep);
            const obj = {};
            secHeaders.forEach(h => { obj[h.name] = vals[h.idx] !== undefined ? vals[h.idx] : ''; });
            return obj;
          })
          .filter(r => {
            return Object.values(r).some(v => {
              const s = String(v).replace(/\s/g,'').replace('€','').replace(',','.').trim();
              return s && s !== '0' && s !== '0.00' && s !== '-' && norm(s) !== 'pointe';
            });
          });
        cleanMonetary(secRows, secHeaderNames);

        // Mapping déterministe
        const mapping = {};
        const low = secHeaderNames.map(n => norm(n));
        if (sec.module === 'pilotage_ca') {
          const dCol = secHeaderNames.find((_, i) => low[i] === 'date');
          const hCol = secHeaderNames.find((_, i) => low[i] === 'montant ht');
          if (dCol) mapping.date = dCol;
          if (hCol) mapping.montantHT = hCol;
        } else {
          const fCol = secHeaderNames.find((_, i) => low[i] === 'fournisseur');
          const tCol = secHeaderNames.find((_, i) => low[i] === 'type');
          const hCol = secHeaderNames.find((_, i) => low[i] === 'montant ht');
          const vCol = secHeaderNames.find((_, i) => low[i] === 'tva');
          const dCol = secHeaderNames.find((_, i) => low[i] === 'deductible');
          if (fCol) mapping.fournisseur = fCol;
          if (tCol) mapping.type = tCol;
          if (hCol) mapping.montantHT = hCol;
          if (vCol) mapping.tvaRate = vCol;
          if (dCol) mapping.deductible = dCol;
        }

        return { name: sec.name, module: sec.module, headers: secHeaderNames, totalRows: secRows.length, rows: secRows, mapping };
      }).filter(s => s.totalRows > 0);

      if (sections.length < 2) sections = null;
    }
  }

  // ── Analyse IA (seulement si PAS de template détecté) ──
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

  console.log(`[fetch-sheet] gid=${gid} headerIdx=${headerIdx} headers=${headers.length} rows=${rows.length} template=${isAlteoreTemplate} sections=${sections?sections.length:0}`);

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
    _debug: { headerIdx, isAlteoreTemplate, sectionsCount: sections ? sections.length : 0, pointeCount, fournCount },
  });
}
