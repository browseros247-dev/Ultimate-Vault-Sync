# Graph Report - .  (2026-08-21)

## Corpus Check
- Corpus is ~15,095 words - fits in a single context window. You may not need a graph.

## Summary
- 255 nodes · 560 edges · 13 communities
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 45 edges (avg confidence: 0.87)
- Token cost: 14,000 input · 7,000 output

## Community Hubs (Navigation)
- Debug Logging
- Plugin Lifecycle & Connection
- Config & Conflict UI
- Sync Types & Status Flow
- Build Dependencies
- Git Constants & Config
- GitHub API & Device Flow
- TypeScript Toolchain
- Error Taxonomy
- Plugin Manifest
- Release Pipeline

## God Nodes (most connected - your core abstractions)
1. `Ultimate Obsidian Sync Plugin` - 50 edges
2. `GitSync (isomorphic-git engine)` - 35 edges
3. `errorInfo() (error mapper)` - 30 edges
4. `DebugLogger (serialized file logging)` - 20 edges
5. `SyncQueue (debounce + retry)` - 15 edges
6. `compilerOptions` - 12 edges
7. `Conflict Resolution Modal` - 11 edges
8. `Ultimate Obsidian Sync Settings Tab` - 11 edges
9. `UltimateObsidianSyncSettingsTab` - 10 edges
10. `Ultimate Obsidian Sync` - 10 edges

## Surprising Connections (you probably didn't know these)
- `GitHub Actions Release Workflow` --references--> `esbuild.config.mjs (bundler)`  [INFERRED]
  .github/workflows/release.yml → esbuild.config.mjs
- `GitHub Actions Release Workflow` --references--> `Build-time CLIENT_ID Injection`  [INFERRED]
  .github/workflows/release.yml → esbuild.config.mjs
- `Obsidian Plugin Manifest (ultimate-obsi-sync v1.0.2)` --conceptually_related_to--> `Ultimate Obsidian Sync Plugin`  [INFERRED]
  manifest.json → src/main.ts
- `Runtime dependencies (isomorphic-git, buffer)` --references--> `GitSync (isomorphic-git engine)`  [INFERRED]
  package.json → src/sync/git-sync.ts
- `Build-time CLIENT_ID Injection` --shares_data_with--> `Constants (CLIENT_ID, endpoints, defaults)`  [INFERRED]
  esbuild.config.mjs → src/constants.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Background Auto-Sync Pipeline** — readme_Sync_Queue, readme_Git_Sync, readme_Fs_Adapter, readme_Isomorphic_Git [INFERRED 0.85]
- **Device Flow Authentication Setup Chain** — readme_Github_Device_Auth, readme_GitHub_OAuth_Device_Flow, readme_Client_ID, readme_Env_File, readme_Esbuild [INFERRED 0.85]
- **Conflict Detection and Resolution Flow** — readme_Conflict_Module, readme_Conflict_Modal, readme_Conflict_Resolution_UI, readme_Status_Bar [EXTRACTED 1.00]
- **GitHub Device Flow Authentication Sequence** — src_ui_settings_tab_settingstab, src_auth_github_device_requestdevicecode, src_auth_github_device_pollfortoken, src_constants_constants, src_types_githubmodels [EXTRACTED 1.00]
- **Debounced Auto-Sync Pipeline (event funnel -> queue -> git cycle -> fs bridge)** — src_main_autosynceventfunnel, src_sync_queue_syncqueue, src_sync_git_sync_gitsync, src_sync_git_sync_synccycle, src_sync_fs_adapter_createfsadapter [EXTRACTED 1.00]
- **First-Time Connection & Repository Setup Flow** — src_ui_settings_tab_settingstab, src_main_repositorysetupflow, src_github_api_repoexists, src_github_api_createrepo, src_github_api_repohascommits, src_sync_git_sync_gitsync [EXTRACTED 1.00]

## Communities (13 total, 0 thin omitted)

### Community 0 - "Debug Logging"
Cohesion: 0.13
Nodes (8): Runtime dependencies (isomorphic-git, buffer), DebugLogger (serialized file logging), Log Sanitization / Secret Redaction, Repository Setup Flow (create/clone/init+push decision tree), Buffer Shim (inject), createFsAdapter (DataAdapter -> fs bridge), GitSync (isomorphic-git engine), Six-Step Sync Cycle (stage/commit/fetch/merge/conflict-detect/push)

### Community 1 - "Plugin Lifecycle & Connection"
Cohesion: 0.14
Nodes (3): Mobile Vault Path Handling, Ultimate Obsidian Sync Plugin, UltimateObsidianSyncSettingsTab

### Community 2 - "Config & Conflict UI"
Cohesion: 0.08
Nodes (30): BRAT Plugin, OAuth App Client ID, conflict-modal.ts, conflict.ts, Conflict Resolution UI, constants.ts, Sanitized Rotating Debug Log, .env Configuration File (+22 more)

### Community 3 - "Sync Types & Status Flow"
Cohesion: 0.13
Nodes (16): diffSummary(), StatusCallback, ConflictFile, ConnectionState, DEFAULT_SETTINGS, GitHubRepo, GitHubUser, PluginSettings + DEFAULT_SETTINGS + PROTECTED_EXCLUDES (+8 more)

### Community 4 - "Build Dependencies"
Cohesion: 0.08
Nodes (25): buffer, dotenv, esbuild, isomorphic-git, obsidian, dependencies, buffer, isomorphic-git (+17 more)

### Community 5 - "Git Constants & Config"
Cohesion: 0.11
Nodes (20): CLIENT_ID, DEFAULT_BRANCH, GIT_AUTHOR_EMAIL, GIT_AUTHOR_NAME, GIT_DIR, GITHUB_API_BASE, GITHUB_DEVICE_URL, GITHUB_TOKEN_URL (+12 more)

### Community 6 - "GitHub API & Device Flow"
Cohesion: 0.29
Nodes (14): pollForToken() (device flow step 2), requestDeviceCode() (device flow step 1), Constants (CLIENT_ID, endpoints, defaults), createRepo(), getAuthenticatedUser(), getUserRepos(), ghFetch() (GitHub REST core), repoExists() (+6 more)

### Community 7 - "TypeScript Toolchain"
Cohesion: 0.11
Nodes (17): DOM, ES2018, node, src/**/*.ts, compilerOptions, allowSyntheticDefaultImports, importHelpers, inlineSourceMap (+9 more)

### Community 8 - "Error Taxonomy"
Cohesion: 0.23
Nodes (9): describeApiStatus(), errorInfo() (error mapper), Stable Error Code Taxonomy, NETWORK_PATTERNS, SyncError (coded error class), toMessage(), Auto-Sync Event Funnel (5s aggregation window), SyncQueue (debounce + retry) (+1 more)

### Community 9 - "Plugin Manifest"
Cohesion: 0.20
Nodes (9): author, authorUrl, description, fundingUrl, id, isDesktopOnly, minAppVersion, name (+1 more)

### Community 10 - "Release Pipeline"
Cohesion: 0.43
Nodes (7): Build-time CLIENT_ID Injection, esbuild.config.mjs (bundler), GitHub Actions Release Workflow, Obsidian Plugin Manifest (ultimate-obsi-sync v1.0.2), package.json scripts (dev/build), TypeScript Config (ES2018, bundler resolution), versions.json (plugin->minAppVersion map)

## Ambiguous Edges - Review These
- `package.json scripts (dev/build)` → `Obsidian Plugin Manifest (ultimate-obsi-sync v1.0.2)`  [AMBIGUOUS]
  manifest.json · relation: conceptually_related_to

## Knowledge Gaps
- **64 isolated node(s):** `id`, `name`, `version`, `minAppVersion`, `description` (+59 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `package.json scripts (dev/build)` and `Obsidian Plugin Manifest (ultimate-obsi-sync v1.0.2)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `Ultimate Obsidian Sync Plugin` connect `Plugin Lifecycle & Connection` to `Debug Logging`, `Sync Types & Status Flow`, `GitHub API & Device Flow`, `Error Taxonomy`, `Release Pipeline`?**
  _High betweenness centrality (0.160) - this node is a cross-community bridge._
- **Why does `GitSync (isomorphic-git engine)` connect `Debug Logging` to `Plugin Lifecycle & Connection`, `Sync Types & Status Flow`, `Git Constants & Config`, `GitHub API & Device Flow`, `Error Taxonomy`?**
  _High betweenness centrality (0.087) - this node is a cross-community bridge._
- **Why does `errorInfo() (error mapper)` connect `Error Taxonomy` to `Debug Logging`, `Plugin Lifecycle & Connection`, `Sync Types & Status Flow`, `Git Constants & Config`, `GitHub API & Device Flow`?**
  _High betweenness centrality (0.063) - this node is a cross-community bridge._
- **Are the 4 inferred relationships involving `Ultimate Obsidian Sync Plugin` (e.g. with `Obsidian Plugin Manifest (ultimate-obsi-sync v1.0.2)` and `Auto-Sync Event Funnel (5s aggregation window)`) actually correct?**
  _`Ultimate Obsidian Sync Plugin` has 4 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `GitSync (isomorphic-git engine)` (e.g. with `Runtime dependencies (isomorphic-git, buffer)` and `Repository Setup Flow (create/clone/init+push decision tree)`) actually correct?**
  _`GitSync (isomorphic-git engine)` has 3 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `errorInfo() (error mapper)` (e.g. with `pollForToken() (device flow step 2)` and `Stable Error Code Taxonomy`) actually correct?**
  _`errorInfo() (error mapper)` has 3 INFERRED edges - model-reasoned connections that need verification._