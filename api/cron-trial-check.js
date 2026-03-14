// api/cron-trial-check.js
// ══════════════════════════════════════════════════════════════════
// CRON quotidien — Gestion du cycle de vie des essais gratuits
//
// Appelé chaque jour à 8h UTC (9-10h heure française) par Vercel Cron
//
// Actions :
//   J-3  → email rappel « Plus que 3 jours »
//   J-1  → email rappel « Dernier jour demain »
//   J+0  → plan = trial_expired + email « Essai expiré »
//   J+15 → suppression des données + email « Données supprimées »
//
// Sécurité : vérifie le CRON_SECRET (Vercel envoie Authorization: Bearer <secret>)
// ══════════════════════════════════════════════════════════════════

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// ── Firebase Admin (singleton) ──
function getDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: 'altiora-70599',
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
  return getFirestore();
}

// ── Envoi d'email via Resend REST API ──
async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.warn('[cron-trial] RESEND_API_KEY manquante — email non envoyé'); return false; }

  const from = process.env.RESEND_FROM || 'ALTEORE <noreply@alteore.com>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from, to: [to], subject, html })
    });
    const data = await res.json();
    if (res.ok) {
      console.log(`[cron-trial] ✅ Email envoyé à ${to}: ${subject}`);
      return true;
    } else {
      console.error(`[cron-trial] ❌ Resend error:`, data);
      return false;
    }
  } catch (e) {
    console.error(`[cron-trial] ❌ Email exception:`, e.message);
    return false;
  }
}

// ── Calcul des jours entre maintenant et une date ──
function daysDiff(dateStr) {
  const end = new Date(dateStr);
  if (isNaN(end.getTime())) return null;
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  end.setHours(12, 0, 0, 0);
  return Math.round((end - now) / (1000 * 60 * 60 * 24));
}

// ── Suppression récursive des données utilisateur ──
async function deleteUserData(db, uid) {
  // Toutes les collections avec sous-collections liées à un uid
  const COLLECTIONS_WITH_SUBCOLS = [
    'pilotage', 'marges', 'produits', 'panier', 'dettes',
    'bilans', 'copilote', 'cashflow', 'stock', 'fidelite',
    'fidelite_tablet', 'sms_credits', 'rh',
    'rh_conges', 'rh_conges_public', 'rh_onboarding', 'rh_recrutement',
    'rh_docs_gen', 'rh_emargements', 'rh_emargements_public',
    'rh_planning_public', 'rh_pointages_public',
    'fiches', 'profil', 'tickets'
  ];

  // Documents simples (sans sous-collections)
  const SIMPLE_DOCS = [
    'catalogues', 'bank_connections', 'bank_pending',
    'fidelite_public_cfg', 'rh_params'
  ];

  let deleted = 0;

  // 1. Supprimer collections avec sous-collections (recursiveDelete)
  for (const col of COLLECTIONS_WITH_SUBCOLS) {
    try {
      const ref = db.collection(col).doc(uid);
      const snap = await ref.get();
      if (snap.exists) {
        await db.recursiveDelete(ref);
        deleted++;
        console.log(`[cron-trial]   🗑 ${col}/${uid} supprimé (récursif)`);
      }
    } catch (e) {
      console.warn(`[cron-trial]   ⚠️ Erreur suppression ${col}/${uid}:`, e.message);
    }
  }

  // 2. Supprimer documents simples
  for (const col of SIMPLE_DOCS) {
    try {
      const ref = db.collection(col).doc(uid);
      const snap = await ref.get();
      if (snap.exists) {
        await ref.delete();
        deleted++;
        console.log(`[cron-trial]   🗑 ${col}/${uid} supprimé`);
      }
    } catch (e) {
      console.warn(`[cron-trial]   ⚠️ Erreur suppression ${col}/${uid}:`, e.message);
    }
  }

  // 3. Supprimer les docs fidelite_public où merchantUid == uid
  try {
    const fidPubSnap = await db.collection('fidelite_public')
      .where('merchantUid', '==', uid).get();
    for (const doc of fidPubSnap.docs) {
      await doc.ref.delete();
      deleted++;
    }
    if (fidPubSnap.size > 0) {
      console.log(`[cron-trial]   🗑 ${fidPubSnap.size} fidelite_public supprimés`);
    }
  } catch (e) {
    console.warn('[cron-trial]   ⚠️ Erreur suppression fidelite_public:', e.message);
  }

  // 4. Supprimer les docs rh_employes_public (besoin d'une query par ownerUid ou parcours)
  try {
    const rhPubSnap = await db.collection('rh_employes_public')
      .where('ownerUid', '==', uid).get();
    for (const doc of rhPubSnap.docs) {
      await doc.ref.delete();
      deleted++;
    }
    const rhProfilSnap = await db.collection('rh_employes_public_profil')
      .where('ownerUid', '==', uid).get();
    for (const doc of rhProfilSnap.docs) {
      await doc.ref.delete();
      deleted++;
    }
  } catch (e) {
    console.warn('[cron-trial]   ⚠️ Erreur suppression rh_employes_public:', e.message);
  }

  return deleted;
}

// ══════════════════════════════════════════════════════════════════
// TEMPLATES EMAIL
// ══════════════════════════════════════════════════════════════════

function emailWrapper(content) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f5f7ff;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:20px">
  <div style="text-align:center;padding:24px 0">
    <span style="font-size:22px;font-weight:800;color:#0f1f5c;letter-spacing:1px">ALTEORE</span>
  </div>
  <div style="background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(15,31,92,0.08)">
    ${content}
  </div>
  <div style="text-align:center;padding:20px 0;font-size:11px;color:#94a3b8;line-height:1.5">
    ALTEORE — Logiciel de gestion pour commerçants<br/>
    <a href="https://alteore.com" style="color:#94a3b8">alteore.com</a>
  </div>
</div></body></html>`;
}

function emailReminderJ3(name) {
  return emailWrapper(`
    <div style="background:linear-gradient(135deg,#f59e0b,#fbbf24);padding:28px 32px;color:#1a1f36">
      <div style="font-size:28px;margin-bottom:8px">⏳</div>
      <h1 style="margin:0;font-size:20px;font-weight:800">Plus que 3 jours d'essai</h1>
      <p style="margin:8px 0 0;font-size:14px;opacity:0.85">Votre période d'essai gratuite arrive bientôt à son terme.</p>
    </div>
    <div style="padding:28px 32px">
      <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">
        Bonjour${name ? ' ' + name : ''},
      </p>
      <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">
        Votre essai gratuit d'Alteore expire dans <strong>3 jours</strong>. Pour continuer à utiliser votre tableau de bord, vos analyses de marge, votre pilotage financier et toutes vos données, souscrivez à un abonnement dès maintenant.
      </p>
      <p style="font-size:13px;color:#6b7280;line-height:1.7;margin:0 0 24px">
        💡 Toutes vos données seront conservées si vous souscrivez avant l'expiration. Sans abonnement, votre accès sera bloqué et vos données seront supprimées 15 jours plus tard.
      </p>
      <div style="text-align:center">
        <a href="https://alteore.com/pricing.html" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#1a3dce,#4f7ef8);color:white;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;box-shadow:0 4px 14px rgba(26,61,206,0.3)">Choisir mon plan →</a>
      </div>
      <p style="font-size:12px;color:#94a3b8;text-align:center;margin:20px 0 0">Annulation à tout moment · Sans engagement</p>
    </div>`);
}

function emailReminderJ1(name) {
  return emailWrapper(`
    <div style="background:linear-gradient(135deg,#ef4444,#f87171);padding:28px 32px;color:white">
      <div style="font-size:28px;margin-bottom:8px">🔔</div>
      <h1 style="margin:0;font-size:20px;font-weight:800">Dernier jour d'essai demain !</h1>
      <p style="margin:8px 0 0;font-size:14px;opacity:0.85">Ne perdez pas vos données et votre historique.</p>
    </div>
    <div style="padding:28px 32px">
      <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">
        Bonjour${name ? ' ' + name : ''},
      </p>
      <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">
        Votre essai gratuit expire <strong>demain</strong>. Après cette date, vous ne pourrez plus accéder à Alteore.
      </p>
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px;margin:0 0 20px">
        <p style="margin:0;font-size:13px;color:#991b1b;line-height:1.6">
          ⚠️ <strong>Sans abonnement, vos données seront définitivement supprimées 15 jours après l'expiration.</strong> Saisissez l'opportunité de conserver tout votre travail en souscrivant dès maintenant.
        </p>
      </div>
      <div style="text-align:center">
        <a href="https://alteore.com/pricing.html" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#1a3dce,#4f7ef8);color:white;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;box-shadow:0 4px 14px rgba(26,61,206,0.3)">Souscrire maintenant →</a>
      </div>
      <p style="font-size:12px;color:#94a3b8;text-align:center;margin:20px 0 0">À partir de 55€/mois · Annulation à tout moment</p>
    </div>`);
}

function emailExpired(name) {
  return emailWrapper(`
    <div style="background:linear-gradient(135deg,#1a1f36,#2d3561);padding:28px 32px;color:white">
      <div style="font-size:28px;margin-bottom:8px">🚫</div>
      <h1 style="margin:0;font-size:20px;font-weight:800">Votre essai gratuit a expiré</h1>
      <p style="margin:8px 0 0;font-size:14px;opacity:0.7">Votre accès à Alteore est désormais bloqué.</p>
    </div>
    <div style="padding:28px 32px">
      <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">
        Bonjour${name ? ' ' + name : ''},
      </p>
      <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">
        Votre période d'essai de 15 jours est terminée. L'accès au logiciel est maintenant bloqué.
      </p>
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px;margin:0 0 16px">
        <p style="margin:0;font-size:13px;color:#991b1b;line-height:1.6;font-weight:600">
          ⏰ Vous avez 15 jours pour récupérer vos données en souscrivant à un abonnement. Passé ce délai, toutes vos données seront définitivement supprimées.
        </p>
      </div>
      <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 24px">
        Souscrivez maintenant pour retrouver immédiatement l'accès à votre tableau de bord et à toutes vos données intactes.
      </p>
      <div style="text-align:center">
        <a href="https://alteore.com/pricing.html" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#1a3dce,#4f7ef8);color:white;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;box-shadow:0 4px 14px rgba(26,61,206,0.3)">Réactiver mon compte →</a>
      </div>
    </div>`);
}

function emailDeleted(name) {
  return emailWrapper(`
    <div style="background:linear-gradient(135deg,#6b7280,#9ca3af);padding:28px 32px;color:white">
      <div style="font-size:28px;margin-bottom:8px">🗑</div>
      <h1 style="margin:0;font-size:20px;font-weight:800">Vos données ont été supprimées</h1>
      <p style="margin:8px 0 0;font-size:14px;opacity:0.7">Conformément à notre politique, vos données ont été effacées.</p>
    </div>
    <div style="padding:28px 32px">
      <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">
        Bonjour${name ? ' ' + name : ''},
      </p>
      <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px">
        Votre période d'essai a expiré il y a plus de 15 jours. Conformément à nos conditions, toutes vos données ont été définitivement supprimées de nos serveurs.
      </p>
      <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 24px">
        Si vous souhaitez utiliser Alteore à l'avenir, vous pouvez créer un nouveau compte et souscrire à un abonnement.
      </p>
      <div style="text-align:center">
        <a href="https://alteore.com" style="display:inline-block;padding:14px 32px;background:#e2e8f0;color:#374151;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px">Visiter Alteore</a>
      </div>
    </div>`);
}

// ══════════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ══════════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  // ── Sécurité : vérifier CRON_SECRET (Vercel Cron envoie Authorization: Bearer <secret>) ──
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Non autorisé' });
    }
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const db = getDb();
  const stats = { checked: 0, reminderJ3: 0, reminderJ1: 0, expired: 0, deleted: 0, errors: 0 };

  try {
    // ── 1. Récupérer tous les users en trial ou trial_expired ──
    const trialSnap = await db.collection('users')
      .where('plan', 'in', ['trial', 'trial_expired'])
      .get();

    console.log(`[cron-trial] 🔍 ${trialSnap.size} utilisateur(s) en trial/trial_expired`);

    for (const userDoc of trialSnap.docs) {
      stats.checked++;
      const uid = userDoc.id;
      const data = userDoc.data();
      const email = data.email;
      const name = data.name || data.displayName || '';
      const trialEnd = data.trialEnd;
      const plan = data.plan;

      if (!trialEnd) {
        console.warn(`[cron-trial] ⚠️ ${uid} — pas de trialEnd, skip`);
        continue;
      }

      const daysLeft = daysDiff(trialEnd);
      if (daysLeft === null) {
        console.warn(`[cron-trial] ⚠️ ${uid} — trialEnd invalide: ${trialEnd}`);
        continue;
      }

      console.log(`[cron-trial] 👤 ${uid} (${email || '?'}) — J${daysLeft >= 0 ? '-' + daysLeft : '+' + Math.abs(daysLeft)} — plan=${plan}`);

      try {
        // ── J-3 : rappel 3 jours ──
        if (daysLeft === 3 && plan === 'trial' && !data.trialEmailJ3) {
          if (email) await sendEmail(email, '⏳ Plus que 3 jours d\'essai gratuit — Alteore', emailReminderJ3(name));
          await userDoc.ref.update({ trialEmailJ3: true });
          stats.reminderJ3++;
        }

        // ── J-1 : rappel dernier jour ──
        else if (daysLeft === 1 && plan === 'trial' && !data.trialEmailJ1) {
          if (email) await sendEmail(email, '🔔 Dernier jour d\'essai demain ! — Alteore', emailReminderJ1(name));
          await userDoc.ref.update({ trialEmailJ1: true });
          stats.reminderJ1++;
        }

        // ── J+0 ou déjà expiré : bloquer ──
        else if (daysLeft <= 0 && plan === 'trial') {
          if (email && !data.trialEmailExpired) {
            await sendEmail(email, '🚫 Votre essai gratuit a expiré — Alteore', emailExpired(name));
          }
          await userDoc.ref.update({
            plan: 'trial_expired',
            trialEmailExpired: true,
            trialExpiredAt: new Date().toISOString(),
          });
          stats.expired++;
          console.log(`[cron-trial] 🔒 ${uid} → trial_expired`);
        }

        // ── J+15 après expiration : supprimer les données ──
        else if (plan === 'trial_expired') {
          const expiredAt = data.trialExpiredAt || data.trialEnd;
          const daysSinceExpiry = expiredAt ? -daysDiff(expiredAt) : 999;

          if (daysSinceExpiry >= 15 && !data.trialDataDeleted) {
            console.log(`[cron-trial] 🗑 ${uid} — suppression des données (J+${daysSinceExpiry} après expiration)`);

            const deletedCount = await deleteUserData(db, uid);

            // Envoyer email de suppression
            if (email) await sendEmail(email, '🗑 Vos données Alteore ont été supprimées', emailDeleted(name));

            // Mettre à jour le document user (on le garde pour trace)
            await userDoc.ref.update({
              plan: 'deleted',
              trialDataDeleted: true,
              trialDataDeletedAt: new Date().toISOString(),
              dataDeletedCount: deletedCount,
            });
            stats.deleted++;
            console.log(`[cron-trial] ✅ ${uid} — ${deletedCount} collections supprimées`);
          }
        }

      } catch (userErr) {
        stats.errors++;
        console.error(`[cron-trial] ❌ Erreur pour ${uid}:`, userErr.message);
      }
    }

    console.log(`[cron-trial] ✅ Terminé:`, stats);
    return res.status(200).json({ ok: true, stats });

  } catch (e) {
    console.error('[cron-trial] ❌ Erreur globale:', e);
    return res.status(500).json({ error: e.message, stats });
  }
};
