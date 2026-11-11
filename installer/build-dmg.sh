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

# 3. Bundle Node.js if available
if command -v node >/dev/null 2>&1; then
  NODE_BIN=$(command -v node)
  cp "$NODE_BIN" "$APP_DIR/Contents/MacOS/node"
  chmod +x "$APP_DIR/Contents/MacOS/node"
  echo "Bundled Node.js from $NODE_BIN"
fi

# 4. Create the launcher script
cat > "$APP_DIR/Contents/MacOS/AegisAI" <<'LAUNCHER'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$DIR/../Resources/app"
NODE="$DIR/node"
[ -x "$NODE" ] || NODE="node"
cd "$APP_ROOT"
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

# 6. Copy icon if available
if [ -f "$ROOT/public/icon.ico" ]; then
  echo "Note: convert icon.ico to icon.icns for macOS (use iconutil or sips)"
fi

# 7. Run npm install in the bundled app
cd "$APP_DIR/Contents/Resources/app"
if [ -x "$APP_DIR/Contents/MacOS/node" ]; then
  "$APP_DIR/Contents/MacOS/node" "$APP_DIR/Contents/MacOS/node" --version >/dev/null 2>&1 || true
fi
npm install --production 2>&1 | tail -5
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