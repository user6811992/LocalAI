# AegisAI

![Version](https://img.shields.io/github/v/release/user6811992/LocalAI) ![License](https://img.shields.io/github/license/user6811992/LocalAI) [![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink)](https://github.com/sponsors/user6811992)

A local AI web UI powered by [Ollama](https://ollama.com), with a built-in chat interface, search engine integration, model management, and reverse-engineering tools. Runs entirely on your machine — no cloud, no telemetry.

## Features

- **Chat UI** — clean, responsive web interface with thinking-block display, Markdown rendering, and code highlighting
- **Model management** — pull models from Ollama or HuggingFace, one-click quick-pull for recommended models, installed-models list
- **Search integration** — 9 keyless search engines (DuckDuckGo, Bing, Google, etc.) + optional LangSearch API
- **Reverse engineering** — 229 RE tools via REA MCP (binaries, JS/Electron, Android, firmware, etc.)
- **Agent tool-call loop** — automatic tool execution with fallback parsing for uncensored models
- **PWA** — installable as a progressive web app on mobile and desktop
- **Mobile-friendly** — safe-area insets, touch targets, install hint banner
- **No telemetry** — zero phone-home, analytics, or tracking code
- **Portable** — auto-generates paths on install, no hardcoded usernames

## Supported Models

Tested with:
- `llama3.2:3b`, `qwen2.5:14b`, `qwen2.5-coder:14b`, `qwen2.5-coder:7b`, `mistral:7b`, `phi3:mini`, `gemma2:9b`, `deepseek-coder:6.7b`, `deepseek-coder-v2:16b`, `deepseek-r1:14b`
- Uncensored: `huihui_ai/qwen2.5-coder-abliterate:7b`, `huihui_ai/deepseek-r1-abliterated:8b`
- Vision: `moondream`, `gemma3:4b`
- Embeddings: `nomic-embed-text`

## Quick Start

### Prerequisites
- [Node.js](https://nodejs.org) 18+
- [Ollama](https://ollama.com/download) installed and running

### Install
```bash
git clone https://github.com/user6811992/LocalAI.git
cd LocalAI
npm install
```

### Run
```bash
# Start Ollama (if not running)
ollama serve

# Start the web UI
node server.js
```

Open http://127.0.0.1:8080 in your browser.

### Pull a model
```bash
ollama pull llama3.2:3b
```
Or use the **Models** button in the web UI.

## Docker (cross-platform)

Run LocalAI with Docker (works on Windows, macOS, Linux):

```
docker compose up -d
```

This starts:
- **Ollama** on port 11434
- **LocalAI** on port 8080

Pull a model:
```
docker exec -it <ollama-container> ollama pull llama3.2:3b
```

Or use the Models button in the web UI.

## Remote Access

### Same Wi-Fi (LAN)
Open `http://<your-pc-ip>:8080` on any device on the same network.

### Tailscale (recommended for remote)
Install [Tailscale](https://tailscale.com) on your PC and devices for a private VPN. Both will get `100.x.x.x` addresses.

### Cloudflare Quick Tunnel (no domain needed)
```bash
cloudflared tunnel --url http://localhost:8080
```

## Reverse Engineering Tools

Requires [REA](https://github.com/...) installed separately. Set the following environment variables:

```bash
GHIDRA_INSTALL_DIR=C:\Ghidra\ghidra_12.1.4_PUBLIC
JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-21.0.13.9-hotspot
REA_JADX_MCP_JAR=C:\Tools\jadx-mcp\jadx-headless-mcp-0.7.1-all.jar
```

The web UI's "RE tools" checkbox enables agent mode with 229 RE tools.

## Installer (Linux / macOS)

A bash installer is included: **`install.sh`**. Works on Linux and macOS.

```
bash install.sh
```

It provides:
- Interactive install location selection
- Prerequisite checks (Node.js, Ollama)
- Optional model pull (recommended models in order)
- Desktop shortcut (`.desktop` on Linux, `.command` on macOS)
- Optional auto-start (systemd user service on Linux, launchd on macOS)
- Optional immediate launch

Uninstall with `bash uninstall.sh`.

## Installer (Windows Shell)

A standard Windows-shell installer is included in the repo: **`install.vbs`**. It runs under `wscript.exe` (the standard Windows Script Host) — no PowerShell, no console window. It uses native Windows dialogs and:
- Asks where to install (interactive folder selection) and copies the app files there
- Checks for Node.js and Ollama and reports what's missing
- Optionally pulls all recommended models in the proper order (llama3.2, qwen2.5, mistral, etc.)
- Prompts whether to create a **desktop shortcut** (your selection)
- Optionally launches LocalAI immediately after install
- Detects an existing install and offers a core-file update (preserves models & shortcuts)
- Scans drives for existing tools (Ghidra, jadx, Ollama, Node, Java) and reports findings
- Writes an `install.log` for troubleshooting
- Includes `uninstall.vbs` to remove shortcuts (and optionally the app folder)
- Includes `tray.vbs` for a system-tray icon (via PowerShell NotifyIcon)
- Creates `.lnk` shortcuts via `WScript.Shell` (standard Windows shell)

Run it by double-clicking `install.vbs`. Or from a command prompt:

```
wscript.exe install.vbs
```

The launcher itself is **`launcher.vbs`** (Windows Script Host / standard Windows shell) and is portable — it resolves all paths relative to its own location and starts Ollama, the web UI, and the Edge app window. Desktop shortcuts created by the installer point at `launcher.vbs`.

> Note: `tray.ps1` is retained (used by `tray.vbs` for the system-tray icon). The legacy `launch-gui.ps1` and `start.bat` have been removed in favor of `install.vbs` + `launcher.vbs`.

## Troubleshooting (Windows)

### "Windows protected your PC" (SmartScreen)
The installer (`install.vbs`) and launcher are not code-signed, so SmartScreen may warn on first run.

- Click **More info** then **Run anyway**.
- Or right-click the file → **Properties** → check **Unblock** → OK, then run.

Code signing is not included in this project; if you need it, sign the `.vbs` files with your own certificate (`signtool`).

### Ollama / Node not found
The installer checks for `node` and `ollama` on PATH. If missing, install them:
- Node.js: https://nodejs.org
- Ollama: https://ollama.com/download

Then re-run `install.vbs`.

## Screenshots

![Main UI](docs/screenshots/main.png)

![Models dialog](docs/screenshots/models.png)

![Components dialog](docs/screenshots/components.png)

![About dialog](docs/screenshots/about.png)

## Security / Auth

By default, LocalAI has **no authentication** (suitable for localhost use). For LAN or remote access, set a token:

**Environment variable:**
```
LOCALAI_TOKEN=your-secret-token node server.js
```

**Or create `auth.json` in the app folder:**
```json
{ "token": "your-secret-token" }
```

When a token is set, all API requests require `X-Auth-Token: <token>` header. The web UI will prompt for the token on first load and store it in localStorage.

**Rate limiting:** 120 requests/minute per IP (built-in).

**LAN access warning:** If no token is set and the server binds to 0.0.0.0, a warning is printed to the console. Use Tailscale or Cloudflare Tunnel for secure remote access.

## Privacy

- No telemetry, analytics, or tracking
- No cloud dependencies — everything runs locally
- No hardcoded identifiers — paths auto-generate on install
- `search-config.json` ships with empty keys — add your own

## Acknowledgments

Special thanks to:

- **[OpenCode](https://opencode.ai)** - the AI coding agent harness that helped build, debug, and ship this project (installer, launcher, UI features, and more).
- **[Beam.ai](https://beam.ai)** - the model provider powering the coding/reasoning assistance behind this work.
- **[Ollama](https://ollama.com)** - for making local LLMs easy to run.
- **[HuggingFace](https://huggingface.co)** - for the model hub and open weights.
- **[morluto/rea](https://github.com/morluto)** - for the REA reverse-engineering toolset.
- **[Alex Gao](https://github.com/alexgaoth)** - for [awesome-reverse-engineered](https://github.com/alexgaoth/awesome-reverse-engineered), a curated index of 17,000+ reverse-engineered projects (MIT code license, CC0 data license). Integrated search and project lookup help users find existing RE work before starting their own.
- All other contributors, testers, and the open-source community.

## Support

If you find LocalAI useful, consider sponsoring the project:

- [GitHub Sponsors](https://github.com/sponsors/user6811992) — recurring or one-time
- Star the repo to help others discover it


## License

MIT License — see [LICENSE](LICENSE) for details.

## Contributing

Contributions welcome! Please open an issue or pull request.
