# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.2.3+  | Yes       |
| < 2.1.60 | No       |

## Reporting a Vulnerability

Please report security vulnerabilities by opening a GitHub issue or contacting the maintainer directly.

## Security Considerations

- **Localhost by default**: the server binds to `127.0.0.1`. Set `HOST=0.0.0.0` only for LAN access, and always set `LOCALAI_TOKEN` (or `auth.json`) when you do. The token is compared in constant time.
- **Process execution**: most external processes (Ollama, git, Python, Node) are started with argument arrays. Some operations (installers, git clean, archive extraction) use shell commands. Model names are validated. `isDangerousCmd` provides an advisory substring blocklist, not a sandbox.
- **Rate limiting**: 120 requests/minute per IP (built-in).
- **Request size limit**: 100 MB by default (`AEGISAI_MAX_BODY`).
- **Code execution**: `/api/run-code` and the `run_python` / `skill_run` tools execute code **without a sandbox**. They run as your user with a timeout. Do not expose them to untrusted users.
- **File access**: agent file tools are scoped to the project root. Set `AEGISAI_PROJECT_ROOT_ALLOWLIST` to restrict which directories can be selected as the root.
- **Clean room mode**: blocks file, shell, Python, skill, git, and RE-decompiler tools at the tool level, not only in the prompt.
- **Security headers**: CSP (allows inline scripts for the UI), `X-Frame-Options: DENY`, `nosniff`, `no-referrer` on the web UI and API responses.
- **Local vendored assets**: the web UI loads no third-party CDN scripts.
- **No telemetry**: Zero phone-home, analytics, or tracking.
- **Backup exports**: `/api/backup` includes API keys in plain text. Redact or warn before sharing backups.

## Best Practices

- Use Tailscale or Cloudflare Tunnel for remote access instead of exposing port 8080 directly.
- Set an auth token (`LOCALAI_TOKEN`) when using on a shared network.
- Keep Ollama and Node.js updated.