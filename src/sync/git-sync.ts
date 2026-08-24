import * as git from "isomorphic-git";
import type { HttpClient } from "isomorphic-git";
import { requestUrl, DataAdapter } from "obsidian";
import { createFsAdapter } from "./fs-adapter";
import { isPluginDataFile } from "./globs";
import {
  GIT_AUTHOR_NAME,
  GIT_AUTHOR_EMAIL,
  DEFAULT_BRANCH,
} from "../constants";
import { ConflictFile, SyncResult } from "../types";
import { DebugLogger } from "../debug/logger";
import { errorInfo } from "../debug/errors";

// Custom HTTP client that uses Obsidian's requestUrl (mobile-safe, bypasses CORS).
// Annotated as isomorphic-git's HttpClient so any signature drift fails HERE at
// the declaration instead of surfacing at every git.* call site.
const gitHttp: HttpClient = {
  async request({ url, method, headers, body }: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: AsyncIterableIterator<Uint8Array>;
  }) {
    let bodyBuffer: ArrayBuffer | undefined;
    if (body) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(chunk);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
      bodyBuffer = merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength);
    }

    const response = await requestUrl({
      url,
      method,
      headers,
      body: bodyBuffer,
      throw: false,
    });

    const arrayBuffer = response.arrayBuffer;
    async function* responseBody() {
      yield new Uint8Array(arrayBuffer);
    }

    const statusCode = response.status;
    return {
      url,
      method,
      statusCode,
      statusMessage: statusCode >= 200 && statusCode < 300 ? "OK" : String(statusCode),
      body: responseBody(),
      headers: { ...response.headers },
    };
  },
};

function looksBinary(text: string): boolean {
  return text.includes("\0");
}

/** Structured result of a pull attempt (see GitSync.pull). */
export interface PullResult {
  /** applied = remote commits merged into worktree; upToDate = nothing new. */
  status: "applied" | "upToDate" | "conflict" | "deferred" | "error";
  /** Conflicting paths when status is "conflict". */
  conflictPaths?: string[];
  /** Friendly error message when status is "error". */
  errorMessage?: string;
}

export class GitSync {
  private fs: ReturnType<typeof createFsAdapter>;
  private dir: string;
  private token: string;
  private username: string;
  private remoteUrl: string;
  private commitMessageTemplate: string;
  private logger?: DebugLogger;
  /**
   * Tail of the operation mutex. Every repo-mutating entry point (sync /
   * pull / resolveConflict) is chained onto this promise so background
   * pulls can never interleave index/ref writes with a running sync.
   */
  private opTail: Promise<unknown> = Promise.resolve();

  constructor(
    adapter: DataAdapter,
    vaultPath: string,
    token: string,
    username: string,
    repoName: string,
    commitMessageTemplate: string = "sync: {{datetime}}",
    logger?: DebugLogger
  ) {
    this.fs = createFsAdapter(adapter, vaultPath, logger);
    this.dir = vaultPath;
    this.token = token;
    this.username = username;
    this.remoteUrl = `https://github.com/${username}/${repoName}.git`;
    this.commitMessageTemplate = commitMessageTemplate;
    this.logger = logger;
  }

  /**
   * Serialize a repo-mutating task through one promise chain. Tasks run in
   * submission order; a rejection never breaks the chain (the tail swallows
   * it) and every caller still sees its own error.
   */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.opTail.then(task, task);
    this.opTail = run.catch(() => {});
    return run;
  }

  /** Base options shared by ALL git operations (local and network) */
  private gitOpts() {
    return {
      fs: this.fs,
      http: gitHttp,
      dir: this.dir,
      author: { name: GIT_AUTHOR_NAME, email: GIT_AUTHOR_EMAIL },
    };
  }

  /**
   * Extra options for NETWORK operations (push / fetch / clone).
   *
   * isomorphic-git strips credentials from remote URLs before sending requests.
   * We must supply them via `onAuth` so every push/fetch is authenticated.
   * We also pass `url` directly so the library does not have to read `.git/config`.
   */
  private netOpts() {
    const token = this.token;
    const username = this.username;
    return {
      ...this.gitOpts(),
      url: this.remoteUrl,
      onAuth: () => ({ username, password: token }),
      onAuthFailure: () => {
        throw new Error("GitHub authentication failed. Please reconnect your account in Ultimate Vault Sync settings.");
      },
    };
  }

  /**
   * Render a commit message template by replacing placeholders.
   * Supported: {{datetime}} → ISO datetime string.
   */
  private renderCommitMessage(template: string): string {
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    return template.replace(/\{\{datetime\}\}/g, now);
  }

  /** Path to the local .git directory, matching how isomorphic-git computes it. */
  private gitDirPath(): string {
    return this.dir ? `${this.dir.replace(/[\\/]+$/, "")}/.git` : ".git";
  }

  /** True when .git/HEAD exists and contains a valid symbolic ref or commit oid. */
  private async hasValidHeadFile(): Promise<boolean> {
    try {
      const content = await this.fs.promises.readFile(
        `${this.gitDirPath()}/HEAD`,
        { encoding: "utf8" }
      );
      const trimmed = String(content).trim();
      return /^ref:\s+refs\//.test(trimmed) || /^[0-9a-f]{40}$/i.test(trimmed);
    } catch {
      return false;
    }
  }

  /** Remove the local .git directory (used to clear a partial/broken repo). */
  private async removeGitDir(): Promise<void> {
    try {
      await this.fs.promises.rmdir(this.gitDirPath());
    } catch {
      /* nothing to remove */
    }
  }

  /**
   * Ensure a usable local .git exists. A partial .git left by an interrupted
   * clone (config present, HEAD missing/invalid) cannot be repaired by
   * git.init() — remove it so init/clone start from a clean state.
   */
  private async ensureHealthyRepo(): Promise<void> {
    let exists = false;
    try {
      await this.fs.promises.stat(this.gitDirPath());
      exists = true;
    } catch {
      /* no .git yet */
    }
    if (!exists) return;
    if (!(await this.hasValidHeadFile())) {
      await this.removeGitDir();
    }
  }

  /** Returns true if .git exists and HEAD resolves (repo is initialised) */
  async isInitialized(): Promise<boolean> {
    try {
      await git.resolveRef({ fs: this.fs, dir: this.dir, ref: "HEAD" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * True when the existing local .git points at the given repo (or when there
   * is no local .git / no origin to compare). Used to detect a stale local
   * repo left behind by a previous connection so it can be reset before
   * connecting to a different repository.
   */
  async remoteMatches(repoName: string): Promise<boolean> {
    let originUrl = "";
    try {
      originUrl = String(
        (await git.getConfig({
          fs: this.fs,
          dir: this.dir,
          path: "remote.origin.url",
        })) ?? ""
      );
    } catch {
      return true; // no .git — nothing to match
    }
    if (!originUrl) return true; // no origin recorded (e.g. setup interrupted before addRemote) — cannot prove a mismatch
    return (
      originUrl.endsWith(`/${repoName}.git`) || originUrl.endsWith(`/${repoName}`)
    );
  }

  /** Remove the local .git so the next init/clone starts from a clean state. */
  async resetLocal(): Promise<void> {
    await this.removeGitDir();
  }

  /**
   * Re-point the local repository at a renamed remote (server-side rename).
   * Updates the in-memory remote URL used by every network operation and
   * rewrites .git/config's origin so remoteMatches() stays accurate.
   * Best-effort: GitHub redirects the old URL, so a config-rewrite failure
   * only costs a stale local config — never data.
   */
  async renameRemote(newRepoName: string): Promise<void> {
    this.remoteUrl = `https://github.com/${this.username}/${newRepoName}.git`;
    try {
      await git.deleteRemote({ fs: this.fs, dir: this.dir, remote: "origin" });
    } catch { /* didn't exist yet */ }
    try {
      await git.addRemote({
        fs: this.fs,
        dir: this.dir,
        remote: "origin",
        url: this.remoteUrl,
      });
    } catch (error) {
      void this.logger?.warn("git.rename-remote", "Could not rewrite local origin after rename", {
        error: error instanceof Error ? error.message : String(error),
        code: errorInfo(error).code,
      });
    }
  }

  /**
   * Returns true if refs/heads/main exists (at least one commit has been made).
   * Returns false on a fresh git.init with no commits (unborn branch).
   */
  async hasLocalBranch(): Promise<boolean> {
    try {
      await git.resolveRef({ fs: this.fs, dir: this.dir, ref: DEFAULT_BRANCH });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fetch from origin.
   * - ok + oid: remote branch tip (merge this)
   * - ok + oid null: empty remote / no matching branch (push is safe)
   * - !ok: network/auth/protocol failure — do not push; do not pretend empty
   */
  private async safeFetch(): Promise<{ ok: true; oid: string | null } | { ok: false; error: string }> {
    try {
      const result = await git.fetch({
        ...this.netOpts(),
        remote: "origin",
        ref: DEFAULT_BRANCH,
        singleBranch: true,
      });

      if (result.fetchHead) {
        return { ok: true, oid: result.fetchHead };
      }

      try {
        const oid = await git.resolveRef({
          fs: this.fs,
          dir: this.dir,
          ref: `refs/remotes/origin/${DEFAULT_BRANCH}`,
        });
        return { ok: true, oid };
      } catch {
        return { ok: true, oid: null };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void this.logger?.warn("git.fetch", "Fetch failed", {
        error: message,
        code: errorInfo(error).code,
      });
      return { ok: false, error: message };
    }
  }

  /**
   * isomorphic-git fast-forward only moves the branch ref — it does not
   * update the working tree. Without checkout, vault files stay stale and
   * the next commit re-pushes old content over GitHub.
   */
  private async checkoutWorktree(): Promise<void> {
    await git.checkout({
      fs: this.fs,
      dir: this.dir,
      ref: DEFAULT_BRANCH,
      force: true,
    });
  }

  /** Merge remote into local main and write the result onto disk. */
  private async mergeIncoming(theirOid: string): Promise<void> {
    try {
      const mergeResult = await git.merge({
        fs: this.fs,
        dir: this.dir,
        ours: DEFAULT_BRANCH,
        theirs: theirOid,
        author: { name: GIT_AUTHOR_NAME, email: GIT_AUTHOR_EMAIL },
        message: "sync: merge remote changes",
        fastForwardOnly: false,
      });
      if (!mergeResult.alreadyMerged) {
        await this.checkoutWorktree();
      }
    } catch (error) {
      if (error instanceof git.Errors.MergeNotSupportedError) {
        throw new Error(
          "Unrelated histories: this device and GitHub do not share a common commit. Use Change repository and replace the vault, or connect a new empty repo."
        );
      }
      throw error;
    }
  }

  /**
   * Replace-flow phase 1: wipe local .git and fetch the remote (objects +
   * refs) WITHOUT touching any worktree file. The caller performs its vault
   * preparation between this and checkoutForce().
   */
  async cloneNoCheckout(): Promise<void> {
    await this.logger?.info("git.clone-replace", "Replace clone started (no checkout)");
    await this.resetLocal();
    try {
      await git.clone({
        ...this.netOpts(),
        singleBranch: true,
        depth: 1,
        noCheckout: true,
      });
    } catch (error) {
      await this.logger?.error("git.clone-replace", "Replace clone failed", error, {
        code: errorInfo(error).code,
      });
      throw error;
    }
  }

  /**
   * Replace-flow phase 3: force-write the repository's full tree into the
   * vault. Remote wins same-named files; the caller has already moved
   * device-only content to its backup location.
   */
  async checkoutForce(): Promise<void> {
    try {
      await git.checkout({
        fs: this.fs,
        dir: this.dir,
        ref: DEFAULT_BRANCH,
        force: true,
      });
      await this.logger?.info("git.clone-replace", "Force checkout completed");
    } catch (error) {
      await this.logger?.error("git.clone-replace", "Force checkout failed", error, {
        code: errorInfo(error).code,
      });
      throw error;
    }
  }

  /**
   * First-time setup: init locally (if needed), commit everything, push.
   * Safe to call on a partially-initialised repo (retry after failure).
   */
  async initAndPush(vaultFiles: string[]): Promise<void> {
    await this.logger?.info("git.init-push", "Initial repository push started", {
      fileCount: vaultFiles.length,
    });
    await this.ensureHealthyRepo();
    try {
      const alreadyInited = await this.isInitialized();
      if (!alreadyInited) {
        await git.init({ fs: this.fs, dir: this.dir, defaultBranch: DEFAULT_BRANCH });
        if (!(await this.hasValidHeadFile())) {
          throw new Error("Git initialization did not create a readable .git/HEAD file.");
        }
      }

      // Stage all vault files (skip any that fail)
      for (const file of vaultFiles) {
        if (isPluginDataFile(file)) continue;
        try {
          await git.add({ fs: this.fs, dir: this.dir, filepath: file });
        } catch {
          // Skip un-stageable files (binary, permission issues, etc.)
        }
      }

      const localBranchExists = await this.hasLocalBranch();
      if (!localBranchExists) {
        // First-ever commit — create it unconditionally so refs/heads/main is written
        // even when the vault is empty.
        await git.commit({
          ...this.gitOpts(),
          message: "sync: initial vault snapshot",
        });
      } else {
        // Subsequent call (retry) — only commit if something changed
        const status = await git.statusMatrix({ fs: this.fs, dir: this.dir });
        const dirty = status.some(([, h, w, s]) => h !== 1 || w !== 1 || s !== 1);
        if (dirty) {
          await git.commit({
            ...this.gitOpts(),
            message: "sync: initial vault snapshot",
          });
        }
      }

      // Set up remote (delete+re-add to ensure correct fetch refspec)
      try {
        await git.deleteRemote({ fs: this.fs, dir: this.dir, remote: "origin" });
      } catch { /* didn't exist yet */ }
      await git.addRemote({
        fs: this.fs,
        dir: this.dir,
        remote: "origin",
        url: this.remoteUrl,
      });

      await git.push({
        ...this.netOpts(),
        ref: DEFAULT_BRANCH,
        force: false,
      });
      await this.logger?.info("git.init-push", "Initial repository push completed");
    } catch (error) {
      await this.logger?.error("git.init-push", "Initial repository push failed", error, {
        code: errorInfo(error).code,
      });
      throw error;
    }
  }

  /**
   * Full sync cycle — runs on every file change and manual sync trigger.
   * Serialized against pull()/resolveConflict() via the op mutex.
   */
  async sync(changedFiles: string[]): Promise<SyncResult> {
    return this.exclusive(() => this.syncInner(changedFiles));
  }

  private async syncInner(changedFiles: string[]): Promise<SyncResult> {
    const conflicts: ConflictFile[] = [];
    let committed = false;
    let merged = false;
    let pushed = false;

    try {
      // A saved GitHub connection can outlive a mobile app's local .git state.
      // Repair partial metadata before any commit path can read a missing HEAD.
      await this.ensureHealthyRepo();
      if (!(await this.isInitialized())) {
        const error = new Error(
          "Local Git repository is not initialized. Reconnect this vault in Ultimate Vault Sync settings."
        );
        await this.logger?.error("git.sync", "Sync skipped because the local repository is not initialized", error);
        return { success: false, conflictFiles: [], error: error.message };
      }

      // ── 1. Stage only this cycle's files ─────────────────────────────────────
      // Do NOT commit the entire statusMatrix first. After a previous
      // fast-forward-without-checkout, every stale file looks dirty and a
      // full commit would snapshot the old vault on top of the remote tip.
      const changedSet = new Set(changedFiles);
      for (const file of changedFiles) {
        if (isPluginDataFile(file)) continue;
        try {
          await git.add({ fs: this.fs, dir: this.dir, filepath: file });
        } catch {
          try {
            await git.remove({ fs: this.fs, dir: this.dir, filepath: file });
          } catch { /* skip */ }
        }
      }

      // ── 2. Commit only those queued paths if they differ from HEAD ───────────
      let hasDirty: boolean;
      try {
        const matrix = await git.statusMatrix({ fs: this.fs, dir: this.dir });
        hasDirty = matrix.some(([filepath, h, w, s]) =>
          changedSet.has(filepath) && (h !== 1 || w !== 1 || s !== 1)
        );
      } catch {
        hasDirty = changedFiles.length > 0;
      }

      if (hasDirty) {
        await git.commit({
          ...this.gitOpts(),
          message: this.renderCommitMessage(this.commitMessageTemplate),
        });
        committed = true;
      }

      // ── 3. Fetch ─────────────────────────────────────────────────────────────
      const fetched = await this.safeFetch();
      if (!fetched.ok) {
        const error = `Could not fetch from GitHub before pushing: ${fetched.error}`;
        void this.logger?.error("git.sync", "Sync aborted because fetch failed", undefined, {
          code: errorInfo(fetched.error).code,
        });
        return { success: false, conflictFiles: [], error };
      }
      const fetchHead = fetched.oid;

      // ── 4. Merge, or heal a worktree left behind an already-moved HEAD ───────
      let conflictPaths: string[] = [];
      if (fetchHead && (await this.hasLocalBranch())) {
        const localHead = await git.resolveRef({
          fs: this.fs,
          dir: this.dir,
          ref: DEFAULT_BRANCH,
        });

        if (fetchHead !== localHead) {
          try {
            await this.mergeIncoming(fetchHead);
            merged = true;
          } catch (error) {
            if (error instanceof git.Errors.MergeConflictError) {
              const conflictError = error as { data?: { filepaths?: string[] } };
              conflictPaths = Array.isArray(conflictError.data?.filepaths)
                ? conflictError.data.filepaths
                : [];
              void this.logger?.warn("git.merge", "Merge produced conflicts", {
                conflictCount: conflictPaths.length,
                conflictPaths,
                code: "GIT_MERGE_CONFLICT",
              });
            } else {
              throw error;
            }
          }
        } else if (changedFiles.length === 0) {
          // Manual/heal path: refs match; rewrite the worktree so a prior
          // FF-without-checkout cannot linger. Skip when this cycle already
          // committed user edits (auto-sync) so we do not clobber them.
          await this.checkoutWorktree();
        }
      }

      // ── 5. Detect conflicts ──────────────────────────────────────────────────
      // Only genuine merge conflicts (reported by the merge itself) count.
      // statusMatrix stage columns are NOT conflict markers — they encode
      // staged/untracked file state, which previously produced phantom
      // conflicts that blocked every push on mobile.
      for (const filepath of conflictPaths) {
        const ours   = await this.readFileContent(filepath);
        const theirs = await this.readRemoteFileContent(filepath);
        const binary = looksBinary(ours) || looksBinary(theirs);
        conflicts.push({
          path: filepath,
          ours,
          theirs,
          binary,
        });
      }

      // ── 6. Push ──────────────────────────────────────────────────────────────
      if (conflicts.length === 0 && (await this.hasLocalBranch())) {
        await git.push({
          ...this.netOpts(),
          ref: DEFAULT_BRANCH,
        });
        pushed = true;
      }

      void this.logger?.info("git.sync.completed", "Sync cycle completed", {
        changedFileCount: changedFiles.length,
        committed,
        fetched: Boolean(fetchHead),
        merged,
        pushed,
        conflictCount: conflicts.length,
        success: conflicts.length === 0,
      });

      return { success: conflicts.length === 0, conflictFiles: conflicts };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      void this.logger?.error("git.sync", "Sync operation failed", error, {
        changedFileCount: changedFiles.length,
        code: errorInfo(error).code,
      });
      return { success: false, conflictFiles: [], error: msg };
    }
  }

  /** Resolve a conflict by writing resolved content, committing, and pushing.
   *  Serialized against sync()/pull() via the op mutex. */
  async resolveConflict(filepath: string, resolvedContent: string): Promise<void> {
    return this.exclusive(() => this.resolveConflictInner(filepath, resolvedContent));
  }

  private async resolveConflictInner(filepath: string, resolvedContent: string): Promise<void> {
    const fullPath = `${this.dir}/${filepath}`;
    await this.fs.promises.writeFile(fullPath, resolvedContent);
    await git.add({ fs: this.fs, dir: this.dir, filepath });
    await git.commit({
      ...this.gitOpts(),
      message: `sync: resolve conflict in ${filepath}`,
    });

    // Fetch the latest remote before pushing so a push never races a newer
    // remote. If the remote has moved, merge it in first (fast-forward).
    const fetched = await this.safeFetch();
    if (fetched.ok && fetched.oid && (await this.hasLocalBranch())) {
      const localHead = await git.resolveRef({
        fs: this.fs,
        dir: this.dir,
        ref: DEFAULT_BRANCH,
      });

      if (fetched.oid !== localHead) {
        try {
          await this.mergeIncoming(fetched.oid);
        } catch (error) {
          if (error instanceof git.Errors.MergeConflictError) {
            // The remote changed the same path again (or another path). The
            // remaining conflict re-surfaces in the next sync cycle's modal.
            const conflictError = error as { data?: { filepaths?: string[] } };
            void this.logger?.warn(
              "git.merge",
              "Conflict remains after resolving; it will re-present on the next sync",
              {
                filepath,
                remaining: conflictError.data?.filepaths,
                code: "GIT_MERGE_CONFLICT",
              }
            );
          } else {
            throw error;
          }
        }
      }
    }

    try {
      await git.push({
        ...this.netOpts(),
        ref: DEFAULT_BRANCH,
      });
    } catch (error) {
      // Non-fast-forward (remote moved) is expected when the local choice
      // differs from a remote edit; the next sync cycle reconciles it. Never
      // break the resolution modal over it.
      void this.logger?.warn("git.push", "Push after conflict resolution did not complete", {
        filepath,
        error: error instanceof Error ? error.message : String(error),
        code: errorInfo(error).code,
      });
    }
  }

  /**
   * Pull-only — fetch remote commits and merge them into the vault.
   * Used on vault open, window focus, background poll and manual sync.
   * Uses explicit fetch + merge (not git.pull) for consistent error handling.
   *
   * Serialized against sync()/resolveConflict() via the op mutex, so a
   * background poll can never interleave with a running sync cycle.
   *
   * Returns a PullResult instead of swallowing MergeConflictError: callers
   * (main.ts) use it to surface conflicts to the user immediately.
   */
  async pull(opts: { healStaleWorktree?: boolean } = {}): Promise<PullResult> {
    return this.exclusive(() => this.pullInner(opts));
  }

  private async pullInner(opts: {
    healStaleWorktree?: boolean;
  } = {}): Promise<PullResult> {
    if (!(await this.hasLocalBranch())) return { status: "upToDate" };

    const fetched = await this.safeFetch();
    if (!fetched.ok) {
      throw new Error(`Could not fetch from GitHub: ${fetched.error}`);
    }
    if (!fetched.oid) return { status: "upToDate" };

    const localHead = await git.resolveRef({
      fs: this.fs,
      dir: this.dir,
      ref: DEFAULT_BRANCH,
    });

    if (fetched.oid !== localHead) {
      // Guard against clobbering uncommitted local work: mergeIncoming ends in
      // a forced checkout of `main`, which would silently discard edits that
      // are saved on disk but not yet committed (e.g. inside the auto-push
      // debounce window). Defer instead — the next cycle picks it up.
      if (await this.worktreeHasUncommittedChanges()) {
        void this.logger?.info(
          "git.pull.deferred",
          "Pull deferred: uncommitted local changes present"
        );
        return { status: "deferred" };
      }
      try {
        await this.mergeIncoming(fetched.oid);
        void this.logger?.info("git.pull", "Pull applied remote commits to the vault");
        return { status: "applied" };
      } catch (error) {
        if (error instanceof git.Errors.MergeConflictError) {
          // Report conflicting paths to the caller so they can be surfaced
          // through the conflict UI instead of waiting for a later cycle.
          const conflictError = error as { data?: { filepaths?: string[] } };
          const conflictPaths = Array.isArray(conflictError.data?.filepaths)
            ? conflictError.data.filepaths
            : [];
          void this.logger?.warn("git.pull.conflict", "Pull merge produced conflicts", {
            conflictPaths,
            code: "GIT_MERGE_CONFLICT",
          });
          return { status: "conflict", conflictPaths };
        } else {
          throw error;
        }
      }
    }

    if (opts.healStaleWorktree) {
      // Same clobber rule applies to the heal path's forced checkout.
      if (await this.worktreeHasUncommittedChanges()) {
        void this.logger?.warn(
          "git.pull.heal-deferred",
          "Worktree heal skipped: uncommitted local changes present"
        );
        return { status: "deferred" };
      }
      await this.checkoutWorktree();
      void this.logger?.info("git.pull", "Worktree checked out to match current HEAD");
      return { status: "applied" };
    }

    return { status: "upToDate" };
  }

  /**
   * True when any TRACKED file differs between HEAD and the working tree or
   * index. Untracked brand-new files ([0,2,x]) do not count — a force checkout
   * never deletes them, so they must not defer pulls indefinitely. On failure
   * assume dirty: never risk discarding user edits.
   */
  private async worktreeHasUncommittedChanges(): Promise<boolean> {
    try {
      const matrix = await git.statusMatrix({ fs: this.fs, dir: this.dir });
      return matrix.some(([, head, workdir, stage]) => head === 1 && (workdir !== 1 || stage !== 1));
    } catch {
      return true;
    }
  }

  /**
   * Build ConflictFile payloads for the given paths using the same ours /
   * theirs / binary detection as the sync cycle, so callers can feed the
   * standard conflict modal after a pull reports conflicts.
   */
  async buildConflictFiles(paths: string[]): Promise<ConflictFile[]> {
    const files: ConflictFile[] = [];
    for (const path of paths) {
      if (!path) continue;
      const ours = await this.readFileContent(path);
      const theirs = await this.readRemoteFileContent(path);
      const binary = looksBinary(ours) || looksBinary(theirs);
      files.push({ path, ours, theirs, binary });
    }
    return files;
  }

  private async readFileContent(filepath: string): Promise<string> {
    try {
      const buf = await this.fs.promises.readFile(
        `${this.dir}/${filepath}`,
        { encoding: "utf8" }
      );
      return buf as string;
    } catch {
      return "";
    }
  }

  private async readRemoteFileContent(filepath: string): Promise<string> {
    try {
      const remoteCommit = await git.resolveRef({
        fs: this.fs,
        dir: this.dir,
        ref: `refs/remotes/origin/${DEFAULT_BRANCH}`,
      });
      const { blob } = await git.readBlob({
        fs: this.fs,
        dir: this.dir,
        oid: remoteCommit,
        filepath,
      });
      return new TextDecoder().decode(blob);
    } catch {
      return "";
    }
  }
}
