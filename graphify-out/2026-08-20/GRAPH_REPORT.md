# Graph Report - C:\Users\25804\Downloads\ABDM\Default_Opencode_Dir\github-valut-sync  (2026-08-20)

## Corpus Check
- Corpus is ~10,863 words - fits in a single context window. You may not need a graph.

## Summary
- 217 nodes · 428 edges · 12 communities (11 shown, 1 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 19 edges (avg confidence: 0.84)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Plugin Lifecycle & Auth
- Build & Release Pipeline
- GitHub API & Repo Setup
- Dependencies & Packages
- Logging & File Adapter
- Git Sync Engine
- TypeScript Build Config
- Constants & Git Transport
- Conflict Resolution UI
- Plugin Manifest

## God Nodes (most connected - your core abstractions)
1. `UltimateObsidianSyncPlugin` - 35 edges
2. `GitSync` - 26 edges
3. `DebugLogger` - 17 edges
4. `compilerOptions` - 12 edges
5. `Ultimate Obsidian Sync Plugin` - 11 edges
6. `SyncQueue` - 9 edges
7. `ConflictFile` - 9 edges
8. `ConflictModal` - 8 edges
9. `UltimateObsidianSyncSettingsTab` - 8 edges
10. `SyncStatus` - 6 edges

## Surprising Connections (you probably didn't know these)
- `npm install (dependencies)` --shares_data_with--> `npm install step`  [INFERRED]
  README.md → .github/workflows/release.yml
- `main.js built output` --shares_data_with--> `main.js release artifact`  [INFERRED]
  README.md → .github/workflows/release.yml
- `npm run build (production build)` --shares_data_with--> `npm run build step (with CLIENT_ID env)`  [INFERRED]
  README.md → .github/workflows/release.yml
- `CLIENT_ID build-time injection` --shares_data_with--> `CLIENT_ID secret`  [INFERRED]
  README.md → .github/workflows/release.yml
- `manifest.json plugin manifest` --shares_data_with--> `manifest.json release artifact`  [INFERRED]
  README.md → .github/workflows/release.yml

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Release pipeline produces plugin artifacts** — _github_workflows_release_release_workflow, _github_workflows_release_npm_install, _github_workflows_release_npm_run_build, _github_workflows_release_softprops_action_gh_release, _github_workflows_release_artifacts_main_js, _github_workflows_release_artifacts_manifest_json [EXTRACTED 1.00]
- **CLIENT_ID build-time injection chain** — _github_workflows_release_secret_client_id, _github_workflows_release_npm_run_build, readme_client_id_injection, readme_constants_client_id [INFERRED 0.85]
- **Mobile-first sync architecture** — readme_isomorphic_git, readme_fs_adapter, readme_dataadapter, readme_requesturl, readme_git_sync [INFERRED 0.85]

## Communities (12 total, 1 thin omitted)

### Community 0 - "Plugin Lifecycle & Auth"
Cohesion: 0.15
Nodes (5): pollForToken(), requestDeviceCode(), getAuthenticatedUser(), UltimateObsidianSyncPlugin, UltimateObsidianSyncSettingsTab

### Community 1 - "Build & Release Pipeline"
Cohesion: 0.09
Nodes (31): actions/checkout@v4, actions/setup-node@v4 (Node 18.x), main.js release artifact, manifest.json release artifact, npm install step, npm run build step (with CLIENT_ID env), Release Obsidian Plugin Workflow, CLIENT_ID secret (+23 more)

### Community 2 - "GitHub API & Repo Setup"
Cohesion: 0.14
Nodes (16): createRepo(), ghFetch(), repoExists(), repoHasCommits(), vaultNameToRepoName(), StatusCallback, ConnectionState, DEFAULT_SETTINGS (+8 more)

### Community 3 - "Dependencies & Packages"
Cohesion: 0.08
Nodes (25): buffer, dotenv, esbuild, isomorphic-git, obsidian, dependencies, buffer, isomorphic-git (+17 more)

### Community 4 - "Logging & File Adapter"
Cohesion: 0.16
Nodes (9): DebugLogger, LogContext, LogLevel, redactText(), safeError(), sanitize(), Stats, SyncQueue (+1 more)

### Community 6 - "TypeScript Build Config"
Cohesion: 0.11
Nodes (17): DOM, ES2018, node, src/**/*.ts, compilerOptions, allowSyntheticDefaultImports, importHelpers, inlineSourceMap (+9 more)

### Community 7 - "Constants & Git Transport"
Cohesion: 0.16
Nodes (14): CLIENT_ID, DEFAULT_BRANCH, GIT_AUTHOR_EMAIL, GIT_AUTHOR_NAME, GIT_DIR, GITHUB_API_BASE, GITHUB_DEVICE_URL, GITHUB_TOKEN_URL (+6 more)

### Community 8 - "Conflict Resolution UI"
Cohesion: 0.33
Nodes (4): diffSummary(), ConflictFile, ConflictModal, ResolveCallback

### Community 9 - "Plugin Manifest"
Cohesion: 0.20
Nodes (9): author, authorUrl, description, fundingUrl, id, isDesktopOnly, minAppVersion, name (+1 more)

## Knowledge Gaps
- **57 isolated node(s):** `id`, `name`, `version`, `minAppVersion`, `description` (+52 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `UltimateObsidianSyncPlugin` connect `Plugin Lifecycle & Auth` to `GitHub API & Repo Setup`, `Logging & File Adapter`, `Git Sync Engine`?**
  _High betweenness centrality (0.109) - this node is a cross-community bridge._
- **Why does `GitSync` connect `Git Sync Engine` to `Plugin Lifecycle & Auth`, `GitHub API & Repo Setup`, `Logging & File Adapter`, `Constants & Git Transport`?**
  _High betweenness centrality (0.077) - this node is a cross-community bridge._
- **Why does `DebugLogger` connect `Logging & File Adapter` to `Plugin Lifecycle & Auth`, `GitHub API & Repo Setup`, `Git Sync Engine`, `Constants & Git Transport`?**
  _High betweenness centrality (0.046) - this node is a cross-community bridge._
- **What connects `id`, `name`, `version` to the rest of the system?**
  _57 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Plugin Lifecycle & Auth` be split into smaller, more focused modules?**
  _Cohesion score 0.14616755793226383 - nodes in this community are weakly interconnected._
- **Should `Build & Release Pipeline` be split into smaller, more focused modules?**
  _Cohesion score 0.08817204301075268 - nodes in this community are weakly interconnected._
- **Should `GitHub API & Repo Setup` be split into smaller, more focused modules?**
  _Cohesion score 0.1396011396011396 - nodes in this community are weakly interconnected._