# Contributing to Ultimate Vault Sync

Thanks for contributing!

## Development setup

```bash
# 1. Fork and clone
git clone https://github.com/browseros247-dev/Ultimate-Obsidian_Sync.git
cd Ultimate-Obsidian_Sync

# 2. Install deps
npm install

# 3. Set your GitHub OAuth App Client ID (copy .env.example to .env and edit, or export CLIENT_ID)
cp .env.example .env
# edit .env: CLIENT_ID=Ov23liYOUR_ACTUAL_ID

# 4. Start watch mode
npm run dev

# 5. Symlink into your test vault (see README Part 2)
# Windows: mklink /D "C:\path\to\vault\.obsidian\plugins\ultimate-vault-sync" "C:\path\to\Ultimate-Obsidian_Sync"
# macOS/Linux: ln -s /path/to/Ultimate-Obsidian_Sync /path/to/vault/.obsidian/plugins/ultimate-vault-sync

# 6. Make changes — Obsidian hot-reloads the plugin automatically
# 7. Type check before submitting
npm run typecheck
```

## Project structure

```
src/
  main.ts              # Plugin entry point
  types.ts             # Types and default settings
  constants.ts         # CLIENT_ID fallback, PLUGIN_ID, BUILD_TIMESTAMP
  auth/github-device.ts
  github/api.ts
  sync/fs-adapter.ts   # Wraps DataAdapter for isomorphic-git
  sync/git-sync.ts
  sync/queue.ts
  ui/settings-tab.ts, ui/connect-flow.ts, ui/conflict-modal.ts, etc.
```

## Guidelines

- **Never use `require('fs')`** — use the `fs-adapter` so mobile works.
- **Always use `requestUrl`** from `obsidian` for HTTP — never `fetch`/`axios`.
- **Never store GitHub token outside `saveData()`**.
- **Always pull before push** — enforced in `git-sync.ts::sync()`.
- Respect `Vault.configDir` (custom config folders) — don't hardcode `.obsidian`.
- Use `window.setTimeout` / `window.clearTimeout` / `window.setInterval` (Obsidian popouts).
- Run `npm run typecheck` and `npm run build` before opening a PR.

## Pull requests

1. Create a feature branch from `main`.
2. Keep changes focused; include tests or manual verification notes where applicable.
3. Ensure `npm run typecheck` and `npm run check:versions` pass.
4. Open a PR using the template in `.github/pull_request_template.md` and link any related issue.

## Releases (Obsidian)

Obsidian and BRAT require a **bare** semver tag and release name: `1.0.9`.
Do **not** use `v1.0.9` — the release workflow rejects a leading `v`.

1. Bump `manifest.json` `version`, `package.json` `version`, and add
   `"x.y.z": "<minAppVersion>"` in `versions.json` (must equal `minAppVersion`).
2. Merge to `main`.
3. Tag and push **without** `v`:

   ```bash
   git tag 1.0.9
   git push origin 1.0.9
   ```

4. The `CLIENT_ID` repository secret must be set or the release job fails.

Manual run: Actions → Release Obsidian Plugin → version `1.0.9`
(must match the files on the branch you run from).

## Reporting bugs

Use the Bug report template in `.github/ISSUE_TEMPLATE/bug_report.md` and include diagnostics
from **Settings → Ultimate Vault Sync → Debugging → Copy diagnostics**.
