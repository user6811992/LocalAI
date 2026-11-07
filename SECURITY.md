# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.9.x   | Yes       |
| < 1.9   | No        |

## Reporting a Vulnerability

Please report security vulnerabilities by opening a GitHub issue or contacting the maintainer directly.

## Security Considerations

- **No authentication by default**: LocalAI binds to 0.0.0.0:8080 without auth. Set `LOCALAI_TOKEN` env var or create `auth.json` for LAN/remote use.
- **Rate limiting**: 120 requests/minute per IP (built-in).
- **Code execution**: The `/api/run-code` endpoint executes code in a sandboxed temp file with a 15s timeout. Only JavaScript and Python are supported.
- **File access**: Tools are scoped to the project directory. The server does not allow path traversal outside the project root.
- **No telemetry**: Zero phone-home, analytics, or tracking.

## Best Practices

- Use Tailscale or Cloudflare Tunnel for remote access instead of exposing port 8080 directly.
- Set an auth token (`LOCALAI_TOKEN`) when using on a shared network.
- Keep Ollama and Node.js updated.