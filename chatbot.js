// ╔══════════════════════════════════════════════════════════╗
// ║  ALTEORE — Chatbot Assistant v2 (auto-injectable)      ║
// ║  Base de connaissances COMPLÈTE de tout le logiciel     ║
// ╚══════════════════════════════════════════════════════════╝
(function(){
'use strict';
if(document.getElementById('alteore-chatbot'))return;
var noChat=['index.html','pricing.html','inscription.html','login.html','forgot.html','client-fidelite.html','espace-salarie.html','portail-salarie.html','unsubscribe.html','mentions-legales.html','cgv.html','confidentialite.html'];
var currentPage=window.location.pathname.split('/').pop()||'index.html';
if(noChat.includes(currentPage))return;

// ═══════ CSS ═══════
var css=document.createElement('style');
css.id='alteore-chatbot-css';
css.textContent=`
#alteore-chatbot{--cb:#1a3dce;font-family:'Plus Jakarta Sans',-apple-system,sans-serif;position:fixed;bottom:0;right:0;z-index:9990}
#chat-fab{position:fixed;bottom:24px;right:24px;z-index:9991;width:60px;height:60px;border-radius:50%;border:none;background:linear-gradient(135deg,#0f1f5c,#1a3dce,#4f7ef8);color:#fff;font-size:26px;cursor:pointer;box-shadow:0 6px 24px rgba(15,31,92,.35);display:flex;align-items:center;justify-content:center;transition:.3s}
#chat-fab:hover{transform:scale(1.08)}#chat-fab:active{transform:scale(.95)}
#chat-fab.open{background:#374151}
#chat-fab.open .cb-io{display:none}#chat-fab.open .cb-ic{display:block}.cb-ic{display:none;font-size:20px}
.cb-notif{position:absolute;top:-2px;right:-2px;background:#ef4444;color:#fff;font-size:11px;font-weight:800;width:20px;height:20px;border-radius:50%;display:none;align-items:center;justify-content:center;border:2px solid #fff;animation:cbPop .3s}
@keyframes cbPop{0%{transform:scale(0)}70%{transform:scale(1.2)}100%{transform:scale(1)}}
.cb-win{position:fixed;bottom:96px;right:24px;width:400px;max-height:calc(100vh - 140px);background:#fff;border-radius:16px;border:1px solid #e2e8f0;box-shadow:0 12px 48px rgba(15,31,92,.18);display:none;flex-direction:column;overflow:hidden;z-index:9992}
.cb-win.open{display:flex;animation:cbUp .3s ease}
@keyframes cbUp{from{opacity:0;transform:translateY(16px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}
.cb-hd{padding:16px 18px;background:linear-gradient(135deg,#0f1f5c,#1a3dce);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.cb-hd-l{display:flex;align-items:center;gap:12px}
.cb-av{width:40px;height:40px;background:rgba(255,255,255,.15);border:1.5px solid rgba(255,255,255,.25);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff;position:relative}
.cb-st{position:absolute;bottom:-2px;right:-2px;width:10px;height:10px;background:#10b981;border-radius:50%;border:2px solid #0f1f5c}
.cb-ht{font-size:14px;font-weight:700;color:#fff}.cb-hs{font-size:11px;color:rgba(255,255,255,.55)}
.cb-ha{display:flex;gap:4px}
.cb-hb{background:rgba(255,255,255,.1);border:none;color:rgba(255,255,255,.7);width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;transition:.15s}
.cb-hb:hover{background:rgba(255,255,255,.2);color:#fff}
.cb-msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;min-height:300px;max-height:420px;background:#f5f7ff;scroll-behavior:smooth}
.cb-msgs::-webkit-scrollbar{width:5px}.cb-msgs::-webkit-scrollbar-thumb{background:#d1d5db;border-radius:99px}
.cb-m{max-width:85%;display:flex;flex-direction:column;gap:4px;animation:cbIn .25s}
@keyframes cbIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.cb-m.bot{align-self:flex-start}.cb-m.user{align-self:flex-end}
.cb-b{padding:12px 16px;border-radius:14px;font-size:13px;line-height:1.6;word-wrap:break-word}
.cb-m.bot .cb-b{background:#fff;color:#1a1f36;border:1px solid #e2e8f0;border-bottom-left-radius:4px}
.cb-m.user .cb-b{background:linear-gradient(135deg,#1a3dce,#4f7ef8);color:#fff;border-bottom-right-radius:4px}
.cb-t{font-size:10px;color:#6b7280;padding:0 4px}.cb-m.user .cb-t{text-align:right}
.cb-typ{display:flex;align-items:center;gap:8px;padding:12px 16px;background:#fff;border:1px solid #e2e8f0;border-radius:14px;border-bottom-left-radius:4px;align-self:flex-start;max-width:100px}
.cb-dots{display:flex;gap:4px}
.cb-dot{width:7px;height:7px;background:#94a3b8;border-radius:50%;animation:cbBnc 1.4s infinite ease-in-out}
.cb-dot:nth-child(2){animation-delay:.16s}.cb-dot:nth-child(3){animation-delay:.32s}
@keyframes cbBnc{0%,80%,100%{transform:scale(.6);opacity:.4}40%{transform:scale(1);opacity:1}}
.cb-sugs{padding:8px 16px 4px;display:flex;flex-wrap:wrap;gap:6px;background:#fff;border-top:1px solid #f1f5f9;flex-shrink:0}
.cb-sg{padding:6px 12px;background:#f0f4ff;border:1.5px solid #dbeafe;border-radius:20px;font-family:inherit;font-size:11px;font-weight:600;color:#1a3dce;cursor:pointer;transition:.15s;white-space:nowrap}
.cb-sg:hover{background:#dbeafe;border-color:#4f7ef8;transform:translateY(-1px)}
.cb-ia{padding:12px 16px 10px;background:#fff;border-top:1px solid #e2e8f0;flex-shrink:0}
.cb-iw{display:flex;align-items:flex-end;gap:8px;background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;padding:6px 6px 6px 14px;transition:.15s}
.cb-iw:focus-within{border-color:#1a3dce;box-shadow:0 0 0 3px rgba(26,61,206,.1);background:#fff}
.cb-inp{flex:1;border:none;background:transparent;font-family:inherit;font-size:13px;color:#1a1f36;resize:none;outline:none;max-height:100px;line-height:1.5;padding:6px 0}
.cb-inp::placeholder{color:#94a3b8}
.cb-snd{width:36px;height:36px;border-radius:10px;border:none;background:linear-gradient(135deg,#1a3dce,#4f7ef8);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:.15s;opacity:.5}
.cb-snd:not(:disabled){opacity:1}.cb-snd:not(:disabled):hover{transform:scale(1.05)}
.cb-ft{text-align:center;font-size:10px;color:#94a3b8;margin-top:6px}.cb-ft a{color:#1a3dce;text-decoration:none}
.cb-b a{color:#1a3dce;text-decoration:underline}.cb-m.user .cb-b a{color:#bfdbfe}
.cb-b ul,.cb-b ol{margin:6px 0;padding-left:18px}.cb-b li{margin-bottom:3px}.cb-b strong{font-weight:700}
.cb-tk label{display:block;font-size:11px;font-weight:600;color:#6b7280;margin-bottom:4px;margin-top:8px}
.cb-tk input,.cb-tk textarea,.cb-tk select{width:100%;padding:8px 10px;border:1.5px solid #e2e8f0;border-radius:8px;font-family:inherit;font-size:12px;color:#1a1f36;outline:none;box-sizing:border-box}
.cb-tk input:focus,.cb-tk textarea:focus,.cb-tk select:focus{border-color:#1a3dce}
.cb-tkb{margin-top:10px;width:100%;padding:9px;border:none;background:linear-gradient(135deg,#1a3dce,#4f7ef8);color:#fff;border-radius:8px;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer}
@media(max-width:768px){
#chat-fab{bottom:16px;right:16px;width:54px;height:54px;font-size:22px}
.cb-win{bottom:0;right:0;left:0;width:100%!important;max-width:100%!important;max-height:100vh;height:100vh;border-radius:0}
.cb-win.open{animation:cbUpM .3s}@keyframes cbUpM{from{transform:translateY(100%)}to{transform:translateY(0)}}
.cb-msgs{max-height:none;min-height:0;flex:1}.cb-inp{font-size:16px!important}
}`;
document.head.appendChild(css);

// ═══════ HTML ═══════
var ctn=document.createElement('div');ctn.id='alteore-chatbot';
ctn.innerHTML=`
<button id="chat-fab" aria-label="Assistant ALTEORE"><span class="cb-io">💬</span><span class="cb-ic">✕</span><span class="cb-notif" id="cb-notif">1</span></button>
<div class="cb-win" id="cb-win">
<div class="cb-hd"><div class="cb-hd-l"><div class="cb-av"><span>A</span><span class="cb-st"></span></div><div><div class="cb-ht">Assistant ALTEORE</div><div class="cb-hs">En ligne · Répond en quelques secondes</div></div></div><div class="cb-ha"><button class="cb-hb" id="cb-clr" title="Nouvelle conversation">🗑</button><button class="cb-hb" id="cb-cls" title="Fermer">✕</button></div></div>
<div class="cb-msgs" id="cb-msgs"></div>
<div class="cb-sugs" id="cb-sugs">
<button class="cb-sg" data-q="Comment fonctionne la marge brute ?">📊 Marge brute</button>
<button class="cb-sg" data-q="Comment saisir mon CA quotidien ?">💰 Saisie du CA</button>
<button class="cb-sg" data-q="Comment fonctionne la fidélisation client ?">🎁 Fidélité</button>
<button class="cb-sg" data-q="Comment configurer la pointeuse ?">⏱ Pointeuse</button>
<button class="cb-sg" data-q="Comment fonctionne le module RH ?">👥 RH</button>
<button class="cb-sg" data-q="Quels sont les abonnements disponibles ?">💳 Tarifs</button>
</div>
<div class="cb-ia"><div class="cb-iw"><textarea id="cb-inp" class="cb-inp" placeholder="Posez votre question..." rows="1"></textarea><button id="cb-snd" class="cb-snd" disabled><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button></div><div class="cb-ft">Propulsé par <strong>ALTEORE</strong></div></div>
</div>`;
document.body.appendChild(ctn);

// ═══════════════════════════════════════════════════════════
//  SYSTEM PROMPT — BASE DE CONNAISSANCES EXHAUSTIVE
// ═══════════════════════════════════════════════════════════
var SYSTEM_PROMPT=`Tu es l'assistant virtuel officiel d'ALTEORE, un logiciel SaaS de gestion tout-en-un pour commerçants, artisans et TPE/PME en France.
Tu t'appelles "Assistant ALTEORE". Tu es professionnel, chaleureux et pédagogue. Tu réponds TOUJOURS en français, de façon concise (2-4 paragraphes max).

═══ PRÉSENTATION ═══
ALTEORE (https://alteore.com) est opéré par SARL Ambitio Corp. Application web accessible depuis n'importe quel navigateur (PC, tablette, mobile). Données hébergées sur Firebase (Google Cloud). Paiements sécurisés par Stripe. Aucune installation nécessaire.

═══ TOUS LES MODULES EN DÉTAIL ═══

1. TABLEAU DE BORD (dashboard.html) — Pro+
Vue synthétique : CA HT du mois, total charges, résultat net, trésorerie. Graphiques : évolution CA mensuel, répartition charges. Widget météo locale (via géolocalisation). Actualités business (Le Monde). Comparaison avec mois précédent (flèches vertes/rouges). Mode d'affichage : année civile ou année fiscale configurable (ex: mai à avril). Rien à saisir ici, tout vient automatiquement du Pilotage.

2. SUIVI CA & RÉSULTATS (suivi-ca.html) — Pro+
Consolidation des données saisies dans le Pilotage. Calendrier interactif avec CA par jour. Graphiques de progression journalière/mensuelle/annuelle. Comparaison mois par mois, année par année. Analyse par taux de TVA (5,5%, 10%, 20%). Vue civile ou fiscale paramétrable. Les données proviennent du module Pilotage — il faut saisir le CA dans Pilotage d'abord.

3. PILOTAGE FINANCIER (pilotage.html) — Pro+ ★ MODULE CENTRAL
C'est LE module de saisie principal. Sélectionner l'année puis naviguer par mois. Chaque mois contient 5 sections :
a) CA quotidien : saisie jour par jour, 3 colonnes par taux TVA (HT 5,5%, HT 10%, HT 20%). Les totaux HT et TVA collectée se calculent auto.
b) Charges fixes : loyer, assurance, expert-comptable, abonnements, téléphone, etc. Montant HT + taux TVA. Bouton "Appliquer les charges fixes" = recopier les mêmes charges sur les mois suivants.
c) Charges variables : achats marchandises, matières premières, fournitures, frais de port, etc. Montant HT + taux TVA.
d) Crédits/emprunts : mensualité, part capital, part intérêts. Synchronisation auto avec module Dettes.
e) Leasings : loyers de location financière (véhicule, matériel).
Calculs automatiques : total charges du mois, TVA collectée, TVA déductible, TVA à reverser, résultat net.
ASTUCE : commencer par les charges fixes (récurrentes), puis saisir le CA jour par jour.

4. CASHFLOW / TRÉSORERIE (cashflow.html) — Pro+
Trésorerie mois par mois : CA encaissé − Charges − TVA à reverser − Crédits − Leasings. Graphique d'évolution sur l'année. Mode prévisionnel pour anticiper. Trésorerie initiale paramétrable. Alertes si trésorerie négative. Tout vient automatiquement du Pilotage.

5. COÛT DE REVIENT (cout-revient.html) — Pro+
Fiches produit/service détaillées avec :
- Ingrédients/matières premières : nom, quantité, prix unitaire → coût par unité
- Main d'œuvre directe : heures × taux horaire
- Emballages : type, quantité, prix unitaire
- Livraison : frais par unité
- Charges fixes : avec % de répartition configurable
Calcul auto du coût de revient unitaire. Suggestion de prix de vente selon marge cible. Import depuis Google Sheets avec mappage IA des colonnes. Quantité produite paramétrable. Les produits créés ici sont automatiquement disponibles dans le module Marges.

6. MARGE BRUTE & NETTE (marges.html) — Pro+
Liste de produits à gauche (importés du Coût de revient + saisie directe). Cliquer sur un produit pour l'analyser.
KPIs : Prix de vente HT, Marge brute, Marge nette, Coûts variables, Charges fixes imputées.
Décomposition de la Marge Brute :
  Marge brute = PV HT − (Matières premières + Main d'œuvre + Emballages + Livraison)
  Taux = Marge brute / PV × 100
  Codes : VERT ≥ 30% | ORANGE 10-30% | ROUGE < 10%
Décomposition de la Marge Nette :
  Marge nette = Marge brute − Charges fixes imputées
  Taux = Marge nette / PV × 100
  Codes : VERT ≥ 20% | ORANGE 5-20% | ROUGE < 5%
Clé de répartition (4 méthodes pour imputer les charges fixes) :
  • Temps : heures ce produit / heures totales production
  • Superficie : m² utilisés / m² total atelier
  • Volume : unités ce produit / unités totales
  • CA : CA ce produit / CA total
Barre visuelle de décomposition du prix de vente. Camembert de répartition.
Simulateur de scénarios : modifier PV (€ ou %), réduire MP/MO/CF (€ ou %), changer volume. Tableau comparatif situation actuelle vs simulation avec écarts.
Sélection multiple + suppression groupée de produits.

7. PANIER MOYEN (panier-moyen.html) — Pro+
Saisie du nombre de tickets/transactions par jour. Calcul auto : Panier moyen = CA du jour / nb tickets. Vues par jour, semaine, mois. Analyse par catégorie de produits. Graphiques de tendance. Saisonnalité et jours les plus performants. Données par année avec navigation.

8. DETTES & EMPRUNTS (dettes.html) — Pro+
Ajout de dettes : créancier, montant initial, taux d'intérêt, durée en mois, mensualité, date début. Échéancier auto avec décomposition capital/intérêts. Coche des mensualités payées. Validation groupée. KPIs : total emprunté, total remboursé, capital restant dû, % progression. Alertes échéances proches. Synchronisation avec le Pilotage (section crédits).

9. GESTION DES STOCKS (gestion-stock.html) — Max+
3 onglets : Stock produits, Mouvements, Valorisation.
Stock produits : référence, nom, catégorie, stock actuel, stock minimum, prix d'achat. Alertes stock bas. Deux types : Produit fini (avec PV et marge) ou Matière première (inventaire pur, marge calculée dans Coût de revient).
Mouvements : entrées (réception fournisseur, ajustement+) et sorties (vente, perte, ajustement−). Stock calculé = initial + entrées − sorties.
Valorisation : valeur totale du stock au prix d'achat. Marge potentielle par produit. Classement par valeur de stock.
Import depuis le catalogue Coût de revient.

9b. SYNCHRONISATION BANCAIRE (banque.html + bank-validation.html) — Pro+
Connexion sécurisée à votre compte bancaire professionnel via GoCardless/Nordigen. Récupération automatique des transactions.
Page de validation (bank-validation.html) :
- Onglet "En attente" : transactions bancaires récupérées mais pas encore importées dans le Pilotage. Vous devez les catégoriser (charge fixe, charge variable, CA, etc.) puis les importer.
- Onglet "Doublons" : transactions détectées comme potentiellement déjà saisies dans le Pilotage. Vous pouvez : Ignorer la transaction bancaire (garder le pilotage), Garder les deux, ou Remplacer l'entrée pilotage par la donnée bancaire.
- Onglet "Importées" : transactions déjà validées et envoyées dans le Pilotage.
- Onglet "Ignorées" : transactions marquées comme non pertinentes.
- Onglet "Encaissements" : les entrées (crédits sur le compte) — peuvent être envoyées en CA dans le Pilotage.
Les transactions importées alimentent directement les sections Charges fixes, Charges variables ou CA du module Pilotage.
Pour connecter un compte bancaire : Synchronisation bancaire > Connecter un compte > suivre les étapes GoCardless.
ASTUCE : vérifier régulièrement les transactions "En attente" pour garder le Pilotage à jour automatiquement.

10. FIDÉLISATION CLIENT (fidelisation.html) — Max+
7 onglets :
a) Dashboard : KPIs (nb clients, points distribués, récompenses échangées, taux rétention)
b) Clients : liste complète, ajout, recherche, segmentation (VIP, fidèle, occasionnel, inactif, nouveau), historique points/achats
c) Carte fidélité : personnalisation (logo, couleurs, nom commerce). QR code unique par client. Page publique accessible sans compte (client-fidelite.html)
d) Points & Récompenses : barème configurable (ex: 1€ = 1 point). Paliers de récompenses. Attribution manuelle ou auto
e) Coupons & Offres : création de bons de réduction, offres spéciales, date d'expiration
f) Campagnes : envoi de SMS promotionnels par segment. Nécessite crédits SMS (achetés séparément par packs)
g) Configuration : paramètres généraux du programme fidélité
Le client voit sa carte sur une page web publique avec QR code, solde de points et historique.

11. ANALYSE DE BILAN (bilan.html) — Master
Upload PDF de la liasse fiscale (bilan + compte de résultat). Analyse IA (Claude) des tableaux SIG (Soldes Intermédiaires de Gestion). Ratios financiers : rentabilité, solvabilité, liquidité. Commentaires et recommandations auto. Comparaison pluriannuelle. Sauvegarde par année.

12. RAPPORT ANNUEL / SITUATION INTERMÉDIAIRE (rapport-annuel.html) — Pro+
Génération auto d'un document PDF complet. Inclut : synthèse CA, charges, résultats, graphiques, dettes, évolution. Nom de commerce personnalisable. Période configurable : année complète, semestre, trimestre, ou dates personnalisées. Année fiscale ou civile. Impression/téléchargement PDF natif via navigateur.

13. IMPORT DE DONNÉES (import.html) — Pro+
Import depuis Google Sheets : coller l'URL de la feuille. Mappage automatique des colonnes par IA (Claude). 7 modules cibles : Pilotage (CA, charges), Coût de revient, Marges, Panier moyen, Dettes, Stock, Fidélisation. Prévisualisation avant import. Filtrage par colonnes/lignes.

14. PROFIL / MON COMPTE (profil.html) — Tous plans
5 onglets : Profil (nom, email, commerce, adresse, SIRET, logo), Abonnement (plan actuel, upgrade, portail Stripe), Factures (historique Stripe), Sécurité (mot de passe), RH (paramètres module RH si Master).
Pour changer de plan : Mon compte > Abonnement > choisir le plan > paiement Stripe.
Pour annuler : Mon compte > Abonnement > Gérer via Stripe.

═══ MODULE RH COMPLET (Plan Master) ═══

15. Dashboard RH (rh-dashboard.html) : effectif, masse salariale, alertes (contrats à renouveler, périodes d'essai, absences), coûts RH détaillés, graphiques.

16. Employés & Fiches (rh-employes.html) : liste avec filtres par département/statut. Fiche complète : infos personnelles, contrat (CDI/CDD/alternance/stage), salaire, documents RH attachés, évaluations, photo. Drag & drop pour réorganiser. Archivage. Impression fiche PDF.

17. Planning (rh-planning.html) : planning hebdomadaire par employé. Saisie des horaires. Génération automatique par IA. Navigation semaine par semaine. Vue mensuelle possible.

18. Congés & Absences (rh-conges.html) : soldes par type (CP, RTT, maladie, sans solde, formation). Demandes avec validation/refus (motif obligatoire si refus). Ajustement manuel des soldes. Calendrier annuel des absences. Calcul automatique des CP acquis selon date d'entrée et jours ouvrés.

19. Temps de travail (rh-temps.html) : saisie des heures par employé et par jour. Import auto depuis le planning. Récapitulatif mensuel. Heures théoriques vs réelles. Heures supplémentaires. Écarts calculés auto.

20. Paie & Salaires (rh-paie.html) — INDICATIF uniquement : simulation de fiches de paie. Calcul estimé des cotisations (salariales ~22%, patronales ~42%). Brut, net avant IR, net à payer. Aperçu imprimable. ⚠️ NON OFFICIEL — pour les fiches officielles, voir expert-comptable.

21. Rémunération dirigeant (rh-dirigeant.html) : simulation selon statut (TNS ou assimilé salarié). Calcul charges sociales. Net/brut/coût total. Fréquence (mensuel/annuel). Simulation IR (impôt sur le revenu) avec parts fiscales. Optimisation rémunération/dividendes.

22. Recrutement (rh-recrutement.html) : offres d'emploi (poste, description, contrat, salaire). Candidats avec pipeline Kanban : À traiter → Présélection → Entretien → Offre → Embauché / Refusé. Fiches candidat (CV, notes, évaluation). Planification entretiens (date, heure, lieu). Tableau analytique.

23. Onboarding / Offboarding (rh-onboarding.html) : checklists par phases. Onboarding : pré-arrivée, jour J, première semaine, premier mois, suivi. Offboarding : pré-départ, dernier jour, post-départ, solde de tout compte. Tâches cochables. Documents à fournir/récupérer. Évaluation satisfaction.

24. Entretiens annuels (rh-entretiens.html) : par employé et par année. Sections : bilan de l'année, bilan des objectifs passés, compétences évaluées (notation étoiles), nouveaux objectifs, besoins formation, rémunération, conclusions. Score global calculé. Historique des entretiens.

25. Conformité & Légal (rh-conformite.html) : 5 affichages obligatoires (interdiction fumer/vapoter, harcèlement, égalité salariale, inspection du travail, horaires). Modèles légaux : DPAE, attestation de travail, solde de tout compte, compte-rendu entretien professionnel. Calendrier obligations. Suivi conformité par salarié. Statut par obligation (conforme/à faire/en retard).

26. Modèles de documents RH (rh-modeles.html) : bibliothèque de modèles (contrat CDI, CDD, avenant, promesse d'embauche, lettre licenciement, etc.). Génération par IA (Claude). Variables personnalisées (nom employé, poste, salaire...). Historique des documents générés. Export/impression.\n\n27. Pointeuse & Pointages (rh-pointages.html + rh-pointeuse.html) — Master :\nConfiguration (⚙️) : 3 méthodes de pointage — Tablette kiosk (code PIN 4 chiffres), Mobile GPS (espace salarié), QR code (bientôt). Options : photo anti-fraude aléatoire (~30% des pointages tablette), pointage des pauses, pointage hors planning avec motif obligatoire, seuil de retard configurable (défaut 15 min).\nTablette kiosk (rh-pointeuse.html) : écran plein écran avec horloge, pavé PIN, identification automatique. Après PIN, l'écran affiche les horaires planifiés et propose les actions contextuelles (arrivée, départ, pause début/fin). Alertes visuelles si retard (bandeau rouge) ou départ anticipé (bandeau orange). Photo webcam aléatoire avec countdown 3-2-1. Sidebar temps réel avec statut de chaque employé.\nMobile GPS (espace-salarie.html > onglet Pointage) : le salarié pointe depuis son téléphone. Position GPS enregistrée automatiquement. Coordonnées cliquables → Google Maps. Mêmes alertes retard/départ anticipé.\nDashboard pointages (rh-pointages.html) : 4 vues — Jour (KPIs présents/absents/retards, détail chaque pointage avec source Mobile/Kiosk, GPS, photo, boutons ✏️ modifier / ✕ supprimer), Salarié (historique mensuel planifié vs réalisé avec écart par jour), Récap semaine (tableau employés × jours avec colonnes Réalisé/Planifié/Écart), Alertes (retards, départs anticipés, absences vs planning, hors planning, pauses non clôturées, dépassement 10h). Export CSV. Les pointages s'écrivent dans les deux collections (privée admin + publique salarié) pour cohérence.\nPIN employé : configurable dans la fiche employé, onglet Infos. Bouton "Générer PIN aléatoire" (unicité garantie).\nCompétences : chaque employé peut avoir des compétences notées 1 à 5 étoiles, utilisées pour la polyvalence dans le planning.\n\n28. Échange de shifts (via espace-salarie.html > Planning) — Master :\nLe salarié voit ses prochains shifts (2 semaines) dans son espace. Bouton "🔄 Échanger" sur chaque jour où un collègue travaille. Il choisit un collègue dans une modal, la demande est envoyée. Statut : ⏳ En attente → ✅ Approuvé / ❌ Refusé. Les demandes apparaissent dans "Congés à valider" du Dashboard RH (type shift_swap). Le gérant valide ou refuse. Après approbation, le planning doit être mis à jour manuellement.\n\n29. Portail salarié & SMS (rh-employes.html) — Master :\nChaque employé a un lien portail unique (espace-salarie.html?id=xxx). Dans la fiche employé, onglet Infos : bouton "↗ Ouvrir", "📋 Copier", "📱 Envoyer par SMS". L'envoi SMS utilise les crédits partagés avec la fidélisation (1 crédit = 1 SMS). Le salarié accède à : planning, congés, pointage mobile, échanges de shifts. Le solde SMS est visible dans le Dashboard RH (KPI "Crédits SMS").

═══ ABONNEMENTS & TARIFS ═══
Gratuit : 0€ — accès limité (page d'accueil).
Essai : 0€ pendant 15 jours — accès COMPLET à tout.
Pro : 69€/mois ou 55€/mois en annuel (660€/an, économie 168€). Modules : Dashboard, Suivi CA, Pilotage, Cashflow, Coût de revient, Marges, Panier moyen, Dettes, Rapport annuel, Import.
Max : 99€/mois ou 79€/mois en annuel (948€/an, économie 240€). Pro + Fidélisation + Stocks.
Master : 169€/mois ou 135€/mois en annuel (1620€/an, économie 408€). Max + RH complet + Analyse Bilan IA.
Paiement par carte bancaire via Stripe. Annulation à tout moment. 15 jours d'essai gratuit offerts.

═══ CONCEPTS FINANCIERS ═══
Marge brute = PV HT − Coûts variables. Exemple : gâteau vendu 15€ HT, coûts 7,50€ → marge brute 7,50€ (50%).
Marge nette = Marge brute − Charges fixes imputées. Le vrai bénéfice.
Clé de répartition = méthode pour distribuer les charges fixes entre produits (Temps, Superficie, Volume, CA).
Coût de revient = coût total unitaire (MP + MO + emballages + livraison + quote-part charges fixes).
TVA : 5,5% (alimentation base), 10% (restauration, travaux), 20% (taux normal). ALTEORE gère les 3 séparément.
TVA à reverser = TVA collectée − TVA déductible.
Seuil de rentabilité = CA minimum pour couvrir tous les coûts.
Charges fixes = loyer, assurance, comptable (ne varient pas avec les ventes).
Charges variables = achats, matières premières (varient avec les ventes).

═══ NAVIGATION ═══
Menu latéral gauche (sidebar). Sur mobile : bouton ☰ en haut à gauche. Modules verrouillés selon le plan (icône 🔒).

═══ FAQ ═══
Comment commencer ? → Pilotage : saisir charges fixes puis CA quotidien. Le reste se remplit auto.
Données sécurisées ? → Oui, Firebase/Google Cloud, chiffrement, accès limité au propriétaire.
Changer de plan ? → Mon compte > Abonnement.
Annuler ? → Mon compte > Abonnement > Gérer via Stripe.
HT ou TTC ? → Toutes les valeurs sont en HT dans ALTEORE.
Mobile ? → Oui, responsive, fonctionne sur tous les appareils.
Installation ? → Non, navigateur web suffit.
Exporter ? → Rapport annuel PDF ou module Import/Export.
Connexion bancaire ? → Synchronisation bancaire dans le menu. Les transactions en attente sont celles récupérées de votre banque mais pas encore catégorisées ni importées dans le Pilotage.
Pointeuse ? → RH > Pointages > ⚙️ Configuration. Deux méthodes : tablette kiosk (PIN) et mobile GPS (espace salarié).
PIN salarié ? → Fiche employé > onglet Infos > section Code PIN Pointeuse.
Retards/absences ? → Dashboard Pointages > Alertes (semaine) ou Dashboard RH > Alertes (aujourd'hui).
Échange de shifts ? → Espace salarié > Planning > Échange de shifts. Validation dans Dashboard RH > Congés à valider.
Envoyer lien par SMS ? → Fiche employé > Infos > 📱 Envoyer par SMS (1 crédit SMS).

═══ SUPPORT ═══
Email support : support@alteore.com
Centre d'aide : aide.html (accessible via le menu → Centre d'aide)
Le chatbot peut ouvrir un ticket directement : quand l'utilisateur tape "problème", "ticket", "bug", un formulaire apparaît dans le chat.
Ne JAMAIS mentionner d'URL comme "alteore.com/support" → cette page n'existe pas.

═══ RÈGLES ═══
1. Toujours répondre en français, de façon concise (2-4 paragraphes max)
2. Exemples chiffrés concrets pour les concepts financiers
3. Guider vers la bonne page quand pertinent
4. Si problème technique → proposer de taper "ouvrir un ticket" directement dans ce chat, ou d'écrire à support@alteore.com
5. Si tu ne sais pas → le dire, proposer de taper "ouvrir un ticket" ou de contacter support@alteore.com
6. Ne JAMAIS inventer de fonctionnalités, de pages ou d'URL qui n'existent pas
7. Émojis avec parcimonie (1-2 max par message)
8. Pas de conseils fiscaux/comptables précis → recommander un expert-comptable
9. Si module nécessite un plan supérieur → l'indiquer, expliquer comment upgrader`;

// ═══════ LOGIQUE ═══════
var hist=[], isOpen=false, isLoading=false;
var fab=document.getElementById('chat-fab'),win=document.getElementById('cb-win'),msgs=document.getElementById('cb-msgs');
var inp=document.getElementById('cb-inp'),snd=document.getElementById('cb-snd'),notifEl=document.getElementById('cb-notif'),sugs=document.getElementById('cb-sugs');

fab.addEventListener('click',toggle);
document.getElementById('cb-cls').addEventListener('click',toggle);
document.getElementById('cb-clr').addEventListener('click',clear);
snd.addEventListener('click',send);
inp.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
inp.addEventListener('input',function(){this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px';snd.disabled=!this.value.trim();});
sugs.querySelectorAll('.cb-sg').forEach(function(b){b.addEventListener('click',function(){inp.value=this.getAttribute('data-q');send();});});

function toggle(){
  isOpen=!isOpen;
  if(isOpen){win.classList.add('open');fab.classList.add('open');notifEl.style.display='none';setTimeout(function(){inp.focus();},300);if(!hist.length)welcome();}
  else{win.classList.remove('open');fab.classList.remove('open');}
}
function welcome(){
  var n='';try{n=document.getElementById('uname')?.textContent||'';}catch(e){}
  var g=n&&n!=='Utilisateur'?'Bonjour '+n+' ! 👋':'Bonjour ! 👋';
  botMsg(g+"\n\nJe suis l'assistant ALTEORE. Je connais tout le logiciel en détail. Posez-moi n'importe quelle question sur :\n\n• Les **fonctionnalités** (marges, pilotage, fidélisation, RH, pointeuse, stocks...)\n• Les **concepts financiers** (marge brute, TVA, coût de revient...)\n• Les **tarifs** et abonnements\n• L'**utilisation** du logiciel pas à pas\n\nOu tapez \"problème\" pour ouvrir un ticket de support.");
}
function botMsg(t){hist.push({role:'assistant',content:t,time:new Date()});render();}
function userMsg(t){hist.push({role:'user',content:t,time:new Date()});render();}
function render(){
  msgs.innerHTML=hist.map(function(m){
    var b=m.role==='assistant',tm=m.time?new Date(m.time).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}):'';
    var h=b?fmt(m.content):esc(m.content);
    return '<div class="cb-m '+(b?'bot':'user')+'"><div class="cb-b">'+h+'</div><div class="cb-t">'+(b?'🤖 Assistant':'Vous')+' · '+tm+'</div></div>';
  }).join('');
  msgs.scrollTop=msgs.scrollHeight;
}
function showTyp(){var e=document.createElement('div');e.id='cb-typ';e.className='cb-typ';e.innerHTML='<div class="cb-dots"><div class="cb-dot"></div><div class="cb-dot"></div><div class="cb-dot"></div></div>';msgs.appendChild(e);msgs.scrollTop=msgs.scrollHeight;}
function hideTyp(){var e=document.getElementById('cb-typ');if(e)e.remove();}
function fmt(t){
  // Si le contenu contient du HTML brut (formulaire ticket), extraire et préserver
  var htmlBlocks=[];
  var safe=t.replace(/<div class="cb-tk[\s\S]*?<\/div>/g,function(m){htmlBlocks.push(m);return '%%HTML'+( htmlBlocks.length-1)+'%%';});
  var h=esc(safe);
  h=h.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  h=h.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank">$1</a>');
  h=h.replace(/^• (.+)$/gm,'<li>$1</li>');
  h=h.replace(/(<li>[\s\S]*?<\/li>)/,'<ul>$1</ul>');
  h=h.replace(/\n/g,'<br>');
  h=h.replace(/<br><ul>/g,'<ul>').replace(/<\/ul><br>/g,'</ul>');
  // Réinsérer les blocs HTML préservés
  htmlBlocks.forEach(function(block,i){h=h.replace('%%HTML'+i+'%%',block);});
  return h;
}
function esc(t){var d=document.createElement('div');d.textContent=t;return d.innerHTML;}

async function send(){
  var t=inp.value.trim();if(!t||isLoading)return;
  userMsg(t);inp.value='';inp.style.height='auto';snd.disabled=true;sugs.style.display='none';
  isLoading=true;showTyp();
  try{
    if(isTicket(t)){hideTyp();isLoading=false;ticketForm();return;}
    var r=await callAPI(t);hideTyp();botMsg(r);
  }catch(e){hideTyp();console.error(e);botMsg("Désolé, problème technique. Tapez **\"ouvrir un ticket\"** pour que notre équipe vous aide, ou réessayez.");}
  isLoading=false;
}

function isTicket(t){
  var kw=['ouvrir un ticket','signaler un bug','problème technique','ca marche pas','ne fonctionne pas','support technique','page blanche','impossible de'];
  var l=t.toLowerCase();return kw.some(function(k){return l.includes(k);});
}

function ticketForm(){
  botMsg('Je comprends. Remplissez ce formulaire :\n\n<div class="cb-tk" id="cb-tkf"><label>Sujet *</label><select id="cb-tk-t"><option value="">— Choisir —</option><option value="bug">🐛 Bug technique</option><option value="question">❓ Question</option><option value="suggestion">💡 Suggestion</option><option value="billing">💳 Facturation</option><option value="other">📝 Autre</option></select><label>Description *</label><textarea id="cb-tk-d" rows="3" placeholder="Décrivez le problème, sur quelle page..."></textarea><label>Email (optionnel)</label><input type="email" id="cb-tk-e" placeholder="nom@exemple.com"/><button class="cb-tkb" id="cb-tk-s">📨 Envoyer le ticket</button></div>');
  setTimeout(function(){var b=document.getElementById('cb-tk-s');if(b)b.addEventListener('click',submitTicket);},100);
}

async function submitTicket(){
  var tp=document.getElementById('cb-tk-t')?.value,ds=document.getElementById('cb-tk-d')?.value?.trim(),em=document.getElementById('cb-tk-e')?.value?.trim();
  if(!tp||!ds){alert('Remplissez le sujet et la description.');return;}
  var btn=document.getElementById('cb-tk-s');if(btn){btn.disabled=true;btn.textContent='⏳ Envoi...';}
  var ticketId='TK-'+Date.now();
  var userName='';try{userName=document.getElementById('uname')?.textContent||'';}catch(e){}
  var userEmail=em||'';try{if(!userEmail&&window._auth?.currentUser?.email)userEmail=window._auth.currentUser.email;}catch(e){}

  // 1. Sauvegarder dans Firestore
  try{if(window._uid&&window._db&&window._setDoc&&window._doc){await window._setDoc(window._doc(window._db,'tickets',window._uid,'list',ticketId),{ticketId:ticketId,type:tp,description:ds,email:userEmail,page:location.pathname,userAgent:navigator.userAgent,createdAt:new Date().toISOString(),status:'open'});}}catch(e){console.warn('Firestore ticket:',e);}

  // 2. Envoyer email via /api/send-ticket
  try{
    var parts=(userName||'Utilisateur').split(' ');
    var prenom=parts[0]||'Utilisateur';
    var nom=parts.slice(1).join(' ')||'—';
    await fetch('/api/send-ticket',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      ticketId:ticketId,nom:nom,prenom:prenom,telephone:'',email:userEmail||'chatbot@alteore.com',
      sujet:'[Chatbot] '+({bug:'Bug technique',question:'Question',suggestion:'Suggestion',billing:'Facturation',other:'Autre'}[tp]||tp),
      description:ds,page:location.pathname,uid:window._uid||'',
      plan:window._userPlan||'unknown'
    })});
  }catch(e){console.warn('Email ticket:',e);}

  var f=document.getElementById('cb-tkf');if(f)f.remove();
  botMsg('✅ **Ticket #'+ticketId+' envoyé !** Vous recevrez une confirmation par email à '+(userEmail||'votre adresse')+'.\n\nNotre équipe vous répondra rapidement. Vous pouvez aussi nous écrire à **support@alteore.com**.\n\nAutre chose ?');
}

async function callAPI(userMessage){
  var h=hist.filter(function(m){return m.role==='user'||m.role==='assistant';}).slice(-10).map(function(m){return{role:m.role,content:m.content};});
  if(h.length>0&&h[h.length-1].role==='user')h.pop();
  var messages=h.concat([{role:'user',content:userMessage}]);
  try{
    var r=await fetch('/api/chatbot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:messages,system:SYSTEM_PROMPT,uid:window._uid||null})});
    if(!r.ok)throw new Error('API '+r.status);
    var d=await r.json();
    return d.response||fallback(userMessage);
  }catch(e){console.error('API failed:',e);return fallback(userMessage);}
}

// ═══════════════════════════════════════════
//  FALLBACK LOCAL — 40+ sujets couverts
// ═══════════════════════════════════════════
function fallback(text){
  var t=text.toLowerCase();

  // Marges
  if(t.includes('marge brute')&&!t.includes('nette'))return "La **marge brute** = Prix de vente HT − Coûts variables (matières premières + main d'œuvre + emballages + livraison).\n\nExemple : gâteau vendu 15€ HT, coûts 7,50€ → marge brute = **7,50€** (50%).\n\nCodes couleur : 🟢 ≥ 30% | 🟠 10-30% | 🔴 < 10%\n\nAnalysez dans **Marge brute & nette** (menu KPIs Clés).";
  if(t.includes('marge nette'))return "La **marge nette** = Marge brute − Charges fixes imputées. C'est le vrai bénéfice par produit.\n\nPour la calculer, configurez votre **clé de répartition** dans le module Marge brute & nette.\n\nCodes couleur : 🟢 ≥ 20% | 🟠 5-20% | 🔴 < 5%";
  if(t.includes('marge'))return "ALTEORE calcule deux types de marges :\n\n• **Marge brute** = PV HT − Coûts variables (ce qui reste après les coûts de production)\n• **Marge nette** = Marge brute − Charges fixes imputées (le vrai bénéfice)\n\nAllez dans **Marge brute & nette** (menu KPIs Clés) pour analyser chaque produit.";

  // Clé de répartition
  if(t.includes('clé')||t.includes('cle de rep')||t.includes('répartition'))return "La **clé de répartition** distribue vos charges fixes entre vos produits. 4 méthodes :\n\n• **Temps** : heures de production\n• **Superficie** : m² utilisés\n• **Volume** : unités produites\n• **CA** : chiffre d'affaires\n\nExemple : si un produit prend 30% de votre temps, il supporte 30% des charges fixes.\n\nConfigurez-la dans le module **Marge brute & nette**.";

  // Simulateur
  if(t.includes('simulat')||t.includes('scénario'))return "Le **simulateur** (module Marges) permet de tester l'impact sur vos marges :\n\n• Modifier le prix de vente (€ ou %)\n• Réduire matières premières, main d'œuvre, charges fixes\n• Changer le volume de ventes\n\nUn tableau comparatif montre les écarts entre situation actuelle et simulation.";

  // Coût de revient
  if(t.includes('coût de revient')||t.includes('cout de revient'))return "Le **Coût de revient** = coût total pour produire 1 unité : matières premières + main d'œuvre + emballages + livraison + quote-part charges fixes.\n\nCréez vos fiches dans **Coût de revient** (menu KPIs Clés). Le calcul est automatique. Vous pouvez aussi importer depuis Google Sheets.";

  // Pilotage
  if(t.includes('pilotage')||t.includes('saisie mensuelle'))return "Le **Pilotage** est le module central de saisie. Par mois :\n\n• CA quotidien (3 taux TVA : 5,5%, 10%, 20%)\n• Charges fixes (loyer, assurance...)\n• Charges variables (achats, frais...)\n• Crédits et leasings\n\nAstuce : commencez par les charges fixes, puis le CA jour par jour. Utilisez \"Appliquer les charges fixes\" pour les reporter sur tous les mois.";

  // CA / Chiffre d'affaires
  if(t.includes('saisir')&&(t.includes('ca')||t.includes('chiffre'))||t.includes('ca quotidien'))return "Pour saisir votre CA quotidien :\n\n1. Allez dans **Pilotage** (menu latéral)\n2. Choisissez le mois\n3. Saisissez les montants **HT** par jour et par taux de TVA (5,5%, 10%, 20%)\n4. Les totaux se calculent automatiquement\n\nLes données apparaissent ensuite dans le Suivi CA et le Dashboard.";

  // Dashboard
  if(t.includes('dashboard')||t.includes('tableau de bord'))return "Le **Dashboard** affiche une vue synthétique de votre activité : CA du mois, charges, résultat net, trésorerie, graphiques.\n\nIl se remplit automatiquement avec les données saisies dans le Pilotage. Rien à saisir ici, c'est une vue de synthèse.";

  // Cashflow
  if(t.includes('cashflow')||t.includes('trésorerie'))return "Le **Cashflow** montre votre trésorerie mois par mois : CA encaissé − Charges − TVA à reverser − Crédits − Leasings.\n\nLes données viennent du Pilotage. Allez dans **Pilotage > Cashflow** dans le menu.";

  // Fidélisation
  if(t.includes('fidéli')||t.includes('fideli')||t.includes('carte fid')||t.includes('qr code'))return "Le module **Fidélisation** (plan Max+) permet de :\n\n• Créer des cartes fidélité digitales avec QR code\n• Gérer vos clients et leur historique\n• Définir des récompenses (paliers de points)\n• Créer des coupons et offres spéciales\n• Envoyer des SMS promotionnels\n\nVos clients voient leur carte sur une page web publique avec QR code et solde de points.";

  // Dettes
  if(t.includes('dette')||t.includes('emprunt')||t.includes('créancier')||t.includes('remboursement'))return "Le module **Dettes & Emprunts** permet de suivre tous vos emprunts :\n\n• Ajoutez chaque dette (créancier, montant, taux, durée)\n• L'échéancier se génère automatiquement (capital + intérêts)\n• Cochez les mensualités payées\n• Suivez le capital restant dû\n\nMenu KPIs Clés > **Dettes & Emprunts**.";

  // Stock
  if(t.includes('stock')||t.includes('inventaire'))return "Le module **Stocks** (plan Max+) gère :\n\n• Stock produits (actuel, minimum, prix d'achat)\n• Mouvements (entrées/sorties)\n• Alertes de stock bas\n• Valorisation totale du stock\n\nLes produits peuvent être importés depuis le Coût de revient.";

  // Panier moyen
  if(t.includes('panier moyen')||t.includes('ticket moyen'))return "Le **Panier moyen** = CA du jour ÷ Nombre de tickets. Saisissez le nombre de transactions par jour dans le module **Panier moyen** (KPIs Clés), le calcul est automatique. Vues par jour, semaine, mois.";

  // TVA
  if(t.includes('tva'))return "ALTEORE gère 3 taux de TVA français :\n\n• **5,5%** : alimentation de base, livres\n• **10%** : restauration sur place, travaux\n• **20%** : taux normal\n\nDans le Pilotage, saisissez le CA HT par taux. La TVA collectée et déductible est calculée automatiquement.\n\nTVA à reverser = TVA collectée − TVA déductible.";

  // Tarifs / Abonnements
  if(t.includes('prix')||t.includes('tarif')||t.includes('abonnement')||t.includes('plan')||t.includes('combien'))return "ALTEORE propose :\n\n• **Pro** : 69€/mois (55€ en annuel) — Gestion financière complète\n• **Max** : 99€/mois (79€ en annuel) — Pro + Fidélisation + Stocks\n• **Master** : 169€/mois (135€ en annuel) — Max + RH + Analyse IA\n\n**15 jours d'essai gratuit** inclus. Détails sur [pricing.html](pricing.html).";

  // RH
  if(t.includes('rh')||t.includes('ressources humaines'))return "Le **module RH** (plan Master) comprend :\n\n• Fiches employés, contrats, documents\n• Planning hebdomadaire (génération IA)\n• Congés & absences avec validation\n• Temps de travail\n• **Pointeuse** (tablette kiosk PIN + mobile GPS)\n• **Dashboard pointages** (planifié vs réalisé, alertes)\n• **Échange de shifts** entre salariés\n• Simulation paie (indicatif)\n• Rémunération dirigeant\n• Recrutement (pipeline Kanban)\n• Onboarding/Offboarding\n• Entretiens annuels\n• Conformité légale & modèles documents";
  if(t.includes('employé')||t.includes('salarié')||t.includes('fiche'))return "Le module **Employés** (plan Master) permet de créer des fiches complètes : infos personnelles, contrat (CDI/CDD/alternance), salaire, documents RH, évaluations, photo. Filtres par département et statut.";
  if(t.includes('planning')||t.includes('horaire'))return "Le **Planning RH** (plan Master) permet de gérer les horaires hebdomadaires par employé. Vous pouvez aussi utiliser la **génération automatique par IA**. Navigation semaine par semaine.";
  if(t.includes('congé')||t.includes('absence')||t.includes('vacances'))return "Le module **Congés** (plan Master) gère les soldes par type (CP, RTT, maladie...), les demandes avec validation/refus, et le calendrier annuel des absences. Les CP acquis sont calculés automatiquement.";
  if(t.includes('paie')||t.includes('salaire')||t.includes('fiche de paie'))return "Le module **Paie** (plan Master) simule des fiches de paie avec cotisations estimées. ⚠️ C'est **indicatif uniquement** — pour des fiches officielles, consultez votre expert-comptable.";
  if(t.includes('dirigeant')||t.includes('tns'))return "Le module **Rémunération dirigeant** (plan Master) simule votre rémunération selon le statut (TNS ou assimilé salarié), calcule les charges sociales et optimise le rapport rémunération/dividendes.";
  if(t.includes('recrutement')||t.includes('candidat')||t.includes('kanban'))return "Le module **Recrutement** (plan Master) propose un pipeline Kanban : À traiter → Présélection → Entretien → Offre → Embauché/Refusé. Fiches candidat, planification d'entretiens, suivi complet.";
  if(t.includes('onboarding')||t.includes('offboarding')||t.includes('intégration'))return "Le module **Onboarding/Offboarding** (plan Master) fournit des checklists par phases pour l'intégration des nouveaux employés et le départ des sortants. Tâches cochables et documents à fournir.";
  if(t.includes('entretien annuel')||t.includes('évaluation'))return "Les **Entretiens annuels** (plan Master) permettent de faire le bilan par employé : objectifs, compétences (notation étoiles), formation, rémunération, conclusions. Historique sauvegardé.";
  if(t.includes('conformité')||t.includes('légal')||t.includes('affichage obligatoire'))return "Le module **Conformité** (plan Master) inclut les affichages obligatoires (harcèlement, égalité salariale, etc.) et des modèles de documents légaux (DPAE, attestation, solde de tout compte).";
  if(t.includes('modèle')||t.includes('document rh')||t.includes('contrat'))return "Les **Modèles RH** (plan Master) proposent une bibliothèque de documents (contrats, avenants, attestations) avec **génération par IA**. Variables personnalisées automatiquement.";
  if(t.includes('temps de travail')||t.includes('heures sup'))return "Le module **Temps de travail** (plan Master) suit les heures par employé et par jour. Récapitulatif mensuel avec heures théoriques vs réelles et calcul des heures supplémentaires.";

  // Pointeuse
  if(t.includes('pointeuse')||t.includes('kiosk')||t.includes('tablette pointage'))return "La **pointeuse tablette** (plan Master) fonctionne avec un code PIN à 4 chiffres par salarié.\n\nOuvrez le lien pointeuse sur une tablette en mode plein écran. Le salarié tape son PIN et voit ses actions disponibles (arrivée, départ, pause).\n\nConfiguration : **RH > Pointages > ⚙️ Configuration**. Activez la photo anti-fraude (~30% des pointages) et réglez le seuil de retard.\n\nPour configurer le PIN : **fiche employé > onglet Infos > Code PIN**.";
  if(t.includes('pointer')||t.includes('pointage'))return "ALTEORE propose 2 méthodes de pointage :\n\n• **Tablette kiosk** : PIN 4 chiffres, installée en magasin\n• **Mobile GPS** : depuis l'espace salarié, avec géolocalisation\n\nLe **Dashboard Pointages** (RH > Pointages) affiche 4 vues : Jour, Salarié, Récap semaine, Alertes. Vous pouvez corriger les erreurs (✏️ modifier / ✕ supprimer).\n\nLes heures planifiées au planning sont comparées aux heures réellement pointées.";
  if(t.includes('pin')||t.includes('code pin'))return "Le **code PIN** est un code à 4 chiffres unique par salarié, utilisé pour la pointeuse tablette.\n\nPour le configurer : ouvrez la **fiche de l'employé > onglet Infos > section Code PIN Pointeuse**. Vous pouvez saisir un code manuellement ou cliquer **🎲 Générer** pour un code aléatoire (unicité garantie).";
  if(t.includes('retard')||t.includes('en retard'))return "Les **retards** sont détectés automatiquement quand un salarié pointe son arrivée plus de 15 min après l'heure prévue au planning.\n\n• Sur la **tablette** : bandeau rouge affiché au salarié\n• Dans le **Dashboard Pointages > Alertes** : alerte détaillée avec écart\n• Dans le **Dashboard RH > Alertes** : résumé du jour\n\nLe seuil est configurable dans ⚙️ Configuration (15 min par défaut).";
  if(t.includes('départ anticipé')||t.includes('part avant'))return "Si un salarié pointe son **départ avant la fin prévue** au planning (plus de 15 min d'écart), une alerte s'affiche :\n\n• Sur la **tablette/mobile** : bandeau orange avec le temps manquant\n• Dans le **Dashboard Pointages > Alertes** : alerte 🚪 avec détail\n• Dans le **Dashboard RH** : résumé du jour\n\nPendant le travail, un bandeau rappelle l'heure de fin prévue.";
  if(t.includes('planifié vs réalisé')||t.includes('planifie vs realise')||t.includes('écart heures'))return "La comparaison **Planifié vs Réalisé** croise le planning avec les pointages.\n\n• **Vue Jour** : tableau par salarié avec heures planifiées, arrivée, départ et écart\n• **Vue Salarié** : historique mensuel avec colonnes Planifié/Réalisé/Écart\n• **Vue Récap** : tableau semaine avec totaux comparés\n\nAllez dans **RH > Pointages** pour accéder à ces vues.";
  if(t.includes('corriger pointage')||t.includes('modifier pointage')||t.includes('supprimer pointage'))return "Pour corriger un pointage erroné :\n\n1. **RH > Pointages**, vue **Jour**\n2. Trouvez le pointage dans le tableau\n3. **✏️ Modifier** : changez l'heure (format HH:MM)\n4. **✕ Supprimer** : retire le pointage\n\nL'ancienne heure reste visible après modification. Les corrections sont répercutées partout (tablette + mobile).";
  if(t.includes('photo anti-fraude')||t.includes('photo pointage'))return "La **photo anti-fraude** est optionnelle. Quand elle est activée, environ 30% des pointages sur tablette déclenchent une capture photo automatique (countdown 3-2-1 + flash).\n\nLes photos sont visibles dans le journal admin de la pointeuse et dans le Dashboard Pointages.\n\nActivez/désactivez dans **RH > Pointages > ⚙️ Configuration**.";

  // Échange de shifts
  if(t.includes('échange')||t.includes('echange')||t.includes('shift'))return "L'**échange de shifts** permet à un salarié de proposer d'échanger son créneau avec un collègue.\n\n1. Le salarié ouvre son **espace personnel > Planning > Échange de shifts**\n2. Il choisit un jour et un collègue\n3. La demande arrive dans **Dashboard RH > Congés à valider**\n4. Vous approuvez ou refusez\n\nAprès approbation, mettez à jour le planning manuellement.";

  // Portail salarié / SMS
  if(t.includes('portail salarié')||t.includes('espace salarié')||t.includes('lien salarié'))return "Chaque employé a un **lien portail unique** vers son espace personnel. Il y accède à :\n\n• Son **planning** (horaires de la semaine)\n• Ses **congés** (soldes + demandes)\n• Le **pointage mobile** avec GPS\n• Les **échanges de shifts**\n\nTrouvez le lien dans la **fiche employé > onglet Infos > section Portail salarié**. Boutons : ↗ Ouvrir, 📋 Copier, 📱 Envoyer par SMS.";
  if(t.includes('envoyer sms')||t.includes('sms salarié')||t.includes('sms portail'))return "Pour envoyer le lien portail par SMS :\n\n1. Ouvrez la **fiche de l'employé > onglet Infos**\n2. Vérifiez que le numéro de téléphone est renseigné\n3. Cliquez **📱 Envoyer par SMS**\n4. Confirmez l'envoi (1 crédit SMS déduit)\n\nLes crédits SMS sont **partagés** avec le module Fidélisation. Solde visible dans le **Dashboard RH** (carte Crédits SMS).";
  if(t.includes('compétence')||t.includes('competence')||t.includes('polyvalence'))return "Les **compétences** se configurent dans la fiche employé (onglet Infos). Ajoutez un nom de compétence et un niveau (1 à 5 étoiles).\n\nElles sont utilisées dans le **Planning** pour la polyvalence : vous voyez qui sait faire quoi et planifiez en conséquence.";
  if(t.includes('hors planning')||t.includes('non planifié'))return "Si un salarié pointe sur la **tablette kiosk** alors qu'il n'est pas planifié, un **motif obligatoire** est demandé (ex: 'Remplacement de Marie').\n\nCe pointage est marqué comme **'Hors planning'** et visible avec un badge orange dans le Dashboard Pointages.";
  if(t.includes('gps')||t.includes('géolocalisation')||t.includes('position'))return "Le **pointage mobile** enregistre automatiquement la position GPS du salarié. Les coordonnées sont visibles dans le Dashboard Pointages et dans l'historique de l'espace salarié. Elles sont **cliquables** et ouvrent Google Maps.";

  // Bilan
  if(t.includes('bilan')||t.includes('liasse fiscale'))return "L'**Analyse de Bilan** (plan Master) permet d'uploader votre liasse fiscale en PDF. L'IA analyse les données du SIG, calcule les ratios financiers et fournit des recommandations.";

  // Rapport
  if(t.includes('rapport')||t.includes('pdf')||t.includes('situation intermédiaire'))return "Le **Rapport annuel** (plan Pro+) génère un PDF complet : synthèse CA, charges, résultats, graphiques, dettes. Période configurable (année, semestre, trimestre). Menu > **Rapport annuel PDF**.";

  // Import
  if(t.includes('import')||t.includes('google sheets'))return "Le module **Import** (plan Pro+) importe des données depuis Google Sheets. L'IA mappe automatiquement vos colonnes. 7 modules cibles : Pilotage, Coût de revient, Marges, Panier moyen, Dettes, Stock, Fidélisation.";

  // Profil / Compte
  if(t.includes('profil')||t.includes('compte')||t.includes('mot de passe')||t.includes('siret'))return "Allez dans **Mon compte** (cliquez sur votre nom en bas du menu). Onglets : Profil (nom, commerce, SIRET, logo), Abonnement, Factures, Sécurité, RH.";

  // Annuler / Changer plan
  if(t.includes('annuler')||t.includes('résilier'))return "Pour annuler votre abonnement : **Mon compte > Abonnement > Gérer via Stripe**. L'accès reste actif jusqu'à la fin de la période payée. Annulation sans frais.";
  if(t.includes('changer de plan')||t.includes('upgrade')||t.includes('passer au'))return "Pour changer de plan : **Mon compte > Abonnement**, choisissez le nouveau plan et validez. Le paiement est géré par Stripe. Vous pouvez upgrader ou downgrader à tout moment.";

  // Sécurité / Données
  if(t.includes('sécurité')||t.includes('données')||t.includes('sécurisé'))return "Vos données sont hébergées sur **Firebase (Google Cloud)** avec chiffrement. Chaque utilisateur ne peut accéder qu'à ses propres données. Paiements sécurisés par Stripe.";

  // Mobile
  if(t.includes('mobile')||t.includes('téléphone')||t.includes('application'))return "ALTEORE fonctionne sur tous les appareils (ordinateur, tablette, smartphone) directement dans le navigateur web. Pas d'installation nécessaire. Sur mobile, utilisez le bouton ☰ pour ouvrir le menu.";

  // Commencer
  if(t.includes('commencer')||t.includes('débuter')||t.includes('premier'))return "Pour bien démarrer :\n\n1. **Pilotage** : saisissez vos charges fixes puis votre CA quotidien\n2. **Dashboard** : il se remplit automatiquement\n3. **Coût de revient** : créez vos fiches produits\n4. **Marges** : analysez la rentabilité\n\nLe Pilotage est la base de tout !";

  // Charges fixes/variables
  if(t.includes('charges fixes'))return "Les **charges fixes** sont les dépenses qui ne varient pas avec vos ventes : loyer, assurance, expert-comptable, abonnements, téléphone...\n\nSaisissez-les dans **Pilotage** > section Charges fixes. Le bouton \"Appliquer\" les reporte sur les mois suivants.";
  if(t.includes('charges variables'))return "Les **charges variables** varient avec votre volume de ventes : achats de marchandises, matières premières, frais de port, emballages...\n\nSaisissez-les dans **Pilotage** > section Charges variables, mois par mois.";

  // Seuil de rentabilité
  if(t.includes('seuil')||t.includes('rentabilité'))return "Le **seuil de rentabilité** est le niveau de CA où vos revenus couvrent exactement tous vos coûts (fixes + variables). En dessous vous perdez de l'argent, au-dessus vous en gagnez.\n\nASTUCE : analysez vos marges et charges dans ALTEORE pour estimer votre seuil.";

  // HT / TTC
  if(t.includes('ht')||t.includes('ttc')||t.includes('hors taxe'))return "Toutes les valeurs dans ALTEORE sont en **HT** (Hors Taxes). La TVA est calculée séparément dans le Pilotage. Le CA est saisi en HT par taux de TVA.";

  // SMS
  if(t.includes('sms')&&!t.includes('salarié')&&!t.includes('portail'))return "Les **crédits SMS** sont partagés entre Fidélisation et RH :\n\n• **Fidélisation** : campagnes promotionnelles, roue cadeaux\n• **RH** : envoi du lien portail salarié (📱 dans la fiche employé)\n\nAchetez des packs dans le module Fidélisation > Campagnes. 1 crédit = 1 SMS envoyé. Solde visible dans le Dashboard RH.";

  // Exercice fiscal
  if(t.includes('fiscal')||t.includes('exercice'))return "ALTEORE supporte les **années fiscales décalées** (pas forcément janvier-décembre). Configurez le mois de début d'exercice dans les paramètres du Dashboard ou du Suivi CA.";

  // Banque / synchronisation bancaire
  if(t.includes('banque')||t.includes('bancaire')||t.includes('en attente')||t.includes('doublon')||t.includes('synchronisation'))return "Le module **Synchronisation bancaire** vous permet de connecter votre compte bancaire professionnel via GoCardless.\n\n**Les onglets :**\n• **En attente** : transactions récupérées de votre banque, à catégoriser (charge fixe, variable, CA...) puis importer dans le Pilotage\n• **Doublons** : transactions potentiellement déjà saisies — vous pouvez ignorer, garder les deux, ou remplacer\n• **Importées** : déjà validées et envoyées dans le Pilotage\n• **Ignorées** : transactions marquées comme non pertinentes\n• **Encaissements** : crédits (entrées sur le compte)\n\nLes transactions importées alimentent directement votre **Pilotage** (charges fixes, variables ou CA).";

  // Salutations
  if(t.includes('bonjour')||t.includes('salut')||t.includes('hello')||t.includes('bonsoir')||t.includes('coucou'))return "Bonjour ! 👋 Comment puis-je vous aider aujourd'hui ?";
  if(t.includes('merci'))return "Je vous en prie ! 😊 N'hésitez pas si vous avez d'autres questions.";
  if(t.includes('au revoir')||t.includes('bye'))return "Au revoir et bonne continuation avec ALTEORE ! 👋";

  // Questions sur le chatbot lui-même
  if(t.includes('qui es-tu')||t.includes('qui es tu')||t.includes('tu es qui'))return "Je suis l'**Assistant ALTEORE**, un chatbot intégré au logiciel. Je connais toutes les fonctionnalités en détail et je peux vous expliquer les concepts financiers. Pour les problèmes techniques, je peux ouvrir un ticket de support.";

  // Réponse générique
  return "Je peux vous aider sur de nombreux sujets :\n\n• **Modules** : marges, pilotage, fidélisation, RH, stocks, dettes, panier moyen, synchronisation bancaire...\n• **Concepts** : marge brute/nette, TVA, coût de revient, clé de répartition...\n• **Tarifs** : plans Pro, Max, Master\n• **Utilisation** : comment saisir le CA, commencer, changer de plan, connecter sa banque...\n\nReformulez votre question ou tapez \"problème\" pour un ticket support.";
}

function clear(){hist=[];msgs.innerHTML='';sugs.style.display='flex';welcome();}
setTimeout(function(){if(!isOpen&&!hist.length){notifEl.style.display='flex';}},30000);

})();
