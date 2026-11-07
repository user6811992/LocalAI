#!/usr/bin/env bash
# AegisAI uninstaller (Linux / macOS)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${1:-$SCRIPT_DIR}"

echo "Uninstall AegisAI from: $BASE"
read -r -p "Remove desktop shortcut and service? [y/N]: " ans
case "$ans" in [yY]|[yY][eE][sS]) ;;
  *) echo "Cancelled."; exit 0;;
esac

OS="$(uname -s)"

# Remove desktop shortcuts
if [ "$OS" = "Linux" ]; then
  rm -f "$HOME/Desktop/AegisAI.desktop" "$HOME/.local/share/applications/AegisAI.desktop"
  systemctl --user disable localai 2>/dev/null || true
  systemctl --user stop localai 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/localai.service"
  systemctl --user daemon-reload 2>/dev/null || true
elif [ "$OS" = "Darwin" ]; then
  rm -f "$HOME/Desktop/AegisAI.command"
  launchctl unload "$HOME/Library/LaunchAgents/com.localai.plist" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/com.localai.plist"
fi

read -r -p "Remove application files in $BASE? [y/N]: " ans2
case "$ans2" in [yY]|[yY][eE][sS])
  rm -rf "$BASE"
  echo "Application folder removed."
  ;;
  *) echo "Application files kept."
  ;;
esac

echo "Uninstall complete."