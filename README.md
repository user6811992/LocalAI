# Local AI (Ollama) - Setup & Access

This machine runs a local LLM via Ollama, exposed on your LAN so your iPhone/iPad and Windows devices can use it.

## Server (this PC)
- Ollama API:  http://192.168.1.249:11434
- Web chat UI: http://192.168.1.249:8080
- Model: llama3.1:8b (CPU, ~5-10 tok/s)

Files:
- C:\Users\Poonjab\Documents\LocalAI\server.js   (web UI + proxy)
- C:\Users\Poonjab\Documents\LocalAI\public\index.html
- C:\Users\Poonjab\Documents\LocalAI\start.bat    (manual start)
- C:\Users\Poonjab\Documents\LocalAI\launcher.vbs (silent auto-start at login)

Auto-start: a shortcut in the Startup folder runs launcher.vbs at login.

## Use from any device (browser)
Open http://192.168.1.249:8080 on phone or PC browser. Works on iOS Safari / Windows Edge.

## Use from iOS (native apps)
Install one of these from the App Store, then set the server URL to http://192.168.1.249:11434
- Enchanted (free) - Settings -> Server URL
- Msty
- ChatterUI
- Shortcuts: use "Get contents of URL" to POST to http://192.168.1.249:11434/api/generate

Note: iOS must be on the same Wi-Fi. For access away from home, set up a tunnel (Tailscale / Cloudflare Tunnel) - see below.

## Use from Windows (native apps)
- Msty, LM Studio, Chatbox, AnythingLLM, Jan
- Set OpenAI-compatible base URL: http://192.168.1.249:11434/v1
  (API key can be anything, e.g. "ollama")

## Remote access (optional, outside LAN)
Install Tailscale on this PC and your devices for a private VPN, then use the Tailscale IP.
Or run a Cloudflare Tunnel: cloudflared tunnel --url http://localhost:11434

## Add more models
  ollama pull qwen2.5:7b
  ollama pull mistral:7b
  ollama pull phi3:mini
  ollama pull nomic-embed-text

## Reverse Engineering (REA)
- REA CLI installed: `rea --version` → 6.8.0
- MCP server config: `C:\Users\Poonjab\Documents\LocalAI\mcp-config.json` (import into Msty/LM Studio/Cursor/Claude Desktop/AnythingLLM).
- Web UI has an "RE tools" checkbox → enables agent mode with 229 RE tools (binaries, JS/Electron, websites, Android, firmware, etc.).
- Registered REA MCP in OpenCode (this environment) automatically.
- **Ghidra 12.1.4** installed at `C:\Ghidra\ghidra_12.1.4_PUBLIC` (GHIDRA_INSTALL_DIR set). JDK 21 set.
- **jadx 1.5.6** at `C:\jadx\bin`; jadx-headless-mcp 0.7.1 JAR at `C:\Tools\jadx-mcp`.
- **Kuna 1.987** Windows binary at `C:\Kuna\...` (REA_KUNA_COMMAND set), but REA's Kuna provider is not supported on Windows (process-tree ownership unverified). Kuna Ghidra plugin available for Ghidra GUI (version-locked to Ghidra 12.1.2; use "Install Anyway" with 12.1.4).
- **IDA Pro** and **Hopper** are commercial/optional: Hopper is macOS-only; IDA requires `REA_IDA_MCP_CONFIG` pointing to an upstream IDA MCP registration. Not freely installable.
- `rea doctor` → healthy: true, environment_healthy: true.

- If devices can't connect: check Windows Firewall rules "Ollama API 11434" and "Local AI Web UI 8080".
- If Ollama not running: run start.bat.
- IP may change: find it with `ipconfig`. Update clients if needed. Consider setting a static IP / DHCP reservation on your router.

## Desktop GUI (Windows)
- launch-gui.ps1: starts services if needed and opens an app-like window via Edge.
- Desktop + Start Menu shortcut: 'Local AI'.
- tray.ps1: system tray icon with Open/Exit; auto-starts at login.
- To pin to taskbar: launch once, then right-click the taskbar icon and choose Pin to taskbar.

