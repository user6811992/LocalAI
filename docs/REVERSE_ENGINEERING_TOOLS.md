# Reverse Engineering Toolkit

AegisAI ships with an integrated reverse-engineering (RE) toolkit powered by
OpenCode plugins, MCP servers, and Agent Skills. These are configured in
`.opencode/opencode.jsonc` and `mcp-config.json`.

## Plugins (OpenCode)

| Plugin | Purpose |
|---|---|
| `@heretek-ai/opencode-rea` | OpenCode v2 plugin for REA (reverse-engineer-anything) MCP integration |
| `opencode-mem` | Persistent memory across sessions |
| `opencode-usage-monitor` | Token/usage tracking |
| `envsitter-guard` | Environment-variable safety |
| `opencode-gemini-auth` / `opencode-antigravity-auth` | Model provider auth |
| `oh-my-opencode` | Workflow/orchestration |
| `opencode-swarm` | Multi-agent orchestration |
| `opencode-dcp` | Dynamic context pruning |
| `@cortexkit/opencode-magic-context` | Magic context management |
| `@honcho-ai/opencode-honcho` | Honcho memory integration |
| `cc-safety-net` | Safety net |

## MCP Servers

| Server | Purpose |
|---|---|
| `rea` | Ghidra-backed reverse-engineering agent (binary analysis, callers, callees, refs) |
| `netvein` | Chrome CDP web reverse engineering: 123 tools for traffic capture, AST scoring, crypto fingerprinting, anti-debug bypass |

## Skills (Agent Skills format)

Installed under `~/.agents/skills/` and `~/.config/opencode/skills/`:

- `reverse-engineering-investigator` (T-REX) — trace values, callers, init, boundaries; evidence-first
- `re-workflow`, `re-tooling`, `re-ghidra-mcp`, `re-rea`, `re-hooking`, `re-runtime-introspection`, `re-verification` (re-expertise)
- `web-reverse-clone` — web frontend/API/WASM reverse engineering and UI cloning
- `tech-core` — stripped-binary triage, Ghidra MCP, il2cpp, Android NDK, overlays
- `argus` — zero-dep RE routing CLI (magic bytes, 43 plans, 22 refs, host tool detection)
- `glassbox` — 12 RE methodology skills (recon, protocol cartography, flow modeling, evidence protocol, etc.)

## CLI Tools

- `argus` — `argus detect`, `argus plan`, `argus recon`, `argus doctor`, `argus ref`
- `netvein` — `netvein serve --mcp`, `netvein init`, `netvein install`

## Usage

OpenCode auto-loads `.opencode/opencode.jsonc` plugins and MCP servers. Agent Skills are discovered from
`~/.agents/skills/` and `~/.config/opencode/skills/`. Run `argus doctor` to check which local RE tools are
available on your host.
