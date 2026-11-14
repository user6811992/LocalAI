#!/usr/bin/env bash
# Build a macOS .dmg installer for AegisAI.
# Run on macOS: bash installer/build-dmg.sh
# Prerequisites: create-dmg (brew install create-dmg), Node.js
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PKG_VERSION=$(node -e "console.log(require('./package.json').version)")
echo "Building AegisAI .dmg v$PKG_VERSION"

APP_NAME="AegisAI"
APP_DIR="$ROOT/installer/AegisAI.app"
DMG_OUT="$ROOT/installer/output/AegisAI-$PKG_VERSION.dmg"

# 1. Create the .app bundle structure
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"
mkdir -p "$APP_DIR/Contents/Resources/app"

# 2. Copy application files (excluding dev/build artifacts)
rsync -a --exclude='node_modules' --exclude='.git' --exclude='*.log' \
  --exclude='repos' --exclude='tools' --exclude='workspace' \
  --exclude='.update-backup' --exclude='data' \
  "$ROOT/" "$APP_DIR/Contents/Resources/app/"

# 3. Bundle a portable universal Node.js runtime (x64 + arm64)
NODE_VER="v20.18.0"
NODE_DIR="$APP_DIR/Contents/Resources/node"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  echo "Downloading portable Node.js ${NODE_VER}..."
  TMP_NODE="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-darwin-x64.tar.gz" -o "$TMP_NODE/node-x64.tar.gz"
  curl -fsSL "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-darwin-arm64.tar.gz" -o "$TMP_NODE/node-arm64.tar.gz"
  mkdir -p "$TMP_NODE/x64" "$TMP_NODE/arm64"
  tar -xzf "$TMP_NODE/node-x64.tar.gz" -C "$TMP_NODE/x64" --strip-components=1
  tar -xzf "$TMP_NODE/node-arm64.tar.gz" -C "$TMP_NODE/arm64" --strip-components=1
  mkdir -p "$NODE_DIR/bin" "$NODE_DIR/lib"
  cp -a "$TMP_NODE/arm64/bin/." "$NODE_DIR/bin/"
  cp -a "$TMP_NODE/arm64/lib/." "$NODE_DIR/lib/"
  lipo -create "$TMP_NODE/x64/bin/node" "$TMP_NODE/arm64/bin/node" -output "$NODE_DIR/bin/node"
  chmod +x "$NODE_DIR/bin/node"
  rm -rf "$TMP_NODE"
  echo "Bundled universal Node.js ${NODE_VER}"
fi

# 4. Create the launcher script
cat > "$APP_DIR/Contents/MacOS/AegisAI" <<'LAUNCHER'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$DIR/../Resources/app"
NODE="$DIR/../Resources/node/bin/node"
[ -x "$NODE" ] || NODE="node"
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
if ! pgrep -x "ollama" >/dev/null 2>&1; then
  if command -v ollama >/dev/null 2>&1; then
    ollama serve &>/dev/null &
    sleep 3
  fi
fi
# Start the server if not running
if ! (curl -s http://127.0.0.1:8080/api/version >/dev/null 2>&1); then
  "$NODE" server.js &>/dev/null &
  sleep 3
fi
# Open the browser
open "http://127.0.0.1:8080"
LAUNCHER
chmod +x "$APP_DIR/Contents/MacOS/AegisAI"

# 4b. Default backend config (edit this file to use a non-Ollama backend)
printf 'BACKEND_TYPE=ollama\nBACKEND_URL=http://127.0.0.1:11434\n' > "$APP_DIR/Contents/Resources/app/backend.txt"

# 5. Info.plist
cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>AegisAI</string>
  <key>CFBundleDisplayName</key><string>AegisAI</string>
  <key>CFBundleIdentifier</key><string>com.aegisai.app</string>
  <key>CFBundleVersion</key><string>$PKG_VERSION</string>
  <key>CFBundleShortVersionString</key><string>$PKG_VERSION</string>
  <key>CFBundleExecutable</key><string>AegisAI</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# 6. Create the app icon (icon.icns) from the SVG
if [ -f "$ROOT/public/icon.icns" ]; then
  cp "$ROOT/public/icon.icns" "$APP_DIR/Contents/Resources/icon.icns"
elif [ -f "$ROOT/public/icon.svg" ] && command -v iconutil >/dev/null 2>&1 && command -v sips >/dev/null 2>&1; then
  ICONSET="$APP_DIR/Contents/Resources/icon.iconset"
  mkdir -p "$ICONSET"
  if sips -z 1024 1024 "$ROOT/public/icon.svg" --out "$ICONSET/icon_512x512@2x.png" >/dev/null 2>&1; then
    for size in 16 32 128 256 512; do
      sips -z "$size" "$size" "$ICONSET/icon_512x512@2x.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null 2>&1 || true
      dsize=$((size * 2))
      sips -z "$dsize" "$dsize" "$ICONSET/icon_512x512@2x.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null 2>&1 || true
    done
    iconutil -c icns "$ICONSET" -o "$APP_DIR/Contents/Resources/icon.icns" 2>/dev/null || true
  fi
  rm -rf "$ICONSET"
fi

# 7. Run npm install in the bundled app
cd "$APP_DIR/Contents/Resources/app"
if [ -x "$NODE_DIR/bin/node" ]; then
  "$NODE_DIR/bin/node" "$NODE_DIR/lib/node_modules/npm/bin/npm-cli.js" install --production 2>&1 | tail -5
else
  npm install --production 2>&1 | tail -5
fi
cd "$ROOT"

# 8. Build the .dmg
mkdir -p installer/output
if command -v create-dmg >/dev/null 2>&1; then
  create-dmg \
    --volname "AegisAI" \
    --window-pos 200 120 \
    --window-size 600 400 \
    --icon-size 100 \
    --icon "AegisAI.app" 150 190 \
    --app-drop-link 450 190 \
    "$DMG_OUT" \
    "$APP_DIR"
else
  echo "create-dmg not found. Creating basic .dmg with hdiutil..."
  hdiutil create -volname "AegisAI" -srcfolder "$APP_DIR" -ov -format UDZO "$DMG_OUT"
fi

echo "Build complete: $DMG_OUT"