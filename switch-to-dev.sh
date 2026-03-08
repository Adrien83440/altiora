#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# switch-to-dev.sh — Bascule toute la branche dev vers Firebase DEV
#
# Usage:
#   ./switch-to-dev.sh \
#     --api-key "AIzaSy..." \
#     --auth-domain "alteore-dev.firebaseapp.com" \
#     --project-id "alteore-dev" \
#     --storage-bucket "alteore-dev.firebasestorage.app" \
#     --sender-id "123456789" \
#     --app-id "1:123456789:web:abcdef"
# ═══════════════════════════════════════════════════════════════

set -euo pipefail
# Avoid (( expr )) returning 1 when result is 0
inc() { eval "$1=\$(( $1 + 1 ))"; }

# ── PROD values (ce qu'on remplace) ──
PROD_API_KEY="AIzaSyB003WqdRKrT0gbv7P4BNIICuXeqbu8dR4"
PROD_AUTH_DOMAIN="altiora-70599.firebaseapp.com"
PROD_PROJECT_ID="altiora-70599"
PROD_STORAGE_BUCKET="altiora-70599.firebasestorage.app"
PROD_SENDER_ID="120905555746"
PROD_APP_ID="1:120905555746:web:618460c65cdc9e57cc8f7b"

# ── Parse arguments ──
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --api-key) DEV_API_KEY="$2"; shift ;;
    --auth-domain) DEV_AUTH_DOMAIN="$2"; shift ;;
    --project-id) DEV_PROJECT_ID="$2"; shift ;;
    --storage-bucket) DEV_STORAGE_BUCKET="$2"; shift ;;
    --sender-id) DEV_SENDER_ID="$2"; shift ;;
    --app-id) DEV_APP_ID="$2"; shift ;;
    *) echo "❌ Argument inconnu: $1"; exit 1 ;;
  esac
  shift
done

# ── Validation ──
if [[ -z "$DEV_API_KEY" || -z "$DEV_PROJECT_ID" || -z "$DEV_APP_ID" ]]; then
  echo ""
  echo "❌ Arguments manquants."
  echo ""
  echo "Usage:"
  echo "  ./switch-to-dev.sh \\"
  echo "    --api-key \"AIzaSy...\" \\"
  echo "    --auth-domain \"alteore-dev.firebaseapp.com\" \\"
  echo "    --project-id \"alteore-dev\" \\"
  echo "    --storage-bucket \"alteore-dev.firebasestorage.app\" \\"
  echo "    --sender-id \"123456789\" \\"
  echo "    --app-id \"1:123456789:web:abcdef\""
  echo ""
  exit 1
fi

# Defaults
DEV_AUTH_DOMAIN="${DEV_AUTH_DOMAIN:-${DEV_PROJECT_ID}.firebaseapp.com}"
DEV_STORAGE_BUCKET="${DEV_STORAGE_BUCKET:-${DEV_PROJECT_ID}.firebasestorage.app}"
DEV_SENDER_ID="${DEV_SENDER_ID:-000000000000}"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   ALTEORE — Switch to DEV Firebase              ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "PROD → DEV :"
echo "  projectId:     $PROD_PROJECT_ID → $DEV_PROJECT_ID"
echo "  apiKey:        ${PROD_API_KEY:0:12}... → ${DEV_API_KEY:0:12}..."
echo "  authDomain:    $PROD_AUTH_DOMAIN → $DEV_AUTH_DOMAIN"
echo "  storageBucket: $PROD_STORAGE_BUCKET → $DEV_STORAGE_BUCKET"
echo "  senderId:      $PROD_SENDER_ID → $DEV_SENDER_ID"
echo "  appId:         ${PROD_APP_ID:0:20}... → ${DEV_APP_ID:0:20}..."
echo ""

# ── Compteurs ──
HTML_COUNT=0
API_COUNT=0

# ═══════════════════════════════════════════════════════
# 1. FICHIERS HTML (config client-side initializeApp)
# ═══════════════════════════════════════════════════════
echo "📄 Remplacement dans les fichiers HTML..."

for f in *.html; do
  [[ ! -f "$f" ]] && continue
  if grep -q "$PROD_PROJECT_ID" "$f" 2>/dev/null; then
    sed -i \
      -e "s|$PROD_API_KEY|$DEV_API_KEY|g" \
      -e "s|$PROD_AUTH_DOMAIN|$DEV_AUTH_DOMAIN|g" \
      -e "s|$PROD_PROJECT_ID|$DEV_PROJECT_ID|g" \
      -e "s|$PROD_STORAGE_BUCKET|$DEV_STORAGE_BUCKET|g" \
      -e "s|$PROD_SENDER_ID|$DEV_SENDER_ID|g" \
      -e "s|$PROD_APP_ID|$DEV_APP_ID|g" \
      "$f"
    echo "   ✅ $f"
    inc HTML_COUNT
  fi
done

# ═══════════════════════════════════════════════════════
# 2. FICHIERS API (serverless functions)
# ═══════════════════════════════════════════════════════
echo ""
echo "⚡ Remplacement dans les fichiers API..."

for f in api/*.js; do
  [[ ! -f "$f" ]] && continue
  if grep -q "$PROD_PROJECT_ID" "$f" 2>/dev/null; then
    sed -i \
      -e "s|$PROD_API_KEY|$DEV_API_KEY|g" \
      -e "s|$PROD_PROJECT_ID|$DEV_PROJECT_ID|g" \
      "$f"
    echo "   ✅ $(basename $f)"
    inc API_COUNT
  fi
done

# ═══════════════════════════════════════════════════════
# 3. FICHIERS JS RACINE (nav.js, chatbot.js, etc.)
# ═══════════════════════════════════════════════════════
echo ""
echo "📦 Vérification des JS racine..."

for f in *.js; do
  [[ ! -f "$f" ]] && continue
  if grep -q "$PROD_PROJECT_ID" "$f" 2>/dev/null; then
    sed -i \
      -e "s|$PROD_API_KEY|$DEV_API_KEY|g" \
      -e "s|$PROD_PROJECT_ID|$DEV_PROJECT_ID|g" \
      "$f"
    echo "   ✅ $f"
  fi
done

# ═══════════════════════════════════════════════════════
# 4. VÉRIFICATION FINALE
# ═══════════════════════════════════════════════════════
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 RÉSULTAT"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   HTML modifiés : $HTML_COUNT"
echo "   API modifiés  : $API_COUNT"
echo ""

# Check résiduel
RESIDUAL=$(grep -rl "$PROD_PROJECT_ID" *.html api/*.js *.js 2>/dev/null | wc -l || true)
if [[ "$RESIDUAL" -gt 0 ]]; then
  echo "⚠️  ATTENTION : $RESIDUAL fichier(s) contiennent encore '$PROD_PROJECT_ID' :"
  grep -rl "$PROD_PROJECT_ID" *.html api/*.js *.js 2>/dev/null || true
  echo ""
  echo "   Vérifie manuellement ces fichiers."
else
  echo "✅ Aucune référence résiduelle à '$PROD_PROJECT_ID'"
fi

# Confirmation DEV
DEV_COUNT=$(grep -rl "$DEV_PROJECT_ID" *.html api/*.js 2>/dev/null | wc -l || true)
echo "✅ $DEV_COUNT fichier(s) pointent vers '$DEV_PROJECT_ID'"

echo ""
echo "🎉 Switch terminé ! N'oublie pas :"
echo "   1. Déployer les Firestore rules : firebase use $DEV_PROJECT_ID && firebase deploy --only firestore:rules"
echo "   2. Créer un user test dans Firebase Auth DEV"
echo "   3. Ajouter le document users/{uid} avec plan:'master' dans Firestore DEV"
echo "   4. Commit & push la branche dev"
echo ""
