import { Plugin, Notice, TFile, TAbstractFile, Platform, DataAdapter } from "obsidian";
import { PluginSettings, DEFAULT_SETTINGS, getProtectedExcludes, buildDefaultSettings, SyncStatus, ConflictFile, ConnectionState } from "./types";
import { UltimateObsidianSyncSettingsTab } from "./ui/settings-tab";
import { GitHubConnectModal } from "./ui/connect-flow";
import { StatusBarItem } from "./ui/status-bar";
import { ConflictModal } from "./ui/conflict-modal";
import { GitSync, PullResult } from "./sync/git-sync";
import { SyncQueue } from "./sync/queue";
import { matchesAnyGlob } from "./sync/globs";
import { repoExists, createRepo, repoHasCommits, renameRepo, validateRepoName } from "./github/api";
import { BUILD_TIMESTAMP, PLUGIN_ID, LEGACY_PLUGIN_ID, LEGACY_PLUGIN_ID_OLD, SYNC_DEBOUNCE_MS, LEGACY_SYNC_DEBOUNCE_MS, clampDebounceMs, clampPullIntervalSec } from "./constants";
import { DebugLogger } from "./debug/logger";
import { errorInfo } from "./debug/errors";

/** Re-prompt suppression window for an identical, dismissed pull-conflict set. */
const PULL_CONFLICT_REPROMPT_MS = 60_000;
/** Folds the visibilitychange + window-focus double-fire into one pull. */
const FOCUS_PULL_COOLDOWN_MS = 1_000;

export default class UltimateObsidianSyncPlugin extends Plugin {
  settings!: PluginSettings;
  private statusBar!: StatusBarItem;
  private gitSync: GitSync | null = null;
  private syncQueue: SyncQueue | null = null;
  private logger!: DebugLogger;
  private connectionState: ConnectionState = "disconnected";
  private boundVisibilityHandler: (() => void) | null = null;
  private boundWindowFocusHandler: (() => void) | null = null;
  private boundOnlineHandler: (() => void) | null = null;
  private focusPulling = false;
  private lastFocusPullAt = 0;
  private backgroundPullTimer: number | null = null;
  private backgroundPullBusy = false;
  private lastPullConflictSignature: string | null = null;
  private lastPullConflictModalAt = 0;
  private settingsTab: UltimateObsidianSyncSettingsTab | null = null;
  private activeConnectModal: GitHubConnectModal | null = null;
  private ensureConnectedTimer: number | null = null;
  private boundUnhandledRejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;
  private selfFileWatcherTimer: number | null = null;
  private selfFileFingerprint: string | null = null;
  private conflictUiOpen = false;
  private eventWindow = {
    modify: 0,
    create: 0,
    delete: 0,
    rename: 0,
    blocked: 0,
    filtered: 0,
    enqueued: 0,
  };

  private getVaultPath(adapter: DataAdapter): string {
    // Mobile adapters may expose basePath even though their API expects vault-relative paths.
    // isomorphic-git must use the adapter root on mobile, never the exposed filesystem path.
    if (Platform.isMobile) return "";
    return adapterBasePath(adapter);
  }

  async onload(): Promise<void> {
    this.logger = new DebugLogger(this.app.vault.adapter, this.app.vault.configDir);
    await this.logger.info("plugin.onload", "Plugin load started", {
      platform: Platform.isMobile ? "mobile" : "desktop",
      pluginId: this.manifest.id,
      version: this.manifest.version,
      buildTimestamp: BUILD_TIMESTAMP,
    });
    await this.loadSettings();
    await this.logger.info("plugin.onload", "Settings loaded", {
      hasToken: Boolean(this.settings.githubToken),
      hasUsername: Boolean(this.settings.githubUsername),
      hasRepo: Boolean(this.settings.repoName),
    });

    this.statusBar = new StatusBarItem(this);
    this.statusBar.onClick(() => {
      void this.triggerManualSync();
    });

    this.settingsTab = new UltimateObsidianSyncSettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    // Keyboard command
    this.addCommand({
      id: "sync-now",
      name: "Sync vault now",
      callback: () => {
        void this.triggerManualSync();
      },
    });

    // Boot sync engine if already connected. If not, keep retrying briefly so a
    // connection persisted by a previous (replaced) instance mid-setup is picked
    // up without requiring a manual restart.
    if (!(await this.ensureConnected())) {
      this.startConnectionRetry();
    }

    // Pull on open — wait for workspace to be ready
    this.app.workspace.onLayoutReady(async () => {
      // Diagnostics run after layout settles: the install audit and the
      // self-file watcher baseline must not race the mobile fs bridge.
      window.setTimeout(() => {
        void this.traceSiblingInstalls();
        this.startSelfFileWatcher();
      }, 1000);
      await this.ensureConnected();
      if (this.gitSync) {
        this.setStatus("pulling");
        await this.runPull("open");
      }
    });

    // Watch file changes for auto-sync
    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        if (file instanceof TFile) this.trackVaultEvent("modify", file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file: TAbstractFile) => {
        if (file instanceof TFile) this.trackVaultEvent("create", file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        if (file instanceof TFile) this.trackVaultEvent("delete", file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        this.trackVaultEvent("rename", file.path, oldPath);
      })
    );

    // Aggregate auto-sync event funnel (one INFO line per 5s window)
    this.registerInterval(window.setInterval(() => {
      const snapshot = { ...this.eventWindow };
      const hasEvents = Object.values(snapshot).some((n) => n > 0);
      this.eventWindow = {
        modify: 0,
        create: 0,
        delete: 0,
        rename: 0,
        blocked: 0,
        filtered: 0,
        enqueued: 0,
      };
      if (hasEvents) {
        void this.logger.info("auto-sync.event-window", "Vault event funnel", snapshot);
      }
    }, 5000));

    // Sync on window/tab focus
    this.setupFocusSync();

    // Pull immediately when connectivity returns (wake from sleep, Wi-Fi
    // reconnect) so inbound changes do not wait for the next poll tick.
    this.boundOnlineHandler = () => {
      if (this.connectionState !== "connected" || !this.gitSync) return;
      void this.runPull("online");
    };
    window.addEventListener("online", this.boundOnlineHandler);

    // Safety net: surface uncaught async rejections into the debug log so
    // diagnosis never depends on the console being open.
    this.boundUnhandledRejectionHandler = (event: PromiseRejectionEvent) => {
      void this.logger.error(
        "unhandledrejection",
        "Unhandled promise rejection",
        event.reason,
        { code: "UNCAUGHT_REJECTION" }
      );
    };
    window.addEventListener("unhandledrejection", this.boundUnhandledRejectionHandler);
  }

  onunload(): void {
    void this.teardownOnUnload();
  }

  private async teardownOnUnload(): Promise<void> {
    await this.logger.info("plugin.onunload", "Plugin unload started", {
      pluginId: this.manifest.id,
      buildTimestamp: BUILD_TIMESTAMP,
    });
    this.stopConnectionRetry();
    this.stopBackgroundPuller();
    // Close any open connection-flow modal so a plugin reload/update cannot
    // orphan the overlay. Closing it cancels the flow (see connect-flow.ts).
    if (this.activeConnectModal) {
      this.activeConnectModal.finishFlow("plugin-unload");
      this.activeConnectModal = null;
    }
    // Remove focus and connectivity listeners
    if (this.boundVisibilityHandler) {
      document.removeEventListener("visibilitychange", this.boundVisibilityHandler);
      this.boundVisibilityHandler = null;
    }
    if (this.boundWindowFocusHandler) {
      window.removeEventListener("focus", this.boundWindowFocusHandler);
      this.boundWindowFocusHandler = null;
    }
    if (this.boundOnlineHandler) {
      window.removeEventListener("online", this.boundOnlineHandler);
      this.boundOnlineHandler = null;
    }
    if (this.boundUnhandledRejectionHandler) {
      window.removeEventListener("unhandledrejection", this.boundUnhandledRejectionHandler);
      this.boundUnhandledRejectionHandler = null;
    }
    // Flush pending changes on close
    if (this.syncQueue) {
      await this.syncQueue.flushNow();
    }
  }

  async loadSettings(): Promise<void> {
    const saved = ((await this.loadData()) ?? {}) as Partial<PluginSettings>;
    const configDir = this.app.vault.configDir;
    const protectedForVault = getProtectedExcludes(configDir);
    // Migrate legacy ".obsidian" patterns to the current configDir so custom
    // config folder installs do not sync plugin logs/trash after moving.
    const migratePattern = (p: string): string =>
      configDir !== ".obsidian" && p.startsWith(".obsidian/")
        ? `${configDir}${p.slice(".obsidian".length)}`
        : p;
    const savedExcludesRaw: string[] = Array.isArray(saved.excludePatterns) ? saved.excludePatterns : [];
    const savedExcludes = savedExcludesRaw.map(migratePattern);
    const mergedExcludes = [...new Set([...savedExcludes, ...protectedForVault])];
    // Use configDir-aware defaults so fresh installs on custom config folders
    // start with correct exclusions; saved values take precedence via Object.assign.
    const baseDefaults = configDir !== ".obsidian" ? buildDefaultSettings(configDir) : DEFAULT_SETTINGS;
    this.settings = Object.assign({}, baseDefaults, saved, {
      excludePatterns: mergedExcludes,
    });
    const beforeInterval = this.settings.syncIntervalMs;
    const beforeFlag = this.settings.syncDebounceMigrated === true;
    // One-shot only: an untouched factory 3000 becomes 1000. After the flag is
    // set, 3000 on the slider is a real user choice and must survive reloads
    // (loadSettings also runs on focus / connection retry).
    if (!beforeFlag && beforeInterval === LEGACY_SYNC_DEBOUNCE_MS) {
      this.settings.syncIntervalMs = SYNC_DEBOUNCE_MS;
    }
    this.settings.syncIntervalMs = clampDebounceMs(this.settings.syncIntervalMs);
    this.settings.syncDebounceMigrated = true;
    if (
      this.settings.syncIntervalMs !== beforeInterval ||
      beforeFlag !== true
    ) {
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Persist debounce and apply it to the running queue immediately. */
  async setSyncIntervalMs(ms: number): Promise<void> {
    this.settings.syncIntervalMs = clampDebounceMs(ms);
    this.syncQueue?.setDebounceMs(this.settings.syncIntervalMs);
    await this.saveSettings();
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /** Track the active connection-flow modal so it can be closed on unload. */
  setActiveConnectModal(modal: GitHubConnectModal | null): void {
    this.activeConnectModal = modal;
  }

  /**
   * True when GitHub authorization is persisted but no repository has been
   * chosen yet — the resumable "pending setup" state. Derived from the saved
   * settings (token + username without repoName); legacy data always stored
   * all three together, so no migration is needed.
   */
  hasPendingSetup(): boolean {
    const { githubToken, githubUsername, repoName } = this.settings;
    return Boolean(githubToken && githubUsername && !repoName);
  }

  /**
   * Persist the granted OAuth authorization immediately after the device flow
   * succeeds — before any repository decision. Ensures a dismissed picker,
   * plugin reload or failed setup never costs the user a browser
   * re-authorization. `repoName` stays empty until initializeRepo completes.
   */
  async stageCredentials(token: string, username: string): Promise<void> {
    this.settings.githubToken = token;
    this.settings.githubUsername = username;
    await this.saveSettings();
    await this.logger.info(
      "connection.staged",
      "GitHub authorization persisted (repository selection pending)",
      { hasToken: Boolean(token), username }
    );
  }

  /**
   * Leave the connecting state without marking anything as failed — used when
   * the user defers repository selection after a successful authorization.
   * Unlike abortConnection, the status bar returns to idle, not error.
   */
  async pauseConnectionSetup(): Promise<void> {
    this.connectionState = "disconnected";
    this.setStatus("idle");
    await this.logger.info(
      "connection.deferred",
      "Connection setup deferred — authorization kept, repository not chosen yet"
    );
  }

  /**
   * Idempotent connection restore. Boots the sync engine when saved
   * credentials exist and no engine is running yet. Safe to call repeatedly
   * (onload, onLayoutReady, retry timer, settings display).
   */
  async ensureConnected(): Promise<boolean> {
    if (this.connectionState === "connecting") return false;
    if (this.gitSync) return true;

    const { githubToken, githubUsername, repoName } = this.settings;
    if (!githubToken || !githubUsername || !repoName) return false;

    // Another instance is still performing repository setup (git init/clone/
    // push). Wait for it to finish before booting so we never touch the same
    // .git concurrently. If it stalled (e.g. the app was killed mid-setup),
    // fall through after a staleness timeout so the connection still recovers.
    if (this.settings.setupInProgress) {
      const stale =
        this.settings.setupStartedAt &&
        Date.now() - this.settings.setupStartedAt > 180_000;
      if (!stale) return false;
    }

    this.connectionState = "connecting";
    this.setStatus("connecting");
    await this.logger.info("connection.restore", "Restoring saved connection");
    try {
      await this.bootSyncEngine();
      this.connectionState = this.gitSync ? "connected" : "disconnected";
      await this.logger.info("connection.restore", "Saved connection restored", {
        ready: Boolean(this.gitSync && this.syncQueue),
      });
      if (this.connectionState === "connected" && this.settingsTab?.isDisplayed) {
        this.settingsTab.display();
      }
      if (this.connectionState === "connected") {
        this.startBackgroundPuller();
      }
      return this.connectionState === "connected";
    } catch (error) {
      this.connectionState = "disconnected";
      await this.logger.error("connection.restore", "Saved connection could not be restored", error);
      return false;
    }
  }

  /**
   * Poll for a saved connection that may be persisted shortly after this
   * instance loaded (e.g. a plugin reload during the OAuth/repo-setup flow).
   * Each attempt re-reads settings from disk so credentials saved by a
   * previous (replaced) instance are picked up, then waits for that instance
   * to finish repository setup before booting the engine. Stops once connected
   * or after a bounded number of attempts (covers GitHub device-code expiry).
   */
  private startConnectionRetry(): void {
    if (this.ensureConnectedTimer !== null) return;
    let attempts = 0;
    const MAX_ATTEMPTS = 240;
    this.ensureConnectedTimer = this.registerInterval(
      window.setInterval(() => {
        void (async () => {
          attempts += 1;
          if (attempts >= MAX_ATTEMPTS || this.connectionState === "connected") {
            this.stopConnectionRetry();
            return;
          }
          if (this.connectionState !== "disconnected") return;
          await this.loadSettings();
          const connected = await this.ensureConnected();
          if (connected) {
            this.stopConnectionRetry();
            if (this.gitSync) {
              this.setStatus("pulling");
              await this.runPull("late-connect");
            }
          }
        })();
      }, 4000)
    );
  }

  private stopConnectionRetry(): void {
    if (this.ensureConnectedTimer !== null) {
      window.clearInterval(this.ensureConnectedTimer);
      this.ensureConnectedTimer = null;
    }
  }

  beginConnection(): boolean {
    if (this.connectionState === "connecting") return false;
    this.connectionState = "connecting";
    this.setStatus("connecting");
    void this.logger.info("connection.start", "Connection attempt started");
    return true;
  }

  async disconnect(): Promise<void> {
    this.stopConnectionRetry();
    this.stopBackgroundPuller();
    this.gitSync = null;
    this.syncQueue = null;
    this.connectionState = "disconnected";
    this.settings.githubToken = "";
    this.settings.githubUsername = "";
    this.settings.repoName = "";
    this.settings.setupInProgress = false;
    await this.saveSettings();
    await this.logger.info("connection.disconnect", "GitHub connection removed");
  }

  async abortConnection(error?: unknown): Promise<void> {
    this.connectionState = "disconnected";
    this.setStatus("error", "Connection failed");
    const info = error !== undefined ? errorInfo(error) : undefined;
    await this.logger.error(
      "connection.aborted",
      "Connection attempt aborted",
      error,
      info ? { code: info.code } : undefined
    );
  }

  async clearDebugLog(): Promise<void> {
    await this.logger.clear();
    await this.logger.info("debug.clear", "Debug log cleared");
  }

  getDebugLogPath(): string {
    return this.logger.path;
  }

  /** Write a warning to the debug log from UI code that lacks logger access. */
  async logWarning(stage: string, message: string, context?: Record<string, unknown>): Promise<void> {
    await this.logger.warn(stage, message, context);
  }

  /** Write an info trace to the debug log from UI code that lacks logger access. */
  async logInfo(stage: string, message: string, context?: Record<string, unknown>): Promise<void> {
    await this.logger.info(stage, message, context);
  }

  /** Last N log lines, for the diagnostics snapshot. */
  async getLogTail(maxLines = 150): Promise<string> {
    return this.logger.readTail(maxLines);
  }

  /**
   * Diagnostic: enumerate sibling installs of this plugin. Multiple live
   * instances (a legacy `git-obsi-sync` copy beside the current one, or two
   * copies of the same id) produce exactly the "settings revert to the old
   * UI" and double-sync-engine symptoms.
   */
  private async traceSiblingInstalls(): Promise<void> {
    const pluginsRoot = `${this.app.vault.configDir}/plugins`;
    try {
      const listing = await this.app.vault.adapter.list(pluginsRoot);
      const family: { folder: string; id: string; version: string }[] = [];
      for (const folder of listing.folders) {
        const name = folder.split("/").pop() ?? folder;
        try {
          const raw = await this.app.vault.adapter.read(`${pluginsRoot}/${name}/manifest.json`);
          const manifest = JSON.parse(raw) as { id?: string; version?: string };
          if (manifest.id === PLUGIN_ID || manifest.id === LEGACY_PLUGIN_ID || manifest.id === LEGACY_PLUGIN_ID_OLD) {
            family.push({ folder: name, id: manifest.id ?? "(unknown)", version: manifest.version ?? "?" });
          }
        } catch {
          // Not a plugin folder or unreadable manifest — not our concern.
        }
      }

      if (family.length > 1) {
        await this.logger.warn("install.audit", "Multiple installs of this plugin detected", {
          count: family.length,
          installs: family,
        });
        new Notice(
          `Ultimate Vault Sync: ${family.length} copies installed (${family
            .map((f) => f.folder)
            .join(", ")}). Remove the old copy — duplicate instances cause settings reverting to the old UI and sync errors.`,
          10000
        );
      } else if (family.length === 1) {
        await this.logger.info("install.audit", "Single install detected", { install: family[0] });
      } else {
        await this.logger.warn("install.audit", "No recognizable install folder found", { pluginsRoot });
      }
    } catch (error) {
      await this.logger.warn("install.audit", "Install audit failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Diagnostic: watch this plugin's own main.js for on-disk replacement while
   * running (BRAT/sync-service clobber). One Notice + ERROR entry per
   * replacement event; the new fingerprint is adopted so events don't repeat.
   */
  private startSelfFileWatcher(): void {
    if (this.selfFileWatcherTimer !== null) return;
    const tick = async (): Promise<void> => {
      try {
        const selfPath = `${this.app.vault.configDir}/plugins/${PLUGIN_ID}/main.js`;
        if (!(await this.app.vault.adapter.exists(selfPath))) return;
        const content = await this.app.vault.adapter.read(selfPath);
        let checksum = 0;
        for (let i = 0; i < content.length; i += 997) {
          checksum = (checksum + content.charCodeAt(i)) % 4294967296;
        }
        const fingerprint = `${content.length}:${checksum}`;
        if (this.selfFileFingerprint === null) {
          this.selfFileFingerprint = fingerprint;
          await this.logger.info("self.fileWatch", "Baseline captured", { fingerprint });
          return;
        }
        if (fingerprint !== this.selfFileFingerprint) {
          const previous = this.selfFileFingerprint;
          this.selfFileFingerprint = fingerprint;
          await this.logger.error(
            "self.fileChanged",
            "Plugin main.js was replaced on disk while running",
            undefined,
            { previous, current: fingerprint }
          );
          new Notice(
            "Ultimate Obsidian Sync files were replaced on disk (sync tool or updater). Restart Obsidian to load them.",
            10000
          );
        }
      } catch (error) {
        await this.logger.warn("self.fileWatch", "Watcher tick failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    void tick();
    this.selfFileWatcherTimer = this.registerInterval(
      window.setInterval(() => {
        void tick();
      }, 30000)
    );
  }

  setStatus(status: SyncStatus, detail?: string): void {
    this.statusBar.set(status, detail);
  }

  /**
   * Called after the user connects their GitHub account and confirms which
   * repository to use. Determines whether to clone (existing repo) or
   * init+push (new repo).
   *
   * `options.resetLocalFirst` wipes any partial local .git before starting —
   * used by setup retries so an interrupted clone/init can never be mistaken
   * for a completed one.
   */
  async initializeRepo(
    token: string,
    username: string,
    repoName: string,
    options: { resetLocalFirst?: boolean } = {}
  ): Promise<void> {
    const previousSettings: PluginSettings = {
      ...this.settings,
      excludePatterns: [...this.settings.excludePatterns],
      includePatterns: [...this.settings.includePatterns],
    };
    const previousGitSync = this.gitSync;
    const previousSyncQueue = this.syncQueue;
    const previousConnectionState = this.connectionState;
    // Detach the running engine for the duration of the setup so auto-sync can
    // never push to the OLD repository while a switch is in progress. The
    // queue is suspended (not discarded) because its own debounce/retry
    // timers would otherwise still target the old repo; both are restored on
    // failure below and bootSyncEngine recreates them on success.
    previousSyncQueue?.suspend();
    this.gitSync = null;
    this.syncQueue = null;
    this.connectionState = "connecting";
    this.setStatus("connecting");
    const startedAt = performance.now();

    try {
      const vaultName = this.app.vault.getName();
      repoName = repoName.trim();
      if (!repoName) throw new Error("Repository name cannot be empty.");

      // Persist credentials immediately so a plugin reload during the slow
      // repository setup (OAuth round-trip on mobile) can restore the
      // connection. Rolled back to previousSettings on failure below.
      this.settings.githubToken = token;
      this.settings.githubUsername = username;
      this.settings.repoName = repoName;
      // Mark setup as in progress so a reloaded instance waits for this
      // repository setup (git init/clone/push) to finish before booting its
      // engine — otherwise two instances could touch the same .git concurrently.
      this.settings.setupInProgress = true;
      this.settings.setupStartedAt = Date.now();
      await this.saveSettings();

      await this.logger.info("connection.repo", "Repository setup started", {
        hasToken: Boolean(token),
        hasUsername: Boolean(username),
        hasRepo: Boolean(repoName),
      });

      const adapter = this.app.vault.adapter;
      // Obsidian exposes basePath on FileSystemAdapter (desktop). On mobile the vault
      // root is the adapter itself, so we fall back to an empty string which causes
      // isomorphic-git to use relative paths from the adapter root.
      const vaultPath = this.getVaultPath(adapter);

      const sync = new GitSync(adapter, vaultPath, token, username, repoName, this.settings.commitMessageTemplate, this.logger);

      // If a previous connection left a local .git pointing at a different repo
      // (e.g. the user disconnected and then connected to another repository),
      // reset it so the clone/init+push branches below run against the chosen
      // repo instead of silently pushing to the old remote.
      const matchesRemote = await sync.remoteMatches(repoName);
      await this.logger.info("connection.repo", "Local origin checked", { matchesRemote });
      if (!matchesRemote) {
        await sync.resetLocal();
      }

      // A retry after a failed setup must never inherit a partial .git (e.g.
      // an interrupted clone with a valid HEAD): wipe it and start clean.
      if (options.resetLocalFirst) {
        await sync.resetLocal();
        await this.logger.info("connection.repo", "Local .git reset for setup retry");
      }

      const exists      = await repoExists(token, username, repoName);
      await this.logger.info("connection.repo", "Remote repository checked", { exists });
      const alreadyInit = await sync.isInitialized();
      await this.logger.info("connection.repo", "Local repository checked", { alreadyInit });

      const allFiles = () =>
        this.app.vault
          .getFiles()
          .map((f) => f.path)
          .filter((p) => this.shouldSync(p));

      if (!exists) {
        // Brand-new vault — create repo and push everything
        await createRepo(token, repoName, `Obsidian vault: ${vaultName}`);
        await sync.initAndPush(allFiles());
        new Notice(`Created private repo: ${username}/${repoName}`);
      } else if (!alreadyInit) {
        // Repo exists remotely and this device has no local git history yet.
        // Decide replace vs init+push based on whether the remote has content.
        const hasRemoteCommits = await repoHasCommits(token, username, repoName);
        await this.logger.info("connection.repo", "Remote commit state checked", { hasRemoteCommits });
        if (hasRemoteCommits) {
          // Remote has content — REPLACE semantics: the repository becomes the
          // source of truth, device content moves to a dated backup folder,
          // and real failures propagate to the user.
          await this.replaceVaultWithRepository(sync);
          new Notice(`Replaced vault with repo: ${username}/${repoName}`);
        } else {
          // Remote exists but is empty (created earlier, never pushed) — create
          // the first commit locally and push it.
          await sync.initAndPush(allFiles());
          new Notice(`Initialised repo: ${username}/${repoName}`);
        }
      } else {
        // Already initialised locally — ensure remote URL is current, then reconnect.
        // Also handles the case where a previous push was interrupted (local branch
        // exists but remote is empty): ensureLocalBranch will push on next sync.
        new Notice(`Reconnected to: ${username}/${repoName}`);
      }

      // Commit credentials only after repository setup has succeeded.
      this.settings.githubToken = token;
      this.settings.githubUsername = username;
      this.settings.repoName = repoName;
      this.settings.lastSyncTime = Date.now();
      this.settings.lastSyncOutcome = {
        status: "ok",
        message: "Connected",
        timestamp: Date.now(),
      };
      this.settings.setupInProgress = false;
      await this.saveSettings();
      await this.bootSyncEngine();
      this.connectionState = "connected";
      this.setStatus("idle");
      this.startBackgroundPuller();
      await this.logger.info("connection.ready", "Connection established", {
        ready: Boolean(this.gitSync && this.syncQueue),
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      this.settings = previousSettings;
      this.gitSync = previousGitSync;
      this.syncQueue = previousSyncQueue;
      previousSyncQueue?.resume();
      this.connectionState = previousConnectionState === "connected" && previousGitSync
        ? "connected"
        : "disconnected";
      // Restore the status bar to match the rolled-back state — a failed
      // switch leaves the user CONNECTED to the previous repository, never
      // stuck on "connecting". (First-connect failures get the error status
      // from the caller's abortConnection.)
      if (this.connectionState === "connected") {
        this.setStatus("idle");
      }
      // Persist the rollback so a later reload does not restore the failed
      // connection from stale on-disk credentials.
      await this.saveSettings();
      await this.logger.error("connection.failed", "Repository setup failed", error, {
        connectionState: this.connectionState,
        hasGitSync: Boolean(this.gitSync),
        code: errorInfo(error).code,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      throw error;
    }
  }

  /**
   * Rename the connected repository on GitHub (server-side PATCH) and
   * re-point this vault at it. History, issues and stars are preserved and
   * GitHub redirects the old URL to the new one, so other devices keep
   * syncing without any change.
   *
   * Throws with a user-friendly message when the name is invalid, unchanged,
   * or already taken — the caller (rename modal) surfaces it inline.
   */
  async renameRepository(newName: string): Promise<void> {
    const { githubToken, githubUsername, repoName } = this.settings;
    if (this.connectionState !== "connected" || !this.gitSync) {
      throw new Error("Not connected. Connect your GitHub account first.");
    }
    if (!githubToken || !githubUsername || !repoName) {
      throw new Error("Not connected. Connect your GitHub account first.");
    }

    const trimmed = newName.trim();
    const validationError = validateRepoName(trimmed);
    if (validationError) throw new Error(validationError);
    if (trimmed === repoName) {
      throw new Error("The repository already has this name.");
    }

    // Friendly pre-check: the PATCH would fail with a 422 on a taken name.
    if (await repoExists(githubToken, githubUsername, trimmed)) {
      throw new Error(
        `A repository named "${trimmed}" already exists on your account. Choose a different name.`
      );
    }

    await this.logger.info("connection.rename", "Repository rename started", {
      from: repoName,
      to: trimmed,
    });

    // Single irreversible step — everything after it is local bookkeeping.
    await renameRepo(githubToken, githubUsername, repoName, trimmed);

    this.settings.repoName = trimmed;
    await this.saveSettings();

    // Best-effort local origin rewrite; GitHub's old→new redirect covers any
    // gap, so a failure here never costs data.
    await this.gitSync.renameRemote(trimmed);

    await this.logger.info("connection.rename", "Repository renamed", {
      from: repoName,
      to: trimmed,
    });
  }

  /**
   * REPLACE flow phase 2 (vault preparation): move ALL device content into a
   * dated backup folder inside this plugin's directory, except protected
   * zones. Classification per file:
   *
   *   SKIP   .git/**, own plugin dir (**), active trash dir, .trash/**
   *   STASH  .obsidian/plugins/<other>/data.json  (device-local settings that
   *          never sync — restored verbatim after checkout)
   *          own main.js                          (prevents binary downgrade)
   *   MOVE   everything else → trash-<timestamp>/<original path>
   *
   * Per-file strategy: rename first; on failure fall back to binary-safe
   * copy+delete; if deletion also fails (locked file) the original is left in
   * place, logged, and reconciled by the next sync cycle.
   */
  private async replaceVaultWithRepository(sync: GitSync): Promise<void> {
    const adapter = this.app.vault.adapter;
    const configDir = this.app.vault.configDir;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const trashDir = `${configDir}/plugins/${PLUGIN_ID}/trash-${stamp}`;
    const ownDir = `${configDir}/plugins/${PLUGIN_ID}`;
    const ownMainPath = `${ownDir}/main.js`;
    const escapedConfigDir = configDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stashPattern = new RegExp(`^${escapedConfigDir}/plugins/[^/]+/data\\.json$`);

    const isProtected = (p: string): boolean =>
      p === ".git" || p.startsWith(".git/") ||
      p === ".trash" || p.startsWith(".trash/") ||
      p === trashDir || p.startsWith(trashDir + "/") ||
      p === ownDir || p.startsWith(ownDir + "/");

    const stash = new Map<string, string>();
    const movedPairs: Array<{ from: string; to: string }> = [];
    const leftovers: string[] = [];

    const ensureParentsOf = async (fullRel: string): Promise<void> => {
      const segments = fullRel.split("/");
      segments.pop();
      let current = "";
      for (const segment of segments) {
        current = current ? `${current}/${segment}` : segment;
        try {
          await adapter.mkdir(current);
        } catch { /* already exists */ }
      }
    };

    const moveFileToTrash = async (filePath: string): Promise<void> => {
      const to = `${trashDir}/${filePath}`;
      await ensureParentsOf(to);
      try {
        await adapter.rename(filePath, to);
        movedPairs.push({ from: filePath, to });
      } catch {
        // Locked or un-renameable — copy (binary-safe), then delete.
        const buffer = await adapter.readBinary(filePath);
        await adapter.writeBinary(to, buffer);
        try {
          await adapter.remove(filePath);
          movedPairs.push({ from: filePath, to });
        } catch {
          leftovers.push(filePath);
        }
      }
    };

    const walk = async (rel: string): Promise<void> => {
      const listing = await adapter.list(rel === "" ? "/" : rel);
      // Normalize defensively: protection checks compare against slash-less
      // vault-relative paths; never let a platform variant bypass them.
      const norm = (p: string): string => (p.startsWith("/") ? p.slice(1) : p);
      for (const filePath of listing.files.map(norm)) {
        if (isProtected(filePath)) continue;
        if (stashPattern.test(filePath)) {
          stash.set(filePath, await adapter.read(filePath));
          continue;
        }
        await moveFileToTrash(filePath);
      }
      for (const rawFolder of listing.folders.map(norm)) {
        if (isProtected(rawFolder)) continue;
        await walk(rawFolder);
        // Non-recursive: only an emptied folder may be removed. Recursive
        // cleanup would delete PROTECTED subtrees (e.g. this plugin's own
        // directory containing data.json/logs/backups) skipped during the walk.
        await adapter.rmdir(rawFolder, false).catch(() => undefined);
      }
    };

    let ownMainSnapshot: string | null = null;
    let ownDataSnapshot: string | null = null;
    try {
      await sync.cloneNoCheckout();

      // Snapshot own build AND credentials — the repo may track older copies
      // of either, and force-checkout would overwrite them on disk.
      try {
        if (await adapter.exists(ownMainPath)) ownMainSnapshot = await adapter.read(ownMainPath);
        const ownDataPath = `${ownDir}/data.json`;
        if (await adapter.exists(ownDataPath)) ownDataSnapshot = await adapter.read(ownDataPath);
      } catch { /* treat as absent */ }

      await walk("/");

      await sync.checkoutForce();

      // Restore stashed device-local settings and own build over anything the
      // checkout wrote to those paths.
      let stashRestored = 0;
      for (const [p, content] of stash) {
        try {
          let current: string | null = null;
          try { current = await adapter.read(p); } catch { current = null; }
          if (current !== content) {
            await adapter.write(p, content);
            stashRestored += 1;
          }
        } catch { /* best-effort */ }
      }
      if (ownMainSnapshot !== null) {
        try {
          let current: string | null = null;
          try { current = await adapter.read(ownMainPath); } catch { current = null; }
          if (current !== ownMainSnapshot) {
            await adapter.write(ownMainPath, ownMainSnapshot);
            stashRestored += 1;
            await this.logger.info("connection.replace", "Restored newer plugin build over repository copy");
          }
        } catch { /* best-effort */ }
      }
      if (ownDataSnapshot !== null) {
        try {
          let current: string | null = null;
          try { current = await adapter.read(`${ownDir}/data.json`); } catch { current = null; }
          if (current !== ownDataSnapshot) {
            await adapter.write(`${ownDir}/data.json`, ownDataSnapshot);
            await this.logger.info("connection.replace", "Restored plugin credentials over repository copy");
          }
        } catch { /* best-effort */ }
      }

      // Force-checkout rewrote tracked plugin files — re-baseline the watcher
      // so the expected swap isn't reported as external tampering.
      this.selfFileFingerprint = null;

      await this.logger.info("connection.replace", "Vault replaced with repository", {
        movedToBackup: movedPairs.length,
        leftInPlace: leftovers.length,
        stashRestored,
        trashDir,
      });
      if (leftovers.length > 0) {
        await this.logger.warn("connection.replace", "Some locked files stayed in place", {
          count: leftovers.length,
          files: leftovers.slice(0, 20),
        });
      }
    } catch (error) {
      // Best-effort restoration: undo completed moves, re-write stashed
      // settings and own plugin files, then surface the original failure
      // through normal rollback.
      for (const pair of [...movedPairs].reverse()) {
        try {
          await ensureParentsOf(pair.from);
          await adapter.rename(pair.to, pair.from);
        } catch { /* keep the backup copy */ }
      }
      for (const [p, content] of stash) {
        try { await adapter.write(p, content); } catch { /* best-effort */ }
      }
      if (ownMainSnapshot !== null) {
        try { await adapter.write(ownMainPath, ownMainSnapshot); } catch { /* best-effort */ }
      }
      if (ownDataSnapshot !== null) {
        try { await adapter.write(`${ownDir}/data.json`, ownDataSnapshot); } catch { /* best-effort */ }
      }
      await this.logger.error(
        "connection.replace",
        "Vault replacement failed — best-effort restore applied",
        error,
        { movedBack: movedPairs.length, trashDir }
      );
      throw error;
    }
  }

  async bootSyncEngine(): Promise<void> {
    const { githubToken, githubUsername, repoName } = this.settings;
    if (!githubToken || !githubUsername || !repoName) {
      await this.logger.warn("engine.boot", "Sync engine not booted because settings are incomplete", {
        hasToken: Boolean(githubToken),
        hasUsername: Boolean(githubUsername),
        hasRepo: Boolean(repoName),
      });
      return;
    }

    const adapter = this.app.vault.adapter;
    const vaultPath = this.getVaultPath(adapter);

    this.gitSync = new GitSync(
      adapter,
      vaultPath,
      githubToken,
      githubUsername,
      repoName,
      this.settings.commitMessageTemplate,
      this.logger
    );

    this.syncQueue = new SyncQueue(
      this.gitSync,
      (status, detail) => {
        const info = status === "error" && detail ? errorInfo(detail) : undefined;
        // Show a friendly message (not raw API/git text) in the status bar.
        this.setStatus(status, info ? info.message : detail);
        const now = Date.now();
        if (status === "idle") {
          this.settings.lastSyncTime = now;
          this.settings.lastSyncOutcome = { status: "ok", timestamp: now };
          void this.saveSettings();
        } else if (status === "conflict") {
          this.settings.lastSyncOutcome = {
            status: "conflict",
            message: detail ?? "Conflicting changes detected",
            timestamp: now,
          };
          void this.saveSettings();
        } else if (status === "error") {
          this.settings.lastSyncOutcome = {
            status: "error",
            message: detail,
            ...(info ? { code: info.code } : {}),
            timestamp: now,
          };
          void this.saveSettings();
        }
      },
      this.settings.syncIntervalMs,
      this.logger,
      (files) => {
        this.showConflictModal(files);
      },
      (files) => {
        new Notice(
          `Ultimate Vault Sync: ${files.length} file(s) could not be synced after retries. Check the debug log.`
        );
      }
    );
    await this.logger.info("engine.boot", "Sync engine ready");
  }

  async triggerManualSync(): Promise<void> {
    await this.logger.info("manual-sync.requested", "Manual sync requested", {
      connectionState: this.connectionState,
      hasGitSync: Boolean(this.gitSync),
    });
    if (this.connectionState === "connecting") {
      await this.logger.warn("manual-sync.rejected-not-ready", "Manual sync rejected while connection is initializing");
      new Notice("Connection is still being set up. Please wait.");
      return;
    }
    if (this.connectionState !== "connected" || !this.gitSync) {
      await this.logger.warn("manual-sync.rejected-disconnected", "Manual sync rejected because no sync engine exists");
      new Notice(
        "Ultimate Vault Sync: not connected. Please connect your GitHub account in settings."
      );
      return;
    }

    this.setStatus("pulling");
    try {
      const pullResult = await this.runPull("manual", { healStaleWorktree: true });
      if (pullResult.status === "error") {
        // Mirror the previous behavior: a failed pre-pull aborts the manual
        // sync cycle with the standard failure notice.
        const info = errorInfo(pullResult.errorMessage ?? "");
        new Notice(`Sync failed: ${info.message}${info.action ? ` ${info.action}` : ""}`);
        return;
      }
      if (pullResult.status === "conflict") {
        // The conflict modal is already open via runPull. Continuing would
        // stage conflict-marker content into a garbage merge commit.
        return;
      }

      const allFiles = this.app.vault
        .getFiles()
        .map((f) => f.path)
        .filter((p) => this.shouldSync(p));

      const result = await this.gitSync.sync(allFiles);
      await this.logger.info("manual-sync.complete", "Manual sync completed", {
        success: result.success,
        conflicts: result.conflictFiles.length,
        error: result.error,
      });

      if (result.conflictFiles.length > 0) {
        this.setStatus("conflict");
        this.settings.lastSyncOutcome = {
          status: "conflict",
          message: `${result.conflictFiles.length} conflicted file(s)`,
          timestamp: Date.now(),
        };
        await this.saveSettings();
        this.showConflictModal(result.conflictFiles);
      } else if (result.success) {
        this.settings.lastSyncTime = Date.now();
        this.settings.lastSyncOutcome = { status: "ok", timestamp: Date.now() };
        await this.saveSettings();
        this.setStatus("idle");
        new Notice("Vault synced successfully.");
      } else {
        const info = errorInfo(result.error ?? "");
        this.setStatus("error", info.message);
        this.settings.lastSyncOutcome = {
          status: "error",
          message: result.error,
          code: info.code,
          timestamp: Date.now(),
        };
        await this.saveSettings();
        new Notice(`Sync error: ${info.message}${info.action ? ` ${info.action}` : ""}`);
      }
    } catch (err) {
      const info = errorInfo(err);
      await this.logger.error("manual-sync.failed", "Manual sync failed", err, {
        code: info.code,
      });
      this.setStatus("error", info.message);
      new Notice(`Sync failed: ${info.message}${info.action ? ` ${info.action}` : ""}`);
    }
  }

  /**
   * Single funnel for every pull trigger (open, late-connect, manual, focus,
   * background poll, network-online). Normalizes logging, status-bar feedback
   * and conflict surfacing so no trigger can bypass the conflict UI.
   *
   * Never throws: failures are logged and reported through the returned
   * PullResult plus the status bar.
   */
  private async runPull(
    reason: "open" | "late-connect" | "manual" | "focus" | "poll" | "online",
    opts: { healStaleWorktree?: boolean } = {}
  ): Promise<PullResult> {
    if (!this.gitSync) return { status: "upToDate" };
    let result: PullResult;
    try {
      result = await this.gitSync.pull(opts);
    } catch (error) {
      const info = errorInfo(error);
      void this.logger.error(`pull.${reason}`, "Pull failed", error);
      this.setStatus("error", info.message);
      return { status: "error", errorMessage: info.message };
    }

    switch (result.status) {
      case "applied":
        this.settings.lastSyncTime = Date.now();
        this.settings.lastSyncOutcome = { status: "ok", timestamp: Date.now() };
        void this.saveSettings();
        this.setStatus("idle");
        break;
      case "conflict": {
        const paths = result.conflictPaths ?? [];
        this.setStatus("conflict");
        this.settings.lastSyncOutcome = {
          status: "conflict",
          message: `${paths.length} conflicted file(s)`,
          timestamp: Date.now(),
        };
        void this.saveSettings();
        await this.surfacePullConflicts(paths);
        break;
      }
      case "deferred":
      case "upToDate":
        // Handled after the switch: only triggers that pre-set "pulling"
        // restore the resting state; background ticks stay silent.
        break;
    }
    if (
      (result.status === "upToDate" || result.status === "deferred") &&
      reason !== "poll" &&
      reason !== "online"
    ) {
      this.setStatus("idle");
    }
    return result;
  }

  /**
   * Show the standard conflict modal for paths reported by a pull. A dismissed
   * modal would otherwise be re-opened by every subsequent poll tick, so an
   * identical conflict set is suppressed for a bounded window; the status bar
   * stays on "conflict" meanwhile.
   */
  private async surfacePullConflicts(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const signature = [...paths].sort().join("\n");
    const now = Date.now();
    const sameAsLast =
      signature === this.lastPullConflictSignature &&
      now - this.lastPullConflictModalAt < PULL_CONFLICT_REPROMPT_MS;
    this.lastPullConflictSignature = signature;
    if (!sameAsLast) this.lastPullConflictModalAt = now;
    if (sameAsLast || this.conflictUiOpen) return;
    try {
      const files = this.gitSync ? await this.gitSync.buildConflictFiles(paths) : [];
      if (files.length > 0) this.showConflictModal(files);
    } catch (error) {
      void this.logger.warn("pull.conflict-ui", "Could not build conflict payloads", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Periodic background pull while connected — the missing trigger that made
   * the plugin feel push-only when two devices stayed open side by side.
   */
  private startBackgroundPuller(): void {
    this.stopBackgroundPuller();
    if (!this.settings.backgroundPullEnabled) return;
    if (this.connectionState !== "connected") return;
    const intervalMs = clampPullIntervalSec(this.settings.pullIntervalSec) * 1000;
    this.backgroundPullTimer = this.registerInterval(
      window.setInterval(() => {
        void this.backgroundPullTick();
      }, intervalMs)
    );
  }

  private stopBackgroundPuller(): void {
    if (this.backgroundPullTimer !== null) {
      window.clearInterval(this.backgroundPullTimer);
      this.backgroundPullTimer = null;
    }
  }

  private async backgroundPullTick(): Promise<void> {
    if (this.backgroundPullBusy) return;
    if (this.connectionState !== "connected" || !this.gitSync) return;
    if (!this.settings.backgroundPullEnabled) return;
    // Never fight an open conflict-resolution modal over the same files.
    if (this.conflictUiOpen) return;
    this.backgroundPullBusy = true;
    try {
      await this.runPull("poll");
    } finally {
      this.backgroundPullBusy = false;
    }
  }

  /** Live-apply background-pull settings (called from the settings tab). */
  applyBackgroundPullSettings(): void {
    if (
      this.connectionState === "connected" &&
      this.gitSync &&
      this.settings.backgroundPullEnabled
    ) {
      this.startBackgroundPuller();
    } else {
      this.stopBackgroundPuller();
    }
  }

  /** Persist pull interval and reschedule the poller immediately. */
  async setPullIntervalSec(sec: number): Promise<void> {
    this.settings.pullIntervalSec = clampPullIntervalSec(sec);
    await this.saveSettings();
    this.applyBackgroundPullSettings();
  }

  /** Persist the background-pull toggle and start/stop the poller. */
  async setBackgroundPullEnabled(enabled: boolean): Promise<void> {
    this.settings.backgroundPullEnabled = enabled;
    await this.saveSettings();
    this.applyBackgroundPullSettings();
  }

  private showConflictModal(conflicts: ConflictFile[]): void {
    if (this.conflictUiOpen || conflicts.length === 0) return;
    this.conflictUiOpen = true;
    const modal = new ConflictModal(
      this.app,
      conflicts,
      async (filepath, resolved) => {
        if (!this.gitSync) return;
        await this.gitSync.resolveConflict(filepath, resolved);
        this.settings.lastSyncTime = Date.now();
        this.settings.lastSyncOutcome = {
          status: "ok",
          message: "Conflict resolved",
          timestamp: Date.now(),
        };
        await this.saveSettings();
        this.setStatus("idle");
      }
    );
    modal.onClosed = () => {
      this.conflictUiOpen = false;
    };
    modal.open();
  }

  private setupFocusSync(): void {
    this.boundVisibilityHandler = () => {
      if (document.visibilityState !== "visible") return;
      this.focusLikePull();
    };
    document.addEventListener("visibilitychange", this.boundVisibilityHandler);

    // Desktop app switches keep document.visibilityState === "visible", so the
    // visibilitychange event alone misses most refocuses; window focus covers
    // them. Both share one guarded routine.
    this.boundWindowFocusHandler = () => {
      this.focusLikePull();
    };
    window.addEventListener("focus", this.boundWindowFocusHandler);
  }

  /**
   * Shared body of the visibilitychange / window-focus pull triggers.
   * `focusPulling` gives mutual exclusion between concurrent events; a short
   * cooldown folds the double-fire browsers emit on tab switches into one pull.
   */
  private focusLikePull(): void {
    if (this.focusPulling) return;
    const now = Date.now();
    if (now - this.lastFocusPullAt < FOCUS_PULL_COOLDOWN_MS) return;
    this.focusPulling = true;
    this.lastFocusPullAt = now;
    void (async () => {
      try {
        // If a connection was persisted while the window/tab was hidden
        // (e.g. another instance finished the OAuth/setup flow), pick it up
        // the moment the user returns.
        if (!this.gitSync && this.connectionState === "disconnected") {
          await this.loadSettings();
          await this.ensureConnected();
        }
        if (this.gitSync && this.settings.syncOnFocus) {
          await this.runPull("focus");
        }
      } catch (error) {
        void this.logger.error("pull.focus", "Pull failed on focus", error);
        this.setStatus("error", "Pull failed on focus");
      } finally {
        this.focusPulling = false;
      }
    })();
  }

  /** Returns true if the file should be synced based on include/exclude patterns. */
  private shouldSync(filepath: string): boolean {
    if (matchesAnyGlob(filepath, getProtectedExcludes(this.app.vault.configDir))) return false;
    if (this.isExcluded(filepath)) return false;
    if (this.settings.includePatterns.length > 0 && !this.isIncluded(filepath)) return false;
    return true;
  }

  private isIncluded(filepath: string): boolean {
    return matchesAnyGlob(filepath, this.settings.includePatterns);
  }

  private isExcluded(filepath: string): boolean {
    return matchesAnyGlob(filepath, this.settings.excludePatterns);
  }

  /**
   * Single funnel for all vault auto-sync events. Counts into a 5s window
   * (logged by the interval registered in onload): `blocked` = guards rejected
   * the event (no engine / autoSync off), `filtered` = include/exclude patterns
   * rejected it, `enqueued` = accepted and handed to the sync queue.
   */
  private trackVaultEvent(
    type: "modify" | "create" | "delete" | "rename",
    filepath: string,
    oldPath?: string
  ): void {
    const path = oldPath ?? filepath;
    this.eventWindow[type]++;
    if (!this.syncQueue || !this.settings.autoSync) {
      this.eventWindow.blocked++;
      return;
    }
    if (!this.shouldSync(path)) {
      this.eventWindow.filtered++;
      return;
    }
    this.eventWindow.enqueued++;
    this.syncQueue.enqueue(path);
  }
}

/** Desktop FileSystemAdapter exposes basePath; DataAdapter does not. */
function adapterBasePath(adapter: DataAdapter): string {
  if (!("basePath" in adapter)) return "";
  const path = (adapter as DataAdapter & { basePath?: unknown }).basePath;
  return typeof path === "string" ? path : "";
}
