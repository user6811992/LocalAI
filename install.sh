#!/usr/bin/env bash
# AegisAI installer (bash) - Linux / macOS
# Usage: bash install.sh
set -e

# ---------- helpers ----------
say() { echo ""; echo "==> $*"; }
ask() {
  # Read from /dev/tty if available (works even when piped), fall back to stdin
  if [ -t 0 ]; then
    read -r -p "$1 [y/N]: " ans
  elif [ -r /dev/tty ]; then
    read -r -p "$1 [y/N]: " ans < /dev/tty
  else
    # Non-interactive: check env var (e.g., AEGIS_YES=1) or default to N
    if [ "${AEGIS_YES:-}" = "1" ] || [ "${AEGIS_YES:-}" = "yes" ]; then
      ans="y"
    else
      ans="n"
    fi
  fi
  case "$ans" in [yY]|[yY][eE][sS]) return 0;; *) return 1;; esac
}

OS="$(uname -s)"
ARCH="$(uname -m)"

say "Welcome to the AegisAI installer."
echo "Detected OS: $OS ($ARCH)"

# ---------- source folder ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -f "$SCRIPT_DIR/server.js" ]; then
  echo "ERROR: server.js not found next to this installer. Keep install.sh in the AegisAI folder."
  exit 1
fi

# ---------- choose install location ----------
DEFAULT_DEST="$HOME/AegisAI"
if [ -t 0 ]; then
  read -r -p "Install location [$DEFAULT_DEST]: " DEST
elif [ -r /dev/tty ]; then
  read -r -p "Install location [$DEFAULT_DEST]: " DEST < /dev/tty
else
  DEST=""
fi
DEST="${DEST:-$DEFAULT_DEST}"
if [ ! -d "$DEST" ]; then
  mkdir -p "$DEST"
fi
# If user picked a parent, append AegisAI unless server.js already there
if [ ! -f "$DEST/server.js" ]; then
  DEST="$DEST/AegisAI"
  mkdir -p "$DEST"
fi
echo "Installing to: $DEST"

# ---------- copy app files ----------
if [ "$DEST" != "$SCRIPT_DIR" ]; then
  echo "Copying application files..."
  # copy everything except node_modules and .git
  rsync -a --exclude='node_modules' --exclude='.git' --exclude='*.log' "$SCRIPT_DIR/" "$DEST/" 2>/dev/null || {
    # fallback without rsync
    cp -r "$SCRIPT_DIR"/* "$DEST/" 2>/dev/null || true
  }
fi

# ---------- prerequisites ----------
say "Checking prerequisites"
NODE_OK=0; OLLAMA_OK=0
if command -v node >/dev/null 2>&1; then NODE_OK=1; echo "  Node.js: found ($(node --version))"; else echo "  Node.js: MISSING"; fi
if command -v ollama >/dev/null 2>&1; then OLLAMA_OK=1; echo "  Ollama: found"; else echo "  Ollama: MISSING"; fi

if [ "$NODE_OK" -eq 0 ]; then
  echo ""
  echo "Node.js is required. Install from https://nodejs.org then re-run."
  if [ "$OS" = "Darwin" ]; then echo "  macOS: brew install node"; fi
  if [ "$OS" = "Linux" ]; then echo "  Linux: sudo apt install nodejs npm  (or use nvm)"; fi
fi
if [ "$OLLAMA_OK" -eq 0 ]; then
  echo ""
  echo "Ollama is required. Install from https://ollama.com/download then re-run."
  if [ "$OS" = "Darwin" ]; then echo "  macOS: brew install ollama"; fi
  if [ "$OS" = "Linux" ]; then echo "  Linux: curl -fsSL https://ollama.com/install.sh | sh"; fi
fi

# npm install
if [ -f "$DEST/package.json" ]; then
  echo "Installing npm dependencies..."
  (cd "$DEST" && npm install) || echo "npm install failed; run manually in $DEST"
fi

# ---------- recommended models ----------
MODELS=("llama3.2:3b" "llama3.2:1b" "qwen2.5:14b" "qwen2.5-coder:14b" "mistral:7b" "phi3:mini" "gemma2:9b" "deepseek-coder:6.7b" "nomic-embed-text" "moondream")
if [ "$OLLAMA_OK" -eq 1 ]; then
  if ask "Pull all recommended AI models now? (~38 GB, may take a while)"; then
    for m in "${MODELS[@]}"; do
      echo "Pulling $m..."
      ollama pull "$m" || echo "Failed to pull $m (continuing)"
    done
    echo "Model pull complete."
  fi
fi

# ---------- desktop shortcut ----------
create_desktop_shortcut() {
  if [ "$OS" = "Linux" ]; then
    DESKTOP_DIR="$HOME/Desktop"
    [ -d "$DESKTOP_DIR" ] || DESKTOP_DIR="$HOME"
    cat > "$DESKTOP_DIR/AegisAI.desktop" <<EOF
[Desktop Entry]
Name=AegisAI
Comment=Local AI web UI
Exec=bash -c 'cd "$DEST" && node server.js & sleep 3 && (command -v xdg-open >/dev/null && xdg-open http://127.0.0.1:8080 || open http://127.0.0.1:8080)'
Type=Application
Terminal=false
Icon=utilities-terminal
Categories=Development;
EOF
    chmod +x "$DESKTOP_DIR/AegisAI.desktop"
    # Also register in applications menu
    mkdir -p "$HOME/.local/share/applications"
    cp "$DESKTOP_DIR/AegisAI.desktop" "$HOME/.local/share/applications/AegisAI.desktop"
    echo "Desktop shortcut created: $DESKTOP_DIR/AegisAI.desktop"
  elif [ "$OS" = "Darwin" ]; then
    # macOS: create a small launcher script + .command for double-click
    LAUNCHER="$DEST/launch.command"
    cat > "$LAUNCHER" <<EOF
#!/bin/bash
cd "$DEST"
node server.js &
sleep 3
open http://127.0.0.1:8080
EOF
    chmod +x "$LAUNCHER"
    # Symlink on Desktop
    ln -sf "$LAUNCHER" "$HOME/Desktop/AegisAI.command"
    echo "Desktop shortcut created: $HOME/Desktop/AegisAI.command"
  fi
}

if ask "Create a desktop shortcut for AegisAI?"; then
  create_desktop_shortcut
fi

# ---------- auto-start (Linux systemd / macOS launchd) ----------
if ask "Start AegisAI automatically at login?"; then
  if [ "$OS" = "Linux" ]; then
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/localai.service" <<EOF
[Unit]
Description=AegisAI web UI
After=network.target

[Service]
Type=simple
WorkingDirectory=$DEST
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user enable localai 2>/dev/null || true
    echo "systemd user service created. Start with: systemctl --user start localai"
  elif [ "$OS" = "Darwin" ]; then
    PLIST="$HOME/Library/LaunchAgents/com.localai.plist"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.localai</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DEST</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
EOF
    launchctl load "$PLIST" 2>/dev/null || true
    echo "launchd agent created: $PLIST"
  fi
fi

# ---------- launch now ----------
if ask "Launch AegisAI now?"; then
  (cd "$DEST" && node server.js &) 
  sleep 3
  if [ "$OS" = "Darwin" ]; then open "http://127.0.0.1:8080"; else (command -v xdg-open >/dev/null && xdg-open "http://127.0.0.1:8080" &) || echo "Open http://127.0.0.1:8080 in your browser"; fi
fi

say "Installation complete."
echo "Installed to: $DEST"
echo "Run manually: cd $DEST && node server.js"
echo "Then open http://127.0.0.1:8080"