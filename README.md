# LocalAI

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
- `llama3.2:3b`, `qwen2.5:14b`, `qwen2.5-coder:14b`, `mistral:7b`, `phi3:mini`, `gemma2:9b`
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

## Installer / Backup

A complete offline installer is available in the `D:\LocalAI-Installer\` directory (not included in this repo). It includes:
- Interactive drive/path selection
- Component scanning with version comparison
- 15 individual pull scripts + pull-all.bat
- Auto-start setup
- MIT license

## Privacy

- No telemetry, analytics, or tracking
- No cloud dependencies — everything runs locally
- No hardcoded identifiers — paths auto-generate on install
- `search-config.json` ships with empty keys — add your own

## License

MIT License — see [LICENSE](LICENSE) for details.

## Contributing

Contributions welcome! Please open an issue or pull request.
