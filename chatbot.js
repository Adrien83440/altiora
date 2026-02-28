// ╔══════════════════════════════════════════════════════════╗
// ║  ALTEORE — Chatbot Assistant (auto-injectable)          ║
// ║  Chargé automatiquement via nav.js                      ║
// ╚══════════════════════════════════════════════════════════╝

(function () {
  'use strict';

  // Éviter double injection
  if (document.getElementById('alteore-chatbot')) return;

  // Ne pas charger sur les pages publiques (login, pricing, etc.)
  const noChat = ['index.html', 'pricing.html', 'inscription.html', 'login.html', 'forgot.html'];
  const currentPage = window.location.pathname.split('/').pop() || 'index.html';
  if (noChat.includes(currentPage)) return;

  // ══════════════════════════════════
  //  1. INJECTION CSS
  // ══════════════════════════════════
  const style = document.createElement('style');
  style.id = 'alteore-chatbot-css';
  style.textContent = `
/* ALTEORE CHATBOT STYLES */
#alteore-chatbot {
  --cb-blue: #1a3dce;
  --cb-blue-dark: #0f1f5c;
  --cb-blue-light: #4f7ef8;
  --cb-blue-ghost: #f0f4ff;
  --cb-text: #1a1f36;
  --cb-muted: #6b7280;
  --cb-border: #e2e8f0;
  --cb-bg: #f5f7ff;
  --cb-green: #10b981;
  --cb-radius: 16px;
  font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
  position: fixed;
  bottom: 0;
  right: 0;
  z-index: 9990;
}

#chat-fab {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 9991;
  width: 60px;
  height: 60px;
  border-radius: 50%;
  border: none;
  background: linear-gradient(135deg, #0f1f5c 0%, #1a3dce 50%, #4f7ef8 100%);
  color: white;
  font-size: 26px;
  cursor: pointer;
  box-shadow: 0 6px 24px rgba(15,31,92,0.35), 0 2px 8px rgba(26,61,206,0.2);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s cubic-bezier(0.4,0,0.2,1);
  -webkit-tap-highlight-color: transparent;
}
#chat-fab:hover { transform: scale(1.08); box-shadow: 0 8px 32px rgba(15,31,92,0.45); }
#chat-fab:active { transform: scale(0.95); }
#chat-fab.open { background: #374151; }
#chat-fab.open .cb-icon-open { display: none; }
#chat-fab.open .cb-icon-close { display: block; }
.cb-icon-close { display: none; font-size: 20px; }
.cb-notif {
  position: absolute;
  top: -2px; right: -2px;
  background: #ef4444;
  color: white;
  font-size: 11px;
  font-weight: 800;
  width: 20px; height: 20px;
  border-radius: 50%;
  display: none;
  align-items: center; justify-content: center;
  border: 2px solid white;
  animation: cbNotifPop 0.3s ease;
}
@keyframes cbNotifPop { 0%{transform:scale(0)} 70%{transform:scale(1.2)} 100%{transform:scale(1)} }

.cb-window {
  position: fixed;
  bottom: 96px;
  right: 24px;
  width: 400px;
  max-height: calc(100vh - 140px);
  background: white;
  border-radius: var(--cb-radius);
  border: 1px solid var(--cb-border);
  box-shadow: 0 12px 48px rgba(15,31,92,0.18), 0 4px 16px rgba(0,0,0,0.08);
  display: none;
  flex-direction: column;
  overflow: hidden;
  z-index: 9992;
}
.cb-window.open { display: flex; animation: cbSlideUp 0.3s cubic-bezier(0.4,0,0.2,1); }
@keyframes cbSlideUp { from{opacity:0;transform:translateY(16px) scale(0.97)} to{opacity:1;transform:translateY(0) scale(1)} }

.cb-header {
  padding: 16px 18px;
  background: linear-gradient(135deg, #0f1f5c 0%, #1a3dce 100%);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}
.cb-header-left { display: flex; align-items: center; gap: 12px; }
.cb-avatar {
  width: 40px; height: 40px;
  background: rgba(255,255,255,0.15);
  border: 1.5px solid rgba(255,255,255,0.25);
  border-radius: 12px;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px; font-weight: 800; color: white;
  position: relative;
}
.cb-status {
  position: absolute; bottom: -2px; right: -2px;
  width: 10px; height: 10px;
  background: #10b981;
  border-radius: 50%;
  border: 2px solid #0f1f5c;
}
.cb-h-title { font-size: 14px; font-weight: 700; color: white; }
.cb-h-sub { font-size: 11px; color: rgba(255,255,255,0.55); }
.cb-h-actions { display: flex; gap: 4px; }
.cb-h-btn {
  background: rgba(255,255,255,0.1);
  border: none;
  color: rgba(255,255,255,0.7);
  width: 32px; height: 32px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
}
.cb-h-btn:hover { background: rgba(255,255,255,0.2); color: white; }

.cb-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 300px;
  max-height: 420px;
  background: var(--cb-bg);
  scroll-behavior: smooth;
}
.cb-messages::-webkit-scrollbar { width: 5px; }
.cb-messages::-webkit-scrollbar-track { background: transparent; }
.cb-messages::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 99px; }

.cb-msg {
  max-width: 85%;
  display: flex;
  flex-direction: column;
  gap: 4px;
  animation: cbMsgIn 0.25s ease;
}
@keyframes cbMsgIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
.cb-msg.bot { align-self: flex-start; }
.cb-msg.user { align-self: flex-end; }
.cb-bubble {
  padding: 12px 16px;
  border-radius: 14px;
  font-size: 13px;
  line-height: 1.6;
  word-wrap: break-word;
}
.cb-msg.bot .cb-bubble {
  background: white;
  color: var(--cb-text);
  border: 1px solid var(--cb-border);
  border-bottom-left-radius: 4px;
}
.cb-msg.user .cb-bubble {
  background: linear-gradient(135deg, #1a3dce 0%, #4f7ef8 100%);
  color: white;
  border-bottom-right-radius: 4px;
}
.cb-time {
  font-size: 10px;
  color: var(--cb-muted);
  padding: 0 4px;
}
.cb-msg.user .cb-time { text-align: right; }

.cb-typing {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px;
  background: white;
  border: 1px solid var(--cb-border);
  border-radius: 14px;
  border-bottom-left-radius: 4px;
  align-self: flex-start;
  max-width: 100px;
}
.cb-dots { display: flex; gap: 4px; }
.cb-dot {
  width: 7px; height: 7px;
  background: #94a3b8;
  border-radius: 50%;
  animation: cbBounce 1.4s infinite ease-in-out;
}
.cb-dot:nth-child(2) { animation-delay: 0.16s; }
.cb-dot:nth-child(3) { animation-delay: 0.32s; }
@keyframes cbBounce { 0%,80%,100%{transform:scale(0.6);opacity:0.4} 40%{transform:scale(1);opacity:1} }

.cb-suggestions {
  padding: 8px 16px 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  background: white;
  border-top: 1px solid #f1f5f9;
  flex-shrink: 0;
}
.cb-sug-btn {
  padding: 6px 12px;
  background: #f0f4ff;
  border: 1.5px solid #dbeafe;
  border-radius: 20px;
  font-family: 'Plus Jakarta Sans', sans-serif;
  font-size: 11px;
  font-weight: 600;
  color: #1a3dce;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.cb-sug-btn:hover { background: #dbeafe; border-color: #4f7ef8; transform: translateY(-1px); }

.cb-input-area {
  padding: 12px 16px 10px;
  background: white;
  border-top: 1px solid var(--cb-border);
  flex-shrink: 0;
}
.cb-input-wrap {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  background: #f8fafc;
  border: 1.5px solid var(--cb-border);
  border-radius: 12px;
  padding: 6px 6px 6px 14px;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.cb-input-wrap:focus-within {
  border-color: #1a3dce;
  box-shadow: 0 0 0 3px rgba(26,61,206,0.1);
  background: white;
}
.cb-input {
  flex: 1;
  border: none;
  background: transparent;
  font-family: 'Plus Jakarta Sans', sans-serif;
  font-size: 13px;
  color: #1a1f36;
  resize: none;
  outline: none;
  max-height: 100px;
  line-height: 1.5;
  padding: 6px 0;
}
.cb-input::placeholder { color: #94a3b8; }
.cb-send {
  width: 36px; height: 36px;
  border-radius: 10px;
  border: none;
  background: linear-gradient(135deg, #1a3dce, #4f7ef8);
  color: white;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
  transition: all 0.15s;
  opacity: 0.5;
}
.cb-send:not(:disabled) { opacity: 1; }
.cb-send:not(:disabled):hover { transform: scale(1.05); box-shadow: 0 2px 8px rgba(26,61,206,0.3); }
.cb-footer {
  text-align: center;
  font-size: 10px;
  color: #94a3b8;
  margin-top: 6px;
}
.cb-footer a { color: #1a3dce; text-decoration: none; }
.cb-footer a:hover { text-decoration: underline; }

/* Rich content */
.cb-bubble a { color: #1a3dce; text-decoration: underline; }
.cb-msg.user .cb-bubble a { color: #bfdbfe; }
.cb-bubble ul, .cb-bubble ol { margin: 6px 0; padding-left: 18px; }
.cb-bubble li { margin-bottom: 3px; }
.cb-bubble strong { font-weight: 700; }
.cb-bubble code { background: rgba(0,0,0,0.06); padding: 1px 5px; border-radius: 4px; font-size: 12px; }

/* Ticket form */
.cb-ticket label { display:block; font-size:11px; font-weight:600; color:#6b7280; margin-bottom:4px; margin-top:8px; }
.cb-ticket input, .cb-ticket textarea, .cb-ticket select {
  width:100%; padding:8px 10px; border:1.5px solid #e2e8f0; border-radius:8px;
  font-family:'Plus Jakarta Sans',sans-serif; font-size:12px; color:#1a1f36; outline:none; box-sizing:border-box;
}
.cb-ticket input:focus, .cb-ticket textarea:focus, .cb-ticket select:focus { border-color:#1a3dce; }
.cb-ticket-btn {
  margin-top:10px; width:100%; padding:9px; border:none;
  background:linear-gradient(135deg,#1a3dce,#4f7ef8); color:white; border-radius:8px;
  font-family:'Plus Jakarta Sans',sans-serif; font-size:12px; font-weight:700;
  cursor:pointer; transition:opacity 0.15s;
}
.cb-ticket-btn:hover { opacity:0.9; }

/* MOBILE */
@media (max-width: 768px) {
  #chat-fab { bottom:16px; right:16px; width:54px; height:54px; font-size:22px; }
  .cb-window {
    bottom:0; right:0; left:0;
    width:100%!important; max-width:100%!important;
    max-height:100vh; height:100vh;
    border-radius:0;
  }
  .cb-window.open { animation: cbSlideUpM 0.3s ease; }
  @keyframes cbSlideUpM { from{transform:translateY(100%)} to{transform:translateY(0)} }
  .cb-messages { max-height:none; min-height:0; flex:1; }
  .cb-input { font-size:16px!important; }
}
`;
  document.head.appendChild(style);

  // ══════════════════════════════════
  //  2. INJECTION HTML
  // ══════════════════════════════════
  const container = document.createElement('div');
  container.id = 'alteore-chatbot';
  container.innerHTML = `
    <button id="chat-fab" aria-label="Ouvrir l'assistant ALTEORE">
      <span class="cb-icon-open">💬</span>
      <span class="cb-icon-close">✕</span>
      <span class="cb-notif" id="cb-notif">1</span>
    </button>
    <div class="cb-window" id="cb-window">
      <div class="cb-header">
        <div class="cb-header-left">
          <div class="cb-avatar"><span>A</span><span class="cb-status"></span></div>
          <div>
            <div class="cb-h-title">Assistant ALTEORE</div>
            <div class="cb-h-sub">En ligne · Répond en quelques secondes</div>
          </div>
        </div>
        <div class="cb-h-actions">
          <button class="cb-h-btn" id="cb-clear-btn" title="Nouvelle conversation">🗑</button>
          <button class="cb-h-btn" id="cb-close-btn" title="Fermer">✕</button>
        </div>
      </div>
      <div class="cb-messages" id="cb-messages"></div>
      <div class="cb-suggestions" id="cb-suggestions">
        <button class="cb-sug-btn" data-q="Comment fonctionne la marge brute ?">📊 Marge brute</button>
        <button class="cb-sug-btn" data-q="Comment saisir mon CA quotidien ?">💰 Saisie du CA</button>
        <button class="cb-sug-btn" data-q="Comment fonctionne la fidélité client ?">🎁 Fidélité</button>
        <button class="cb-sug-btn" data-q="Comment gérer mes dettes et échéances ?">📋 Dettes</button>
        <button class="cb-sug-btn" data-q="J'ai un problème technique">🛠 Problème</button>
      </div>
      <div class="cb-input-area">
        <div class="cb-input-wrap">
          <textarea id="cb-input" class="cb-input" placeholder="Posez votre question..." rows="1"></textarea>
          <button id="cb-send" class="cb-send" disabled>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
        </div>
        <div class="cb-footer">Propulsé par <strong>ALTEORE</strong> · <a href="aide.html">Centre d'aide</a></div>
      </div>
    </div>
  `;
  document.body.appendChild(container);

  // ══════════════════════════════════
  //  3. BASE DE CONNAISSANCES
  // ══════════════════════════════════
  const SYSTEM_PROMPT = `Tu es l'assistant virtuel officiel d'ALTEORE, un logiciel SaaS de gestion pour commerçants, artisans et TPE/PME en France.
Tu t'appelles "Assistant ALTEORE". Tu es professionnel, chaleureux et pédagogue. Tu réponds TOUJOURS en français.

## LE LOGICIEL ALTEORE

ALTEORE est un logiciel de gestion tout-en-un destiné aux petits commerçants, artisans, agences, cabinets de conseil et distributeurs en France. Accessible en ligne à https://alteore.com.

### MODULES PRINCIPAUX

1. **TABLEAU DE BORD** — Vue globale : CA du mois, charges, trésorerie, graphiques mensuels/annuels, météo locale, indicateurs clés (CA HT, marge brute, résultat net).

2. **SUIVI DU CA** — Saisie quotidienne avec 3 taux de TVA (5.5%, 10%, 20%). Calendrier interactif, graphiques de progression, comparaison mois/année.

3. **COÛT DE REVIENT** — Fiche produit complète : ingrédients, main d'œuvre, emballages, livraison, charges fixes. Calcul auto du coût par unité, suggestion de prix. Import Google Sheets.

4. **MARGE BRUTE & NETTE**
   - Marge brute = Prix vente HT − Coûts variables (MP + MO + Emballages + Livraison)
   - Taux de marge brute = Marge brute / PV × 100
   - Marge nette = Marge brute − Charges fixes imputées
   - Clé de répartition (4 méthodes) : Temps, Superficie, Volume, CA
   - Simulateur de scénarios (PV, coûts, charges, volume)
   - Codes couleur : Vert (bon), Orange (moyen), Rouge (mauvais)

5. **PILOTAGE FINANCIER** — Récap mensuel, charges fixes/variables, TVA collectée/déductible, crédits, leasings, année fiscale configurable.

6. **PANIER MOYEN** — Calcul par jour/semaine/mois, analyse par catégorie, tendances.

7. **GESTION DES DETTES** — Créanciers, échéancier, suivi remboursements (capital + intérêts), montant restant dû.

8. **FIDÉLISATION CLIENT** (plan Max+) — Cartes fidélité digitales, QR code, points/récompenses, SMS promotionnels.

9. **RECRUTEMENT / RH** (plan Master) — Pipeline Kanban, fiches candidat, suivi entretiens.

### ABONNEMENTS
| Plan | Mensuel | Annuel |
|------|---------|--------|
| Gratuit | 0€ | 0€ |
| Essai | 0€ × 15j | — |
| Pro | 69€/mois | 55€/mois |
| Max | 99€/mois | 79€/mois |
| Master | 169€/mois | 135€/mois |

### CONCEPTS FINANCIERS À EXPLIQUER

**Marge brute** : Ce qui reste après les coûts directs de production. Mesure la rentabilité par produit avant charges de structure. Exemple : gâteau vendu 15€ HT, coûts 7.50€ → marge brute 7.50€ (50%).

**Marge nette** : Ce qui reste après AUSSI les charges fixes. Le vrai bénéfice par produit.

**Clé de répartition** : Méthode pour distribuer les charges fixes (loyer, assurance...) entre les produits. Exemple : produit = 30% du temps de production → supporte 30% des charges fixes.

**Coût de revient** : Coût total pour produire 1 unité (MP + MO + emballages + livraison + quote-part charges fixes).

**TVA** : 5.5% (alimentation base), 10% (restauration, travaux), 20% (taux normal). ALTEORE gère les 3 séparément.

**Seuil de rentabilité** : Niveau de ventes où les revenus couvrent tous les coûts.

## RÈGLES
1. TOUJOURS répondre en français
2. Être concis mais complet, pas de pavés
3. Utiliser des exemples concrets pour les concepts financiers
4. Si problème technique → proposer d'ouvrir un ticket
5. Si tu ne sais pas → le dire honnêtement, proposer le support
6. Renvoyer vers aide.html quand pertinent
7. Ne JAMAIS inventer de fonctionnalités inexistantes
8. Pour les prix → renvoyer vers pricing.html
9. Émojis avec parcimonie
10. Pas de conseils fiscaux/comptables précis → recommander un expert-comptable`;

  // ══════════════════════════════════
  //  4. LOGIQUE CHATBOT
  // ══════════════════════════════════
  let chatOpen = false;
  let chatHistory = [];
  let chatLoading = false;

  // Refs DOM
  const fab = document.getElementById('chat-fab');
  const win = document.getElementById('cb-window');
  const msgContainer = document.getElementById('cb-messages');
  const input = document.getElementById('cb-input');
  const sendBtn = document.getElementById('cb-send');
  const notif = document.getElementById('cb-notif');
  const suggestions = document.getElementById('cb-suggestions');

  // Events
  fab.addEventListener('click', toggleChat);
  document.getElementById('cb-close-btn').addEventListener('click', toggleChat);
  document.getElementById('cb-clear-btn').addEventListener('click', clearChat);
  sendBtn.addEventListener('click', sendMessage);

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  input.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 100) + 'px';
    sendBtn.disabled = !this.value.trim();
  });

  // Suggestions
  suggestions.querySelectorAll('.cb-sug-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      input.value = this.getAttribute('data-q');
      sendMessage();
    });
  });

  function toggleChat() {
    chatOpen = !chatOpen;
    if (chatOpen) {
      win.classList.add('open');
      fab.classList.add('open');
      notif.style.display = 'none';
      setTimeout(function () { input.focus(); }, 300);
      if (chatHistory.length === 0) showWelcome();
    } else {
      win.classList.remove('open');
      fab.classList.remove('open');
    }
  }

  function showWelcome() {
    var userName = '';
    try { userName = document.getElementById('uname')?.textContent || ''; } catch (e) {}
    var greeting = userName ? 'Bonjour ' + userName + ' ! 👋' : 'Bonjour ! 👋';
    addBotMsg(greeting + '\n\nJe suis l\'assistant ALTEORE. Je peux vous aider à :\n\n• **Comprendre** les fonctionnalités du logiciel\n• **Expliquer** des concepts (marge, coût de revient...)\n• **Résoudre** un problème technique\n• **Ouvrir un ticket** de support\n\nComment puis-je vous aider ?');
  }

  function addBotMsg(text) {
    chatHistory.push({ role: 'assistant', content: text, time: new Date() });
    render();
  }

  function addUserMsg(text) {
    chatHistory.push({ role: 'user', content: text, time: new Date() });
    render();
  }

  function render() {
    msgContainer.innerHTML = chatHistory.map(function (m) {
      var isBot = m.role === 'assistant';
      var t = m.time ? new Date(m.time).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
      var html = isBot ? fmtBot(m.content) : esc(m.content);
      return '<div class="cb-msg ' + (isBot ? 'bot' : 'user') + '">' +
        '<div class="cb-bubble">' + html + '</div>' +
        '<div class="cb-time">' + (isBot ? '🤖 Assistant' : 'Vous') + ' · ' + t + '</div></div>';
    }).join('');
    msgContainer.scrollTop = msgContainer.scrollHeight;
  }

  function showTyping() {
    var el = document.createElement('div');
    el.id = 'cb-typing';
    el.className = 'cb-typing';
    el.innerHTML = '<div class="cb-dots"><div class="cb-dot"></div><div class="cb-dot"></div><div class="cb-dot"></div></div>';
    msgContainer.appendChild(el);
    msgContainer.scrollTop = msgContainer.scrollHeight;
  }

  function hideTyping() {
    var el = document.getElementById('cb-typing');
    if (el) el.remove();
  }

  function fmtBot(text) {
    var h = esc(text);
    h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    h = h.replace(/^• (.+)$/gm, '<li>$1</li>');
    h = h.replace(/(<li>[\s\S]*?<\/li>)/, '<ul>$1</ul>');
    h = h.replace(/\n/g, '<br>');
    h = h.replace(/<br><ul>/g, '<ul>').replace(/<\/ul><br>/g, '</ul>');
    return h;
  }

  function esc(text) {
    var d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  // ── ENVOI MESSAGE ──
  async function sendMessage() {
    var text = input.value.trim();
    if (!text || chatLoading) return;

    addUserMsg(text);
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;
    suggestions.style.display = 'none';

    chatLoading = true;
    showTyping();

    try {
      // Détection ticket
      if (isTicketReq(text)) {
        hideTyping();
        chatLoading = false;
        showTicketForm();
        return;
      }

      var response = await callAPI(text);
      hideTyping();
      addBotMsg(response);
    } catch (err) {
      hideTyping();
      console.error('Chatbot error:', err);
      addBotMsg("Désolé, je rencontre un problème technique. Vous pouvez contacter le support à support@alteore.com ou réessayer dans quelques instants.");
    }
    chatLoading = false;
  }

  function isTicketReq(text) {
    var kw = ['ticket', 'signaler', 'bug', 'problème technique', 'erreur', 'ça marche pas', 'ne fonctionne pas', 'ouvrir un ticket', 'contacter le support', 'support technique', 'bloqué', 'page blanche', 'impossible de'];
    var t = text.toLowerCase();
    return kw.some(function (k) { return t.includes(k); });
  }

  function showTicketForm() {
    addBotMsg('Je comprends que vous rencontrez un souci. Remplissez ce formulaire et notre équipe vous recontactera rapidement :\n\n<div class="cb-ticket" id="cb-ticket-form"><label>Sujet du problème *</label><select id="cb-tk-type"><option value="">— Choisir —</option><option value="bug">🐛 Bug / Erreur technique</option><option value="question">❓ Question fonctionnalité</option><option value="suggestion">💡 Suggestion</option><option value="billing">💳 Facturation</option><option value="other">📝 Autre</option></select><label>Décrivez votre problème *</label><textarea id="cb-tk-desc" rows="3" placeholder="Décrivez ce qui se passe..."></textarea><label>Votre email (optionnel)</label><input type="email" id="cb-tk-email" placeholder="nom@exemple.com"/><button class="cb-ticket-btn" id="cb-tk-submit">📨 Envoyer le ticket</button></div>');

    // Attacher l'event après injection
    setTimeout(function () {
      var btn = document.getElementById('cb-tk-submit');
      if (btn) btn.addEventListener('click', submitTicket);
    }, 100);
  }

  async function submitTicket() {
    var type = document.getElementById('cb-tk-type')?.value;
    var desc = document.getElementById('cb-tk-desc')?.value?.trim();
    var email = document.getElementById('cb-tk-email')?.value?.trim();

    if (!type || !desc) { alert('Veuillez remplir le sujet et la description.'); return; }

    try {
      if (window._uid && window._db && window._setDoc && window._doc) {
        var ticketId = 'ticket_' + Date.now();
        await window._setDoc(window._doc(window._db, 'tickets', window._uid, 'list', ticketId), {
          type: type, description: desc, email: email || '',
          page: window.location.pathname,
          userAgent: navigator.userAgent,
          createdAt: new Date().toISOString(),
          status: 'open'
        });
      }
    } catch (e) { console.warn('Ticket save error:', e); }

    var form = document.getElementById('cb-ticket-form');
    if (form) form.remove();

    addBotMsg('✅ **Ticket envoyé avec succès !**\n\nNotre équipe a bien reçu votre demande et vous recontactera dans les plus brefs délais.\n\nEn attendant, consultez notre [Centre d\'aide](aide.html) pour des réponses rapides.\n\nAutre chose que je puisse faire pour vous ?');
  }

  // ── APPEL API ──
  async function callAPI(userMessage) {
    var hist = chatHistory
      .filter(function (m) { return m.role === 'user' || m.role === 'assistant'; })
      .slice(-10)
      .map(function (m) { return { role: m.role, content: m.content }; });

    // Retirer le dernier user (envoyé séparément)
    if (hist.length > 0 && hist[hist.length - 1].role === 'user') hist.pop();

    var messages = hist.concat([{ role: 'user', content: userMessage }]);

    try {
      var res = await fetch('/api/chatbot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: messages, system: SYSTEM_PROMPT, uid: window._uid || null })
      });
      if (!res.ok) throw new Error('API ' + res.status);
      var data = await res.json();
      return data.response || "Je n'ai pas pu traiter votre demande. Réessayez.";
    } catch (err) {
      console.error('API call failed:', err);
      return fallback(userMessage);
    }
  }

  // ── FALLBACK LOCAL ──
  function fallback(text) {
    var t = text.toLowerCase();

    if (t.includes('marge brute'))
      return "La **marge brute** = Prix de vente HT − Coûts variables (matières premières + main d'œuvre + emballages + livraison).\n\nExemple : gâteau vendu 15€ HT, coûts 7,50€ → marge brute = **7,50€** (50%).\n\nAnalysez vos marges dans le module **Marge brute & nette**.";

    if (t.includes('marge nette'))
      return "La **marge nette** = Marge brute − Charges fixes imputées.\n\nC'est votre vrai bénéfice par produit. Configurez la clé de répartition dans **Marge brute & nette** pour la calculer.";

    if (t.includes('clé de répartition') || t.includes('cle'))
      return "La **clé de répartition** distribue vos charges fixes entre vos produits. 4 méthodes :\n\n• **Temps** : heures de production\n• **Superficie** : m² utilisés\n• **Volume** : unités produites\n• **CA** : chiffre d'affaires\n\nChoisissez la plus pertinente pour votre activité.";

    if (t.includes('prix') || t.includes('tarif') || t.includes('abonnement'))
      return "ALTEORE propose 3 formules :\n\n• **Pro** : 69€/mois (55€ en annuel)\n• **Max** : 99€/mois (79€ en annuel)\n• **Master** : 169€/mois (135€ en annuel)\n\n**15 jours d'essai gratuit** inclus. Détails sur [pricing.html](pricing.html).";

    if (t.includes('ca') || t.includes('chiffre d'))
      return "Pour saisir votre CA :\n\n1. Allez dans **Suivi du CA**\n2. Cliquez sur un jour du calendrier\n3. Saisissez les montants HT par taux de TVA (5,5%, 10%, 20%)\n4. Le total se calcule automatiquement";

    if (t.includes('fidéli') || t.includes('fideli'))
      return "Le module **Fidélisation** (plan Max+) permet de créer des cartes fidélité digitales avec QR code, attribuer des points, définir des récompenses et envoyer des SMS promotionnels.";

    if (t.includes('dette'))
      return "Le module **Dettes** vous permet de lister vos créanciers, suivre les échéances, le capital restant dû et la progression de vos remboursements.";

    if (t.includes('coût de revient') || t.includes('cout'))
      return "Le **Coût de revient** calcule combien coûte la production d'1 unité : matières premières + main d'œuvre + emballages + livraison + quote-part charges fixes. Créez vos fiches dans le module **Coût de revient**.";

    if (t.includes('bonjour') || t.includes('salut') || t.includes('hello'))
      return "Bonjour ! 👋 Comment puis-je vous aider ?";

    if (t.includes('merci'))
      return "Je vous en prie ! 😊 N'hésitez pas si vous avez d'autres questions.";

    return "Pour une réponse plus précise :\n\n• Consultez notre [Centre d'aide](aide.html)\n• Reformulez avec plus de détails\n• Dites \"j'ai un problème technique\" pour ouvrir un ticket\n\nComment puis-je vous aider autrement ?";
  }

  // ── CLEAR ──
  function clearChat() {
    chatHistory = [];
    msgContainer.innerHTML = '';
    suggestions.style.display = 'flex';
    showWelcome();
  }

  // ── NOTIF AUTO (30s) ──
  setTimeout(function () {
    if (!chatOpen && chatHistory.length === 0) {
      notif.style.display = 'flex';
    }
  }, 30000);

})();
