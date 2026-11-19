<!-- BEGIN opencode-rag -->
## Code Navigation

OpenCodeRAG indexes this workspace.

- First move, every task: `search_semantic` goes IN the first tool batch - an orientation call may share that batch, it never precedes it.
- Re-search when the working area changes: one search per area, not one per task.
- Authoritative elsewhere? When another system owns the current copy (source control, an MCP server, a database, an API), fetch it there first - `search_semantic` covers the local mirror and cross-cutting questions.
- A weak result is a lead, not an answer: read the printed relevance, then verify with `read` before concluding.

Tools: `search_semantic` finds code by meaning - use it before grep; `get_file_skeleton` before reading a file; `find_usages` before editing a symbol; `describe_image` for images, never raw bytes; `recall_quirks` / `add_quirk` / `update_quirk` / `delete_quirk` for experiential memory. Signatures live in the tool schema, not here.

A search that returns nothing useful usually means the workspace is not indexed: run `opencode-rag index` (or `opencode-rag status` to check).

Quirks: call `add_quirk` after resolving a failed build/test/type-check, an undocumented constraint, or a gotcha that cost more than one attempt; `update_quirk`/`delete_quirk` instead of storing a contradicting duplicate.

### Long-running commands
- Any `shell` call expected to take more than 30s MUST set `background: true` (returns immediately; the session is notified on completion) or set an explicit `timeout` (ms).
- Default foreground timeout: 120000ms. Never run builds/tests/indexes in the foreground beyond 30s; if a call is already running, press Ctrl+B to background it (OpenCode: `session.background`).
- OpenCodeRAG measures foreground shell duration and records a quirk when a call exceeds the threshold, so repeated foreground runs become visible.

The full protocol (decision tree, proactive triggers, anti-patterns) is injected into the system prompt by the plugin - `openCode.injectSystemPrompt`. Do not restate it here.
<!-- END opencode-rag -->
