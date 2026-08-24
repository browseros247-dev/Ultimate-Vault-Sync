import { SYNC_DEBOUNCE_MS, clampDebounceMs } from "../constants";
import { GitSync } from "./git-sync";
import { ConflictFile, SyncResult, SyncStatus } from "../types";
import { DebugLogger } from "../debug/logger";
import { errorInfo } from "../debug/errors";

type StatusCallback = (status: SyncStatus, detail?: string) => void;

export class SyncQueue {
  private static MAX_RETRIES = 3;
  private static RETRY_BACKOFF_MS = 5000;

  private pendingFiles = new Set<string>();
  private debounceTimer: number | null = null;
  private retryTimer: number | null = null;
  private retryCounts = new Map<string, number>();
  private running = false;
  /** While suspended, timers are cleared and flushes are refused (repo switch). */
  private suspended = false;
  private gitSync: GitSync;
  private onStatus: StatusCallback;
  private debounceMs: number;
  private logger?: DebugLogger;
  private onConflicts?: (files: ConflictFile[]) => void;
  private onDropped?: (files: string[], error?: string) => void;

  constructor(
    gitSync: GitSync,
    onStatus: StatusCallback,
    debounceMs: number = SYNC_DEBOUNCE_MS,
    logger?: DebugLogger,
    onConflicts?: (files: ConflictFile[]) => void,
    onDropped?: (files: string[], error?: string) => void
  ) {
    this.gitSync = gitSync;
    this.onStatus = onStatus;
    this.debounceMs = debounceMs;
    this.logger = logger;
    this.onConflicts = onConflicts;
    this.onDropped = onDropped;
  }

  /**
   * Stop all syncing without discarding state — used while a repository
   * switch is in progress so no flush can target the OLD repository.
   * Pending files are kept and flush normally after resume().
   */
  suspend(): void {
    this.suspended = true;
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.retryTimer) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Undo suspend(); pending files flush on the next trigger. */
  resume(): void {
    this.suspended = false;
  }

  /** Apply a new debounce without rebuilding the queue. Reschedules a pending flush. */
  setDebounceMs(ms: number): void {
    this.debounceMs = clampDebounceMs(ms);
    if (this.debounceTimer === null || this.pendingFiles.size === 0) return;
    window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => void this.flush(), this.debounceMs);
  }

  /** Enqueue a changed file path. Debounces before triggering sync. */
  enqueue(filepath: string): void {
    this.pendingFiles.add(filepath);
    if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => void this.flush(), this.debounceMs);
  }

  /** Immediately drain the queue (used on vault close). */
  async flushNow(): Promise<SyncResult | null> {
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.retryTimer) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    return this.flush();
  }

  /**
   * Re-enqueue files that failed with a transient error so a single network
   * blip never drops an edit. Files that exceed MAX_RETRIES are abandoned.
   */
  private reenqueueForRetry(files: string[], error?: string): void {
    const retryable: string[] = [];
    const dropped: string[] = [];
    for (const file of files) {
      const attempts = this.retryCounts.get(file) ?? 0;
      if (attempts < SyncQueue.MAX_RETRIES) {
        this.retryCounts.set(file, attempts + 1);
        retryable.push(file);
      } else {
        this.retryCounts.delete(file);
        dropped.push(file);
      }
    }

    if (retryable.length > 0) {
      for (const file of retryable) this.pendingFiles.add(file);
      void this.logger?.warn("queue.flush.retry", "Sync failed; retrying queued files", {
        retryAttempts: retryable.map((f) => this.retryCounts.get(f) ?? 0),
        droppedCount: dropped.length,
        droppedFiles: dropped,
        error,
        ...(error ? { code: errorInfo(error).code } : {}),
      });
      this.scheduleRetry();
    } else {
      void this.logger?.warn("queue.flush.failed", "Sync failed; retries exhausted, files dropped", {
        droppedCount: dropped.length,
        droppedFiles: dropped,
        error,
        ...(error ? { code: errorInfo(error).code } : {}),
      });
      this.onDropped?.(dropped, error);
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, SyncQueue.RETRY_BACKOFF_MS);
  }

  private async flush(): Promise<SyncResult | null> {
    if (this.suspended || this.running || this.pendingFiles.size === 0) return null;

    this.running = true;
    const filesToSync = [...this.pendingFiles];
    this.pendingFiles.clear();

    void this.logger?.info("queue.flush.start", "Queue flush started", {
      count: filesToSync.length,
      files: filesToSync,
    });

    try {
      this.onStatus("pushing");
      const result = await this.gitSync.sync(filesToSync);

      if (result.conflictFiles.length > 0) {
        this.onStatus("conflict");
        this.onConflicts?.(result.conflictFiles);
      } else if (result.success) {
        this.onStatus("idle");
      } else {
        this.onStatus("error", result.error);
      }

      void this.logger?.info("queue.flush.end", "Queue flush finished", {
        success: result.success,
        conflictCount: result.conflictFiles.length,
        error: result.error,
        ...(result.error ? { code: errorInfo(result.error).code } : {}),
      });

      if (!result.success) {
        if (result.conflictFiles.length > 0) {
          // Genuine conflicts need a user decision, not an automatic retry.
          for (const file of filesToSync) this.retryCounts.delete(file);
          void this.logger?.warn("queue.flush.conflicts", "Sync blocked by conflicts", {
            conflictCount: result.conflictFiles.length,
            error: result.error,
          });
        } else {
          this.reenqueueForRetry(filesToSync, result.error);
        }
      } else {
        for (const file of filesToSync) this.retryCounts.delete(file);
      }

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onStatus("error", msg);
      void this.logger?.error("queue.flush.error", "Queue flush threw", err, {
        droppedFiles: filesToSync,
        code: errorInfo(err).code,
      });
      this.reenqueueForRetry(filesToSync, msg);
      return { success: false, conflictFiles: [], error: msg };
    } finally {
      this.running = false;
      // If more files arrived while we were syncing, flush again
      if (this.pendingFiles.size > 0 && !this.retryTimer) {
        window.setTimeout(() => void this.flush(), 500);
      }
    }
  }
}