#!/usr/bin/env bash
# Build a Linux AppImage for AegisAI.
# Run on Linux: bash installer/build-appimage.sh
# Prerequisites: appimagetool (https://github.com/AppImage/AppImageKit/releases), Node.js, npm
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PKG_VERSION=$(node -e "console.log(require('./package.json').version)")
echo "Building AegisAI AppImage v$PKG_VERSION"

APPDIR="$ROOT/installer/AegisAI.AppDir"
APPIMAGE_OUT="$ROOT/installer/output/AegisAI-$PKG_VERSION-x86_64.AppImage"

# 1. Clean and create AppDir structure
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin"
mkdir -p "$APPDIR/usr/lib/aegisai"
mkdir -p "$APPDIR/usr/share/applications"
mkdir -p "$APPDIR/usr/share/icons/hicolor/256x256/apps"

# 2. Copy application files
rsync -a --exclude='node_modules' --exclude='.git' --exclude='*.log' \
  --exclude='repos' --exclude='tools' --exclude='workspace' \
  --exclude='.update-backup' --exclude='data' \
  "$ROOT/" "$APPDIR/usr/lib/aegisai/"

# 3. Bundle a portable Node.js runtime (linux-x64)
NODE_VER="v20.18.0"
NODE_BIN="$APPDIR/usr/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  echo "Downloading portable Node.js ${NODE_VER}..."
  TMP_NODE="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-x64.tar.gz" -o "$TMP_NODE/node.tar.gz"
  tar -xzf "$TMP_NODE/node.tar.gz" -C "$TMP_NODE" --strip-components=1
  cp "$TMP_NODE/bin/node" "$NODE_BIN"
  chmod +x "$NODE_BIN"
  mkdir -p "$APPDIR/usr/lib/node_modules"
  cp -a "$TMP_NODE/lib/node_modules/." "$APPDIR/usr/lib/node_modules/"
  rm -rf "$TMP_NODE"
  echo "Bundled Node.js ${NODE_VER}"
fi

# 4. Create the AppRun launcher
cat > "$APPDIR/AppRun" <<'APPRUN'
#!/bin/bash
HERE="$(dirname "$(readlink -f "${0}")")"
export PATH="$HERE/usr/bin:$PATH"
APP_ROOT="$HERE/usr/lib/aegisai"
cd "$APP_ROOT"
# Backend selection (from backend.txt in the app root)
if [ -f "$APP_ROOT/backend.txt" ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      BACKEND_TYPE) export BACKEND_TYPE="$value" ;;
      BACKEND_URL) export BACKEND_URL="$value" ;;
    esac
  done < "$APP_ROOT/backend.txt"
fi
# Start Ollama if not running
if ! (curl -s http://127.0.0.1:11434/api/version >/dev/null 2>&1); then
  if command -v ollama >/dev/null 2>&1; then
    ollama serve &>/dev/null &
    sleep 3
  fi
fi
# Start the server if not running
if ! (curl -s http://127.0.0.1:8080/api/version >/dev/null 2>&1); then
  node server.js &>/dev/null &
  sleep 3
fi
# Open browser
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://127.0.0.1:8080"
elif command -v sensible-browser >/dev/null 2>&1; then
  sensible-browser "http://127.0.0.1:8080"
fi
# Keep running
wait
APPRUN
chmod +x "$APPDIR/AppRun"

# 5. Desktop entry
cat > "$APPDIR/usr/share/applications/aegisai.desktop" <<DESKTOP
[Desktop Entry]
Name=AegisAI
Exec=AppRun
Icon=aegisai
Type=Application
Categories=Development;Utility;
Comment=Local AI web UI with Ollama backend
Terminal=false
DESKTOP
cp "$APPDIR/usr/share/applications/aegisai.desktop" "$APPDIR/aegisai.desktop"

# 6. Icon (use a placeholder if icon.ico exists, convert if possible)
if [ -f "$ROOT/public/icon.ico" ] && command -v convert >/dev/null 2>&1; then
  convert "$ROOT/public/icon.ico" "$APPDIR/usr/share/icons/hicolor/256x256/apps/aegisai.png"
  cp "$APPDIR/usr/share/icons/hicolor/256x256/apps/aegisai.png" "$APPDIR/aegisai.png"
elif [ -f "$ROOT/public/icon.svg" ]; then
  cp "$ROOT/public/icon.svg" "$APPDIR/aegisai.svg" 2>/dev/null || true
fi

# 7. Run npm install in the bundled app
cd "$APPDIR/usr/lib/aegisai"
if [ -x "$APPDIR/usr/bin/node" ]; then
  "$APPDIR/usr/bin/node" "$APPDIR/usr/lib/node_modules/npm/bin/npm-cli.js" install --production 2>&1 | tail -5
else
  npm install --production 2>&1 | tail -5
fi
# Default backend config (edit this file to use a non-Ollama backend)
printf 'BACKEND_TYPE=ollama\nBACKEND_URL=http://127.0.0.1:11434\n' > "$APPDIR/usr/lib/aegisai/backend.txt"
cd "$ROOT"

# 8. Build the AppImage
mkdir -p installer/output
if command -v appimagetool >/dev/null 2>&1; then
  ARCH=x86_64 appimagetool --appimage-extract-and-run "$APPDIR" "$APPIMAGE_OUT"
else
  echo "appimagetool not found. Install from https://github.com/AppImage/AppImageKit/releases"
  echo "AppDir prepared at: $APPDIR"
  exit 1
fi

echo "Build complete: $APPIMAGE_OUT"