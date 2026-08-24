# Ultimate Vault Sync

> Sync your Obsidian vault across every device using your own **free private GitHub repo**.  
> No subscription. No cloud fees. Works on desktop (Windows / macOS / Linux) and mobile (iOS / Android).

---

## How It Works

```
Your GitHub Account
        │
        ├── obsidian-personal-notes  ← Vault 1 (all your devices sync here)
        ├── obsidian-work-notes      ← Vault 2 (separate repo, same account)
        └── obsidian-research        ← Vault 3 (separate repo, same account)

Desktop  ──┐
Mobile   ──┼──▶  obsidian-personal-notes  (same private GitHub repo)
Laptop   ──┘
```

1. You connect your GitHub account once (in-browser, one approval click).
2. The plugin auto-creates a **private repo** named after your vault.
3. Every file save is automatically committed and pushed in the background.
4. Every device pulls the latest changes when Obsidian opens.
5. Conflicts are detected and shown with a side-by-side UI to resolve.

---

## Features

- **Works on all devices** — desktop and mobile via isomorphic-git (pure JS, no native binary)
- **One GitHub account, multiple vaults** — each vault gets its own private repo
- **Rename or switch repositories anytime** — rename the connected repo in place (history preserved) or point the vault at a different one, right from settings
- **Auto-sync** — changes push silently in the background after a short debounce
- **Pull on open** — always up-to-date when you open Obsidian
- **Conflict resolution UI** — side-by-side view when two devices edit the same file
- **Zero cost** — uses your own free GitHub repos, no server involved
- **No data leaves your account** — all files go into your own private GitHub repo

---

## Requirements

- Obsidian **1.6.0** or later
- A **free GitHub account** — [sign up at github.com](https://github.com/join) if you don't have one
- Internet access for sync (offline edits are queued and synced when back online)
- Node.js **20+** and npm (for building from source)

---

## Part 1 — Developer Setup (Build from Source)

### Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | 20+ | https://nodejs.org |
| npm | 9+ | Bundled with Node.js |
| Git | any | https://git-scm.com |

### 1.1 — Clone the Repository

```bash
git clone https://github.com/browseros247-dev/Ultimate-Obsidian_Sync.git
cd Ultimate-Obsidian_Sync
```

### 1.2 — Install Dependencies

```bash
npm install
```

This installs:
- `isomorphic-git` — pure-JS git engine (works on mobile, no native binaries)
- `esbuild` — fast bundler
- `typescript` — type checker
- `obsidian` — type definitions only (not bundled)

### 1.3 — Register a GitHub OAuth App

You need to register a free OAuth App so users can log in with their GitHub account.
This is done **once** — the `client_id` is then baked into the plugin code.

1. Go to [github.com/settings/developers](https://github.com/settings/developers)
2. Click **OAuth Apps** → **New OAuth App**
3. Fill in the form:

   | Field | Value |
   |---|---|
   | Application name | `Ultimate Vault Sync` |
   | Homepage URL | `https://github.com/browseros247-dev/Ultimate-Obsidian_Sync` |
   | Authorization callback URL | `https://obsidian.md` *(placeholder — Device Flow doesn't use this)* |

4. Click **Register application**
5. Copy the **Client ID** (looks like `Ov23li...`)
6. Create a `.env` file (copy from `.env.example`) and paste your Client ID:
   ```bash
   cp .env.example .env
   ```
   Then edit `.env`:
   ```dotenv
   CLIENT_ID=Ov23liYOUR_ACTUAL_ID
   ```
   At build time the value from `.env` (or a `CLIENT_ID` shell environment variable) **overrides** the fallback in `src/constants.ts`. `.env` is git-ignored and never committed.

> **Enable Device Flow** when registering the app — the plugin authenticates via GitHub's Device Flow. Do **not** enable "Expire user access tokens" (the plugin doesn't use refresh tokens). Do **not** generate a Client Secret — Device Flow doesn't need it and secrets must never be embedded in plugin code.

### 1.4 — Build the Plugin

```bash
# Development build (watch mode — rebuilds on every save)
npm run dev

# Production build (minified, no source maps)
npm run build
```

Both commands output a single `main.js` file in the project root.

**Client ID precedence** (resolved at build time): shell environment variable `CLIENT_ID` → `.env` file → `src/constants.ts` fallback. If no `CLIENT_ID` is found anywhere, the build prints a warning and uses the source fallback.

**Watch mode** (`npm run dev`) keeps running and rebuilds automatically as you edit source files. Leave it running while you test in Obsidian.

### 1.5 — Project Structure

```
Ultimate-Obsidian_Sync/
├── src/
│   ├── main.ts                   # Plugin entry point — wires everything together
│   ├── types.ts                  # All TypeScript interfaces & types
│   ├── constants.ts              # App-wide constants (CLIENT_ID fallback; overridden by .env at build time)
│   ├── auth/
│   │   └── github-device.ts      # GitHub OAuth Device Flow (no server needed)
│   ├── github/
│   │   └── api.ts                # GitHub REST API wrapper (create repo, get user)
│   ├── sync/
│   │   ├── fs-adapter.ts         # Bridges Obsidian DataAdapter → isomorphic-git fs
│   │   ├── git-sync.ts           # Core git operations: init / clone / pull / push
│   │   ├── queue.ts              # Debounced sync queue with mutex (no race conditions)
│   │   └── conflict.ts           # Conflict diff summary helper
│   └── ui/
│       ├── settings-tab.ts       # Plugin settings page
│       ├── conflict-modal.ts     # Side-by-side conflict resolution modal
│       └── status-bar.ts         # Live sync indicator in the status bar
├── manifest.json                 # Obsidian plugin manifest
├── package.json
├── tsconfig.json
├── esbuild.config.mjs            # Build config — injects CLIENT_ID from env / .env
├── .env.example                  # Template — copy to .env and set your Client ID
└── main.js                       # Built output (git-ignored, generated by build)
```

---

## Part 2 — Installing the Plugin

### Option A — Manual Install from Build Output

After running `npm run build`:

1. Create the plugin folder inside your vault:
   ```
   YourVault/.obsidian/plugins/ultimate-vault-sync/
   ```
2. Copy these two files into that folder:
   ```
   main.js
   manifest.json
   styles.css
   ```
3. Open Obsidian → **Settings** → **Community plugins**
4. Turn off **Restricted Mode** if prompted
5. Find **Ultimate Vault Sync** in the list → toggle it **ON**

**Tip for development:** You can symlink the project directory directly into your vault's plugins folder so the built `main.js` is picked up automatically after each build:

```bash
# Windows (run as Administrator)
mklink /D "C:\path\to\vault\.obsidian\plugins\ultimate-vault-sync" "C:\path\to\Ultimate-Obsidian_Sync"

# macOS / Linux
ln -s /path/to/Ultimate-Obsidian_Sync /path/to/vault/.obsidian/plugins/ultimate-vault-sync
```

### Option B — BRAT (Beta Testers)

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins.
2. Open BRAT settings → **Add Beta Plugin**
3. Paste the repo URL: `https://github.com/browseros247-dev/Ultimate-Obsidian_Sync`
4. Click **Add Plugin** — BRAT installs it automatically.

---

## Part 3 — Connecting Your GitHub Account

> Do this on **every device** where you want sync. Use the **same GitHub account** each time.

### Step 1 — Open Plugin Settings

Go to **Settings** → **Ultimate Obsidian Sync** (scroll down in the left sidebar under Community Plugins).

### Step 2 — Click "Connect GitHub"

You will see a screen like this:

```
┌─────────────────────────────────────────┐
│  Open this URL in your browser:         │
│  https://github.com/login/device        │
│                                         │
│           AB12-CD34                     │
│                                         │
│  Waiting for approval in browser…       │
└─────────────────────────────────────────┘
```

Your browser will open automatically. If it doesn't, copy the URL manually.

### Step 3 — Enter the Code in Your Browser

1. The GitHub page asks: **"Enter the code shown in your app"**
2. Type in the 8-character code (e.g. `AB12-CD34`)
3. Click **Continue**
4. Review what access the plugin requests: **private repos** (to create and sync your vault repo)
5. Click **Authorize**

### Step 4 — Choose Your Repository

After you approve, the plugin asks where to sync this vault:

```
┌──────────────────────────────────────────────┐
│  Choose where this vault will be synced:     │
│                                              │
│  Repository name                             │
│  [ obsidian-my-vault              ]          │
│  …or use an existing private repo            │
│  [ — Create new private repo with the name   │
│    above —                       ▼ ]         │
│                                   Refresh    │
│                                              │
│                    [Cancel] [Connect & Sync] │
└──────────────────────────────────────────────┘
```

- **Repository name** is pre-filled from your vault name (`obsidian-<your-vault-name>`). You can edit it to use a custom name — a new **private** repo with that name is created.
- **…or use an existing private repo** lets you sync into one of your existing private repos instead of creating a new one. Only **private** repos are listed.
- If the chosen repo already contains content, the plugin asks you to confirm before cloning your vault into it (the button changes to **Sync into this repo**).
- The list shows your most recently updated private repos (up to 100). Use **Refresh list** to reload it.

### Step 5 — Done

Back in Obsidian you'll see:

```
Connected as @your-github-username. Vault syncing started!
```

The plugin will:
- **First device**: Create a new private repo — named `obsidian-<your-vault-name>` by default, or the custom name/repo you picked — and push all your files.
- **Additional devices**: If you kept the default name, the existing repo is detected and cloned automatically. If you used a custom name or an existing repo, pick the same repository in the picker.

---

## Part 4 — Using the Plugin

### Automatic Sync

Once connected, the plugin runs silently in the background:

| Event | What happens |
|---|---|
| You save / edit a file | Changes are committed and pushed after 3 seconds of inactivity |
| You open Obsidian | Latest changes are pulled from GitHub |
| You close Obsidian | Any pending changes are flushed and pushed |
| Two devices edit same file | Conflict modal appears next time you open Obsidian |

### Status Bar

The bottom-right corner shows the current sync state:

| Indicator | Meaning |
|---|---|
| `✓ Ultimate Vault Sync` | All good, fully synced |
| `↓ Syncing…` | Pulling from GitHub |
| `↑ Syncing…` | Pushing to GitHub |
| `⚠ Conflict` | Two devices edited the same file — action needed |
| `✗ Sync Error` | Network or auth issue — hover for detail |

Click the status bar item to trigger an **immediate manual sync** at any time.

### Manual Sync

- Click the status bar item, **or**
- Open the Command Palette (`Ctrl/Cmd + P`) → search **"Ultimate Vault Sync: Sync vault now"**

---

## Part 5 — Resolving Conflicts

A conflict happens when the **same file** is edited on two devices before either has synced.

When the plugin detects a conflict, a modal appears automatically:

```
┌──────────────────────────────────────────────────┐
│  Sync Conflict (1 / 2)                           │
│  File: notes/daily/2026-06-01.md                 │
│                                                  │
│  Changed lines:                                  │
│  Line 4:                                         │
│    - meeting at 3pm                              │
│    + meeting at 4pm                              │
│                                                  │
│  YOUR VERSION        │  REMOTE VERSION           │
│  ──────────────────  │  ─────────────────        │
│  # June 1            │  # June 1                 │
│  meeting at 3pm      │  meeting at 4pm           │
│                                                  │
│  [Keep Mine]  [Keep Theirs]  [Open in Editor]    │
└──────────────────────────────────────────────────┘
```

| Button | Action |
|---|---|
| **Keep Mine** | Use the version from this device, discard remote changes |
| **Keep Theirs** | Use the remote version, discard local changes |
| **Open in Editor** | Close modal, open the file — edit it manually, then sync again |

After resolving, the file is immediately committed and pushed.

---

## Part 6 — Multiple Vaults

Each vault gets its **own separate repo** by default. Connect each vault with the same GitHub account; the default repo name is derived from the vault name, so the right repo is picked up automatically on every device.

```
Vault: "Personal Notes"   →  github.com/you/obsidian-personal-notes
Vault: "Work"             →  github.com/you/obsidian-work
Vault: "Research"         →  github.com/you/obsidian-research
```

On each device:
1. Open the vault in Obsidian.
2. Go to **Settings → Ultimate Obsidian Sync** → connect your GitHub account.
3. The default repo name is derived from the vault name, so the same repo is found automatically. If you chose a custom name or an existing repo when connecting the first device, pick the same repository from the picker here too.

---

## Part 7 — Settings Reference

| Setting | Default | Description |
|---|---|---|
| **Auto-sync** | On | Automatically sync on file changes |
| **Sync debounce** | 3000 ms | How long to wait after your last keystroke before syncing |
| **Excluded patterns** | See below | Files/folders that will never be synced |

### Default Excluded Patterns

```
.obsidian/workspace
.obsidian/workspace.json
.obsidian/plugins/*/data.json
```

These are excluded because they change frequently, are device-specific, and don't need to be shared.

To add more exclusions, open **Settings → Ultimate Obsidian Sync → Excluded patterns** and add one pattern per line. Wildcards (`*`) are supported.

Example — exclude all files in a `Private` folder:
```
Private/*
```

---

## Troubleshooting

### "Device code expired"
The 8-character code has a 15-minute expiry. Click **Connect GitHub** again to get a fresh code.

### "Access denied"
You clicked **Cancel** on the GitHub authorization page. Click **Connect GitHub** to try again.

### Sync shows `✗ Sync Error`
1. Check your internet connection.
2. Open **Settings → Ultimate Obsidian Sync** — if disconnected, click **Connect GitHub** to re-authenticate.
3. GitHub tokens occasionally expire — reconnecting issues a fresh token.

### Debug log and "Copy diagnostics"
Every connection and sync step is written to a rotating debug log (max 512 KB) at  
`<vault>/.obsidian/plugins/ultimate-vault-sync/logs/ultimate-vault-sync.log` (path uses `Vault.configDir`). The log is sanitized — tokens, secrets and access codes are redacted before writing — so it is safe to share.

In **Settings → Ultimate Obsidian Sync → Debugging** you can:
- **Copy log** — copy the current log file to the clipboard.
- **Clear log** — wipe the log (and its rotation copy).
- **Copy diagnostics** — copy a one-click snapshot to the clipboard: plugin version, platform, connection state, signed-in account, repository, last sync result (including the error code), a summary of your sync settings, and the last 150 log lines. Paste this into a bug report.

The last sync result shown at the bottom of the settings tab displays a short **error code** in parentheses (e.g. `(API_UNAUTHORIZED)`) alongside a friendly description whenever the last sync failed.

### Error codes
Failures are mapped to stable codes. The friendly message you see is paired with the raw detail in the debug log and the persisted sync result.

| Code | Meaning | What to do |
|------|---------|------------|
| `NETWORK_UNAVAILABLE` | Could not reach GitHub | Check your internet connection and retry. |
| `API_UNAUTHORIZED` | GitHub rejected the token | Disconnect and reconnect your GitHub account. |
| `API_FORBIDDEN` | Token lacks permission for this action | Reconnect; if it persists, check the app's scopes. |
| `API_RATE_LIMITED` | GitHub rate limit reached | Wait a few minutes and retry. |
| `API_NOT_FOUND` | Repo missing (deleted/renamed) | Pick or create a different repository. |
| `API_CONFLICT` | Repo in an unexpected state | Reconnect and pick the repository again. |
| `API_UNPROCESSABLE` | GitHub rejected the repo name | Choose a different repository name. |
| `API_SERVER_ERROR` | GitHub is having problems | Wait and retry. |
| `API_REQUEST_FAILED` | GitHub could not complete the request | Retry; check the debug log for the status. |
| `AUTH_UNAVAILABLE` | Login flow could not start | Check your connection and retry. |
| `AUTH_CODE_EXPIRED` | Code expired before approval | Click **Connect GitHub** for a fresh code. |
| `AUTH_DENIED` | Authorization cancelled in browser | Click **Connect GitHub** to start over. |
| `AUTH_DEVICE_EXPIRED` | Login request timed out | Click **Connect GitHub** and enter the code sooner. |
| `LOCAL_REPO_NOT_INITIALIZED` | Local `.git` is missing/broken | Disconnect and reconnect the vault to repair it. |
| `REPO_NAME_REQUIRED` | Repository name empty | Enter a repository name and retry. |
| `GIT_AUTH_FAILED` | GitHub rejected saved credentials | Disconnect and reconnect your GitHub account. |
| `GIT_PUSH_REJECTED` | Remote moved before the push | Sync again — changes are merged automatically. |
| `GIT_MERGE_CONFLICT` | Merge produced conflicting files | Resolve conflicts in the conflict dialog. |
| `UNCAUGHT_REJECTION` | An unexpected async error occurred | Copy diagnostics and report it. |
| `UNKNOWN` | Unmapped error | Copy diagnostics and report it. |

### Files not appearing on second device
1. Make sure you connected the **same GitHub account** on both devices.
2. Check the status bar on both devices — both should show `✓ Ultimate Obsidian Sync`.
3. Trigger a manual sync on the device that has the new files (`Ctrl/Cmd + P` → "Sync vault now").

### Mobile — "Cannot sync"
- Ensure your mobile device has an internet connection.
- The plugin uses Obsidian's built-in HTTP layer so it does not need special mobile permissions.
- If syncing fails on mobile, try disconnecting and reconnecting your GitHub account.

### `.git` folder visible in vault
The `.git` folder is hidden in Obsidian by default. If you see it, go to  
**Settings → Files & Links → Excluded files** and add `.git`.

### Build fails with "Cannot find module 'obsidian'"
Run `npm install` to install devDependencies. The `obsidian` package provides types only.

### Login fails with "GitHub Device Flow failed"
Your OAuth App must have **Enable Device Flow** turned on. Also confirm the `CLIENT_ID` baked into `main.js` matches your app — set it via `.env` (see 1.3) and rebuild.

### No repositories appear in the "use an existing private repo" picker
The picker lists your **private** repositories only (the plugin never syncs to public repos). If nothing appears:

1. Confirm the account actually owns private repositories.
2. Make sure the app was registered as an **OAuth App** (*Settings → Developer settings → OAuth Apps*), **not** a GitHub App. GitHub Apps ignore the requested `repo` scope, so their tokens cannot list or create repositories.
3. Click **Refresh list** — the status line shows the exact GitHub error if the request failed (e.g. rate limit, revoked authorization).

### I authorized in the browser but closed the window before picking a repository
No problem — the authorization is saved the moment GitHub approves it. Reopen **Settings → Ultimate Obsidian Sync**: a *Finish GitHub setup* card shows your authorized account. Click **Choose repository** to pick or rename the repository and continue — no browser re-authorization needed. Use **Disconnect** only if you want to remove the saved authorization entirely.

### Renaming vs changing the repository (connected vaults)
Both live next to your repo name in settings:
- **Rename** — renames the *same* repository on GitHub (`PATCH`). History, issues and stars are preserved, nothing is re-uploaded, and GitHub redirects the old URL to the new one — **other devices keep syncing without any update**. New devices simply see the new name in the picker.
- **Change repository** — points this vault at a *different* repository (pick an existing private one or create a new one by name). The old repository **stays on GitHub untouched**; the vault's files are pushed to / cloned from the target you choose.

### What "Replace & Sync" does when picking a repo that already has content
The repository becomes the single source of truth for this device:
1. The repo is cloned and its full content — including `.obsidian` configuration — is written into your vault.
2. Device files that are **not** in the repository are removed from the vault and moved to a dated backup folder: `.obsidian/plugins/ultimate-vault-sync/trash-<timestamp>/` (or `<configDir>/plugins/ultimate-vault-sync/trash-<timestamp>/` for custom config dirs). This folder never syncs; restore anything by moving files back.
3. Your connection settings and this plugin's own data are preserved.
⚠️ Plugins installed only on this device are removed with the purge — reinstall them afterwards if needed.

### I changed repositories — what happened to my old repository?
Nothing. It remains on your GitHub account with all its history and can be switched back to anytime via **Change repository**. Delete it manually on GitHub if you no longer want it — the plugin never deletes repositories.

### TypeScript errors after pulling
Run `npm install` — a dependency may have been added. Then re-run `npm run build`.

---

## FAQ

**Q: Is my data private?**  
A: Yes. The plugin creates a **private** GitHub repo. Only your GitHub account can access it.

**Q: Does the plugin developer see my notes?**  
A: No. The plugin runs entirely on your device and connects directly to your own GitHub account. There is no intermediate server.

**Q: What Obsidian version is required?**  
A: Obsidian **1.6.0** or later (see `manifest.json` `minAppVersion`).

**Q: What happens if I edit the same file on two offline devices?**  
A: When both devices come online, the plugin detects the conflict and shows you the resolution modal.

**Q: Can I use this with an existing vault that already has files?**  
A: Yes. On first connection, the plugin pushes all your existing files to the new GitHub repo. You can also sync into an existing private repo via the picker.

**Q: What happens on a second device if I used a custom repo name?**  
A: The default repo name is derived from the vault name, so it is found automatically on any device. If you chose a custom name or an existing repo, pick the same repository from the picker when connecting from another device.

**Q: Does this work with Obsidian's built-in sync?**  
A: It's designed to replace, not complement, Obsidian Sync. Using both at once is not recommended as they may conflict.

**Q: What is the storage limit?**  
A: GitHub repos have a soft limit of 1 GB per repo. A typical Obsidian vault of markdown files is well under 100 MB.

**Q: Can I view my notes on GitHub directly?**  
A: Yes — GitHub renders Markdown files beautifully. Browse your private repo at `github.com/your-github-username/obsidian-<vaultname>`.

**Q: Why does the plugin need the `repo` OAuth scope?**  
A: The `repo` scope is the minimum required to create and push to **private** repositories. Without it GitHub only allows access to public repos.

---

## Privacy & Security

- Your GitHub **access token** is stored only in Obsidian's local plugin data folder (`<configDir>/plugins/ultimate-vault-sync/data.json`) on each device. It never leaves your device except to communicate directly with GitHub's API.
- The plugin requests only the **`repo` scope** — the minimum required to create and access private repositories.
- Repositories are always **private**. New repos are created private, and the picker only lists your existing **private** repos.
- To revoke access at any time: GitHub → Settings → Applications → Authorized OAuth Apps → **Revoke**.

---

## Architecture Notes (for Contributors)

| Concern | Solution | Why |
|---|---|---|
| Auth | GitHub OAuth Device Flow | No server or callback URL needed |
| Storage | User's own private GitHub repo | Free, private, version-controlled |
| Sync engine | isomorphic-git (pure JS) | Works on iOS/Android — no native binaries |
| File system | Custom adapter wrapping DataAdapter | Obsidian's API works on all platforms |
| HTTP | Obsidian's `requestUrl` API | Bypasses CORS, works on mobile |

**Key constraints:**
- Never use `require('fs')` — always use the `fs-adapter` so mobile works.
- Always pull before push — enforced in `git-sync.ts::sync()`.
- Always use `requestUrl` from obsidian for HTTP — never `fetch` or `axios`.
- Never store the GitHub token anywhere other than `this.saveData()`.

---

## Contributing

Pull requests welcome!

```bash
# 1. Fork and clone
git clone https://github.com/browseros247-dev/Ultimate-Obsidian_Sync.git
cd Ultimate-Obsidian_Sync

# 2. Install deps
npm install

# 3. Set your GitHub OAuth App Client ID (copy `.env.example` to `.env` and edit, or export `CLIENT_ID`)

# 4. Start watch mode
npm run dev

# 5. Symlink into your test vault (see Part 2 above)
# 6. Make your changes — Obsidian hot-reloads the plugin automatically
# 7. Run a type check before submitting
npx tsc --noEmit
```

For bugs and feature requests, open an [issue](https://github.com/browseros247-dev/Ultimate-Obsidian_Sync/issues).

---

## License

MIT © 2026 Genius Ha Ha
