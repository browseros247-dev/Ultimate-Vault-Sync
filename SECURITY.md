# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.0.0   | ✅        |
| < 1.0.0 | ❌ (please update) |

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

- Email: via GitHub Security Advisories — **Security → Report a vulnerability** on this repository.
- Alternatively, open a private security advisory or contact the maintainers via the repository's contact links.

We aim to acknowledge reports within 3 days and provide a fix or mitigation timeline within 14 days. Please include steps to reproduce, impact, and any relevant logs (redact tokens).

## Security considerations for users

- The plugin creates a **private** GitHub repository for each vault and requests only the `repo` OAuth scope (minimum to create/push private repos).
- Your GitHub **access token** is stored only in Obsidian's local plugin data (`<vault>/<configDir>/plugins/ultimate-vault-sync/data.json`) on each device. It never leaves your device except to call GitHub's API (`Authorization: Bearer` header). It is not encrypted at rest — treat vault storage like any local secret.
- The debug log at `<configDir>/plugins/ultimate-vault-sync/logs/` redacts `token|secret|password|authorization|cookie|device_code|access_code|body|content` and truncates long values; still avoid sharing `data.json` directly.
- To revoke access: GitHub → Settings → Applications → Authorized OAuth Apps → **Revoke** for this OAuth App. Then **Disconnect** in Obsidian settings.
- Keep Obsidian and the plugin updated; updates are published via GitHub Releases.

## Hardening applied in this repo

- Release workflow pins actions by SHA, uses `npm ci --ignore-scripts`, Node 20, and build provenance attestation (`actions/attest-build-provenance`).
- Dependabot monitors npm and GitHub Actions weekly.
- No client secret is used (GitHub Device Flow) and the OAuth `CLIENT_ID` is not a secret; the build injects it at compile time.

