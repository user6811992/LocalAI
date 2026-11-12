#!/usr/bin/env bash
# AegisAI uninstaller (bash) - Linux / macOS
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-$SCRIPT_DIR}"
if [ ! -d "$DEST" ]; then
  DEST="$HOME/AegisAI/AegisAI"
fi

echo "Uninstalling AegisAI from: $DEST"

# Stop running server
echo "Stopping any running AegisAI server..."
pkill -f "node.*server.js" 2>/dev/null || true
sleep 2

# Export user data
BACKUP_DIR="$HOME/AegisAI-backup-$(date +%Y%m%d)"
if [ -d "$DEST" ]; then
  mkdir -p "$BACKUP_DIR"
  for f in search-config.json memory.json skills.json chats.json rag-store.json auth.json; do
    if [ -f "$DEST/$f" ]; then cp "$DEST/$f" "$BACKUP_DIR/$f" 2>/dev/null || true; fi
  done
  if [ -d "$DEST/workspace" ]; then cp -r "$DEST/workspace" "$BACKUP_DIR/workspace" 2>/dev/null || true; fi
  echo "User data exported to: $BACKUP_DIR"
fi

# Remove shortcuts
rm -f "$HOME/Desktop/AegisAI.desktop" 2>/dev/null || true
rm -f "$HOME/.local/share/applications/AegisAI.desktop" 2>/dev/null || true
rm -f "$HOME/Desktop/AegisAI.command" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.localai.plist" 2>/dev/null || true

# Remove auto-start
if [ -f "$HOME/.config/systemd/user/localai.service" ]; then
  systemctl --user disable localai 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/localai.service" 2>/dev/null || true
  systemctl --user daemon-reload 2>/dev/null || true
fi

# Remove app files
read -r -p "Remove application files too? [y/N]: " ans
case "$ans" in [yY]|[yY][eE][sS])
  rm -rf "$DEST/node_modules" 2>/dev/null || true
  rm -rf "$DEST/.update-backup" 2>/dev/null || true
  rm -rf "$DEST/data" 2>/dev/null || true
  rm -rf "$DEST" 2>/dev/null || true
  echo "Application files removed."
  ;;
*)
  echo "Application files kept."
  ;;
esac

echo "Uninstall complete."