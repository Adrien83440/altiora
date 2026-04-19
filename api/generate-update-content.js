// api/generate-update-content.js
// ══════════════════════════════════════════════════════════════════
// Génère automatiquement le contenu d'une update (nouveauté) à partir
// d'une description libre fournie par l'admin.
//
// Utilise Claude Haiku 4.5 (rapide, peu cher : ~0,1¢ par génération).
//
// Input : {
//   description: string (1-2 phrases de ce que tu as fait),
//   version?: string (ex: "Wave 5"),
//   suggested_badge?: string (ex: "New" | "Fix" | "Amélioration"),
// }
//
// Output : {
//   title: string,
//   emoji: string,
//   badge: "New" | "Fix" | "Amélioration",
//   short: string (~200 chars),
//   long_html: string (HTML avec <p>, <ul>, <li>, <strong>, <em>),
// }
//
// Sécurité :
//   - Requiert Authorization Bearer <idToken>
//   - Vérifie que l'email = contact@adrienemily.com (admin)
// ══════════════════════════════════════════════════════════════════

const FB_KEY = 'AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4';
const ADMIN_EMAIL = 'contact@adrienemily.com';

const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const CLAUDE_MAX_TOKENS = 1500;

// ══════════════════════════════════════════════════════════════════
// Prompt system avec les 4 news existantes comme exemples few-shot
// ══════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `Tu es rédacteur de release notes pour Alteore, un SaaS de gestion pour TPE/PME (commerçants, artisans, restaurateurs, agences).

Ton job : générer des news d'updates produit lisibles, claires et directes, dans le style Alteore.

# STYLE ALTEORE (OBLIGATOIRE)
- Tutoiement systématique ("tu peux", "tu reçois")
- Ton direct et concret, jamais marketing ou corporate
- Phrases courtes, verbes d'action
- Exemples concrets quand c'est pertinent
- Emojis : 1-2 max dans les titres/résumés, sobres dans le HTML long
- Jamais de "nous sommes heureux de vous annoncer" ou autre blabla
- Pas de superlatifs creux ("incroyable", "révolutionnaire")

# EXEMPLES DE NEWS ALTEORE (few-shot)

## Exemple 1 (type Amélioration)
Description fournie : "J'ai ajouté 12 nouveaux tools à Léa pour qu'elle lise le planning RH, les congés, le cashflow, les dettes, les bilans, etc."

Sortie attendue :
{
  "title": "Léa voit tout Alteore",
  "emoji": "🔍",
  "badge": "Amélioration",
  "short": "Léa a désormais accès en lecture à 12 nouveaux modules : planning RH, émargements, congés, cashflow, dettes, profil, fournisseurs, cartes cadeaux, panier moyen, bilans, objectifs RH et recrutement.",
  "long_html": "<p>Léa peut maintenant répondre à toutes tes questions sur :</p><ul><li><strong>RH</strong> : planning, émargements, congés complets, objectifs par employé, recrutements en cours.</li><li><strong>Finance</strong> : cashflow, dettes/emprunts/leasings, bilans comptables annuels.</li><li><strong>Commerce</strong> : panier moyen mois par mois, cartes cadeaux.</li><li><strong>Structure</strong> : profil entreprise, liste fournisseurs.</li></ul><p>Au total, Léa a désormais accès à <strong>19 tools de lecture</strong> sur toute ta base de données Alteore.</p>"
}

## Exemple 2 (type New)
Description fournie : "Chaque matin à 8h les utilisateurs reçoivent un email avec un score de santé, des alertes, des actions à faire pour la journée. C'est généré par Léa automatiquement."

Sortie attendue :
{
  "title": "Briefing matinal quotidien par email",
  "emoji": "🌅",
  "badge": "New",
  "short": "Chaque matin à 8h, tu reçois ton briefing personnalisé : score santé, résumé de la veille, alertes, actions du jour et conclusion motivante. Généré par Léa, livré par email.",
  "long_html": "<p><strong>Ce que tu vas recevoir chaque matin :</strong></p><ul><li><strong>Score santé 0-100</strong> calculé sur 4 axes : trésorerie, tendance CA, stock, marge indicative.</li><li><strong>Alertes prioritaires</strong> : tréso tendue, ruptures stock, chute CA, congés à traiter, absents du jour.</li><li><strong>Points clés</strong> avec tes chiffres réels — jamais inventés.</li><li><strong>2 à 4 actions du jour</strong> concrètes et réalisables dans la journée.</li></ul><p>Le briefing s'envoie automatiquement à 8h Paris. Pour le désactiver, utilise le lien en bas de l'email.</p>"
}

## Exemple 3 (type Amélioration UX)
Description fournie : "J'ai simplifié le vocal de l'app mobile. Avant c'était une conversation continue, maintenant c'est juste tap pour parler, ça détecte la fin toute seule, et ça répond dans le chat."

Sortie attendue :
{
  "title": "App mobile Léa — vocal simplifié",
  "emoji": "🎙️",
  "badge": "Amélioration",
  "short": "Sur l'app mobile Léa, tap sur le micro pour parler. Léa détecte automatiquement que tu as fini (2,5 secondes de silence) et répond dans le chat.",
  "long_html": "<p><strong>Nouvelle expérience vocale :</strong></p><ul><li>Tap sur le micro pour démarrer</li><li>Parle normalement (la transcription s'affiche en direct)</li><li>Arrête-toi — après 2,5 secondes de silence, Léa envoie ta question automatiquement</li><li>Réponse dans le chat, avec bouton 🔊 pour écouter la belle voix de Léa si tu veux</li></ul><p>Plus simple, plus fiable. Si tu veux couper plus tôt, le bouton <strong>Terminer</strong> est toujours là.</p>"
}

## Exemple 4 (type New avec exemples concrets)
Description fournie : "Léa peut maintenant corriger des lignes de CA, modifier des charges, créer des produits stock, faire des fiches marge. Elle fait tout ça depuis l'app mobile quand on lui dicte."

Sortie attendue :
{
  "title": "Léa peut maintenant corriger, créer et modifier tes données",
  "emoji": "🛠️",
  "badge": "New",
  "short": "Depuis l'app mobile Léa, tu peux lui dicter des corrections, des créations de produits, des fiches marge… Elle agit directement dans Alteore.",
  "long_html": "<p><strong>11 actions que Léa peut maintenant faire</strong> (depuis l'app mobile uniquement) :</p><ul><li><strong>Pilotage</strong> : ajouter/corriger/supprimer une ligne CA, modifier ou supprimer une charge.</li><li><strong>Stock</strong> : créer un nouveau produit, ajuster une quantité, marquer une rupture.</li><li><strong>Marges</strong> : créer une fiche marge avec calcul auto, modifier les prix/coûts.</li></ul><p><strong>Exemples de demandes possibles :</strong></p><ul><li>« Corrige le CA du 15 avril à 800€ en TVA 10 »</li><li>« Crée un produit pain de campagne à 2,50€ avec 50 en stock »</li><li>« Crée une fiche marge burger à 12€, matière 3€, main d'œuvre 1€ »</li></ul><p>Avant toute suppression, Léa te demande confirmation.</p>"
}

# FORMAT DE SORTIE
Réponds UNIQUEMENT avec un objet JSON valide, sans markdown, sans préambule.
Structure exacte :
{
  "title": "...",        // 5-12 mots, accroche claire, pas de point final
  "emoji": "🎉",          // 1 seul emoji, pertinent par rapport au contenu
  "badge": "New" | "Fix" | "Amélioration",
  "short": "...",        // 150-250 caractères, phrase complète, info principale + pourquoi c'est utile
  "long_html": "..."     // HTML avec <p>, <ul>, <li>, <strong>, <em>. 3-6 bullets dans les <ul> si liste.
}

# CHOIX DU BADGE
- "New" → nouvelle fonctionnalité qui n'existait pas avant
- "Amélioration" → fonctionnalité existante améliorée, étendue, simplifiée
- "Fix" → correction de bug

# RÈGLES DURES
- JAMAIS inventer des chiffres ou des exemples qui ne sont pas dans la description
- Si la description est vague, reste vague mais clair (pas de détails inventés)
- Longueur long_html : 150-500 mots, adapte selon la richesse de la description
- HTML autorisé uniquement : <p> <ul> <li> <strong> <em> <br>
- Jamais de <div>, <h1>, <h2>, <img>, <a>
- Pas de \`\`\`json ... \`\`\` dans ta réponse, juste l'objet JSON pur`;

// ══════════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  if (['https://alteore.com', 'https://www.alteore.com', 'http://localhost:3000'].includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ── 1. Auth ──
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!idToken) return res.status(401).json({ error: 'Non authentifié' });

    const fbKey = process.env.FIREBASE_API_KEY || FB_KEY;
    const verifyRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${fbKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
    );
    if (!verifyRes.ok) return res.status(401).json({ error: 'Token invalide' });
    const verifyData = await verifyRes.json();
    const u = verifyData.users?.[0];
    if (!u?.email) return res.status(401).json({ error: 'Utilisateur introuvable' });

    // Admin only
    if ((u.email || '').toLowerCase() !== ADMIN_EMAIL) {
      return res.status(403).json({ error: 'Accès réservé à l\'admin' });
    }

    // ── 2. Input validation ──
    const { description, version, suggested_badge } = req.body || {};
    if (!description || typeof description !== 'string') {
      return res.status(400).json({ error: 'description est requis (string)' });
    }
    const desc = description.trim();
    if (desc.length < 10) return res.status(400).json({ error: 'Description trop courte (min 10 caractères)' });
    if (desc.length > 2000) return res.status(400).json({ error: 'Description trop longue (max 2000 caractères)' });

    // ── 3. Build user message ──
    let userMessage = `Description de ce qui a été fait :\n"${desc}"`;
    if (version && typeof version === 'string' && version.trim()) {
      userMessage += `\n\nVersion/libellé suggéré : ${version.trim()}`;
    }
    if (suggested_badge && ['New', 'Fix', 'Amélioration'].includes(suggested_badge)) {
      userMessage += `\n\nBadge suggéré : ${suggested_badge} (peut être changé si plus pertinent)`;
    }
    userMessage += '\n\nGénère le JSON selon le format et le style demandés.';

    // ── 4. Appel Claude Haiku ──
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY manquante' });

    const cRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: CLAUDE_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    const cData = await cRes.json();
    if (!cRes.ok) {
      console.error('[generate-update] Claude error:', cData);
      return res.status(500).json({ error: 'Claude API: ' + (cData.error?.message || 'unknown') });
    }
    if (cData.stop_reason === 'max_tokens') {
      return res.status(500).json({ error: 'Réponse Claude tronquée (max_tokens atteint)' });
    }

    const text = (cData.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();

    // ── 5. Extraction JSON (au cas où Claude encadre malgré les instructions) ──
    let jsonStr = text;
    const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) jsonStr = codeBlock[1].trim();

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.error('[generate-update] JSON parse failed:', text.slice(0, 300));
      return res.status(500).json({ error: 'JSON invalide de Claude: ' + e.message });
    }

    // ── 6. Validation de la sortie ──
    if (!parsed.title || !parsed.short) {
      return res.status(500).json({ error: 'Sortie Claude incomplète', got: parsed });
    }
    if (!parsed.emoji) parsed.emoji = '🎉';
    if (!parsed.badge || !['New', 'Fix', 'Amélioration'].includes(parsed.badge)) {
      parsed.badge = suggested_badge && ['New', 'Fix', 'Amélioration'].includes(suggested_badge) ? suggested_badge : 'New';
    }
    if (!parsed.long_html) parsed.long_html = '';

    console.log(`[generate-update] ✅ Généré : "${parsed.title}" (${parsed.badge})`);

    return res.status(200).json({
      ok: true,
      title: parsed.title,
      emoji: parsed.emoji,
      badge: parsed.badge,
      short: parsed.short,
      long_html: parsed.long_html,
      usage: cData.usage,
    });

  } catch (e) {
    console.error('[generate-update] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
