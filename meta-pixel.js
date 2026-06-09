/* ============================================================
   ALTEORE — Meta Pixel (navigateur) + envoi CAPI dédupliqué
   Un seul fichier = une seule source de vérité pour l'ID pixel.
   Inclus via <script src="/meta-pixel.js"></script> dans le <head>.
   ============================================================ */
(function () {
  // ⚠️ Vérifie que c'est bien l'ID affiché comme "jeu de données / pixel" dans Events Manager
  var PIXEL_ID = '2069940677253298';

  /* --- 1. Snippet officiel Meta (charge fbevents.js + init) --- */
  !(function (f, b, e, v, n, t, s) {
    if (f.fbq) return;
    n = f.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    };
    if (!f._fbq) f._fbq = n;
    n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
    t = b.createElement(e); t.async = !0; t.src = v;
    s = b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t, s);
  })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

  fbq('init', PIXEL_ID);

  /* --- 2. PageView navigateur AVEC un eventID partagé pour la dédup --- */
  var eventId =
    (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'pv-' + Date.now() + '-' + Math.random().toString(36).slice(2);

  fbq('track', 'PageView', {}, { eventID: eventId });

  /* --- 3. Même PageView envoyé en CAPI (serveur) avec le même eventID --- */
  function getCookie(name) {
    var m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return m ? m.pop() : '';
  }

  // fbq pose le cookie _fbp de façon asynchrone → on laisse ~300ms avant de lire
  setTimeout(function () {
    var fbp = getCookie('_fbp');
    var fbc = getCookie('_fbc');

    // Si pas de _fbc mais un fbclid dans l'URL, on le reconstruit au format attendu
    if (!fbc) {
      var p = new URLSearchParams(location.search).get('fbclid');
      if (p) fbc = 'fb.1.' + Date.now() + '.' + p;
    }

    fetch('/api/meta-capi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        event_name: 'PageView',
        event_id: eventId,
        event_source_url: location.href,
        fbp: fbp,
        fbc: fbc
      })
    }).catch(function () { /* silencieux : la couche navigateur suffit en secours */ });
  }, 300);
})();
