import { App, Modal, Notice } from "obsidian";
import type UltimateObsidianSyncPlugin from "../main";
import { requestDeviceCode, pollForToken } from "../auth/github-device";
import { errorInfo } from "../debug/errors";
import { BUILD_TIMESTAMP } from "../constants";
import {
  getAuthenticatedUser,
  getUserRepos,
  validateRepoName,
  repoExists,
  repoHasCommits,
  vaultNameToRepoName,
} from "../github/api";

/** Phases of the connection flow, rendered by GitHubConnectModal. */
type ConnectPhase = "idle" | "auth" | "repo" | "setup" | "success" | "error";

/** User actions available after a repository-setup failure. */
type SetupErrorAction = "retry" | "change" | "close";

/** How long the success screen stays visible before auto-closing. */
const SUCCESS_DISPLAY_MS = 1600;

/**
 * Overlay modal covering the whole GitHub connection flow:
 *   auth (device code) → repository selection → repository setup → success.
 *
 * Cancellation semantics:
 * - Closing the modal (Esc / ✕ / Cancel button) during the auth phase cancels
 *   the whole flow (`cancelled` flag + onCancelRequest signal) — nothing has
 *   been persisted yet.
 * - Closing it during the repo phase only defers setup: the authorization is
 *   already persisted and can be resumed from settings later.
 * - Closing it during the setup phase only detaches the UI; the setup itself
 *   keeps running in the background (git operations cannot be aborted
 *   mid-flight) and the outcome is still reported via Notice + settings.
 * - The error phase resolves through explicit buttons (retry / change / close)
 *   or through closing the modal (= close).
 */
export class GitHubConnectModal extends Modal {
  private plugin: UltimateObsidianSyncPlugin;
  private phase: ConnectPhase = "idle";
  private opened = false;
  /** Set once the flow outcome is decided — disables cancel semantics. */
  private flowDone = false;
  /** True when the user cancelled during the auth or repo phase. */
  cancelled = false;
  /** True when the user closed the modal during the setup phase. */
  private detached = false;

  private userCode = "";
  private verificationUri = "";
  private repoUsername = "";
  private repoToken = "";
  private setupRepoName = "";
  private successUsername = "";
  private successRepoName = "";
  private errorDetail: { message: string; action?: string; detail: string } | null = null;
  /** Error phase with retry/change buttons (setup) vs close-only (auth). */
  private errorRetryable = false;

  /** Signals the orchestrator that the user cancelled (auth phase race). */
  onCancelRequest: (() => void) | null = null;
  private repoChoiceResolve: ((value: string | null) => void) | null = null;
  private errorResolve: ((action: SetupErrorAction) => void) | null = null;
  /** First close reason wins — later closes (finishFlow safety net) don't override. */
  private closeReason: string | null = null;

  // Repo-phase form state (input ↔ select sync, confirm checks).
  private defaultRepoName = "";
  private nameInputEl: HTMLInputElement | null = null;
  private selectEl: HTMLSelectElement | null = null;
  private listStatusEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private confirmBtnEl: HTMLButtonElement | null = null;
  private refreshEl: HTMLElement | null = null;
  private checkedName: string | null = null;
  private loadingRepos = false;

  constructor(app: App, plugin: UltimateObsidianSyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.opened = true;
    void this.plugin.logInfo("modal.open", "Connection modal opened", {
      phase: this.phase,
      build: BUILD_TIMESTAMP,
    });
    this.render();
  }

  onClose(): void {
    this.opened = false;
    if (this.phase === "error") {
      // Closing during an error is the "close" action, never a flow cancel.
      this.markClose("closed-error-phase");
      this.resolveError("close");
    } else if (!this.flowDone) {
      if (this.phase === "auth" || this.phase === "repo") {
        this.markClose("user-cancel");
        this.requestCancel();
      } else if (this.phase === "setup") {
        this.markClose("closed-during-setup");
        this.detached = true;
      }
    }
    const reason = this.closeReason ?? `dismissed:${this.phase}`;
    void this.plugin.logInfo("modal.close", "Connection modal closed", {
      phase: this.phase,
      reason,
      flowDone: this.flowDone,
      cancelled: this.cancelled,
    });
    this.contentEl.empty();
  }

  // ── Phase starters (called by the orchestrator) ────────────────────────────

  showAuthPhase(userCode: string, verificationUri: string): void {
    this.phase = "auth";
    this.userCode = userCode;
    this.verificationUri = verificationUri;
    this.rerenderIfOpen();
  }

  /**
   * @param defaultRepoName Optional prefill override — the switch flow passes
   * the CURRENT repository name; fresh flows derive it from the vault name.
   */
  showRepoPhase(username: string, token: string, defaultRepoName?: string): void {
    this.phase = "repo";
    this.repoUsername = username;
    this.repoToken = token;
    this.defaultRepoName = defaultRepoName ?? vaultNameToRepoName(this.app.vault.getName());
    this.checkedName = null;
    this.rerenderIfOpen();
  }

  showSetupPhase(repoName: string): void {
    this.phase = "setup";
    this.setupRepoName = repoName;
    this.rerenderIfOpen();
  }

  /**
   * Show a setup failure with retry / change-repo / close options.
   * Resolves immediately with "close" when the modal is not visible
   * (user detached it during setup) so the orchestrator never hangs.
   */
  showSetupError(error: unknown, repoName: string): Promise<SetupErrorAction> {
    const info = errorInfo(error);
    this.errorDetail = { message: info.message, action: info.action, detail: info.detail };
    this.errorRetryable = true;
    this.setupRepoName = repoName;
    this.phase = "error";
    if (!this.opened || this.detached) return Promise.resolve("close");
    this.render();
    return new Promise((resolve) => {
      this.errorResolve = resolve;
    });
  }

  /**
   * Show an auth-phase failure (close-only). Resolves `true` when the error
   * was displayed in the modal (and the user closed it), `false` when the
   * modal was not visible and the orchestrator must fall back to a Notice.
   */
  showAuthError(error: unknown): Promise<boolean> {
    const info = errorInfo(error);
    this.errorDetail = { message: info.message, action: info.action, detail: info.detail };
    this.errorRetryable = false;
    this.flowDone = true;
    this.phase = "error";
    if (!this.opened || this.detached) return Promise.resolve(false);
    this.render();
    return new Promise<boolean>((resolve) => {
      this.errorResolve = () => resolve(true);
    });
  }

  /** Brief success screen, then auto-close. No-op when detached. */
  showSuccessPhase(username: string, repoName: string): Promise<void> {
    this.flowDone = true;
    this.successUsername = username;
    this.successRepoName = repoName;
    this.phase = "success";
    if (!this.opened || this.detached) return Promise.resolve();
    this.render();
    return new Promise((resolve) => {
      window.setTimeout(() => {
        if (this.opened) this.close();
        resolve();
      }, SUCCESS_DISPLAY_MS);
    });
  }

  /** Resolve the repository choice; null means cancelled. */
  waitForRepoChoice(): Promise<string | null> {
    if (this.cancelled) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.repoChoiceResolve = resolve;
    });
  }

  /**
   * Tear down the modal after the flow has finished (or when the plugin is
   * unloading). Safe to call multiple times. The first reason wins — later
   * safety-net calls never overwrite the real cause.
   */
  finishFlow(reason: string = "flow-finished"): void {
    this.markClose(reason);
    this.flowDone = true;
    this.resolveRepoChoice(null);
    this.resolveError("close");
    if (this.opened && this.phase !== "success") {
      this.close();
    }
  }

  // ── Cancellation plumbing ──────────────────────────────────────────────────

  private markClose(reason: string): void {
    if (!this.closeReason) this.closeReason = reason;
  }

  private requestCancel(): void {
    if (this.flowDone || this.cancelled) return;
    this.markClose("user-cancel");
    this.cancelled = true;
    this.resolveRepoChoice(null);
    this.onCancelRequest?.();
  }

  private resolveRepoChoice(value: string | null): void {
    if (this.repoChoiceResolve) {
      const resolve = this.repoChoiceResolve;
      this.repoChoiceResolve = null;
      resolve(value);
    }
  }

  private resolveError(action: SetupErrorAction): void {
    if (this.errorResolve) {
      const resolve = this.errorResolve;
      this.errorResolve = null;
      resolve(action);
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  private rerenderIfOpen(): void {
    if (this.opened) this.render();
  }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.addClass("uos-connect-modal");
    switch (this.phase) {
      case "auth":
        this.titleEl.setText("Connect to GitHub");
        this.renderAuth();
        break;
      case "repo":
        this.titleEl.setText("Choose a repository");
        this.renderRepo();
        break;
      case "setup":
        this.titleEl.setText("Setting up repository");
        this.renderSetup();
        break;
      case "success":
        this.titleEl.setText("Connected");
        this.renderSuccess();
        break;
      case "error":
        this.titleEl.setText("Connection problem");
        this.renderError();
        break;
      default:
        break;
    }
  }

  private renderAuth(): void {
    const { contentEl } = this;

    contentEl.createEl("p", {
      text: "Open this URL in your browser and enter the code below:",
      cls: "uos-muted",
    });

    const link = contentEl.createEl("a", {
      text: this.verificationUri,
      href: this.verificationUri,
    });
    link.addClass("uos-verify-link");

    contentEl.createEl("div", { text: this.userCode, cls: "uos-user-code" });

    const copyBtn = contentEl.createEl("button", { text: "Copy code" });
    copyBtn.addClass("uos-copy-btn");
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(this.userCode).then(
        () => {
          copyBtn.textContent = "Copied!";
          window.setTimeout(() => {
            copyBtn.textContent = "Copy code";
          }, 1500);
        },
        () => {
          new Notice("Could not copy the code — please type it manually.");
        }
      );
    });

    const waiting = contentEl.createDiv({ cls: "uos-waiting" });
    waiting.createDiv({ cls: "uos-spinner" });
    waiting.createSpan({ text: "Waiting for you to approve in the browser…" });

    const cancelBtn = contentEl.createEl("button", { text: "Cancel connection" });
    cancelBtn.addClass("uos-cancel-btn");
    cancelBtn.addEventListener("click", () => this.close());
  }

  private renderRepo(): void {
    const { contentEl } = this;

    contentEl.createEl("p", {
      text: `Signed in as @${this.repoUsername}. Choose where this vault will be synced:`,
      cls: "uos-muted",
    });

    contentEl.createEl("span", {
      text: "Repository name",
      cls: "setting-item-name uos-label-block",
    });

    const nameInput = contentEl.createEl("input", {
      type: "text",
      placeholder: this.defaultRepoName,
      cls: "uos-full-input",
    });
    nameInput.value = this.defaultRepoName;
    this.nameInputEl = nameInput;

    contentEl.createEl("span", {
      text: "…or use an existing private repo",
      cls: "setting-item-name uos-label-block",
    });

    const select = contentEl.createEl("select", { cls: "uos-select-full" });
    this.selectEl = select;

    const listStatus = contentEl.createEl("p", { cls: "setting-item-description uos-list-status" });
    this.listStatusEl = listStatus;

    const refreshEl = contentEl.createEl("a", {
      text: "Refresh list",
      cls: "setting-item-description uos-refresh-link",
    });
    this.refreshEl = refreshEl;

    const status = contentEl.createEl("p", { cls: "setting-item-description" });
    this.statusEl = status;

    const btnRow = contentEl.createDiv({ cls: "uos-btn-row" });
    // Closing at this point keeps the persisted authorization — the user can
    // resume from settings, so the button says "Finish later", not "Cancel".
    const cancelBtn = btnRow.createEl("button", { text: "Finish later" });
    const confirmBtn = btnRow.createEl("button", { text: "Connect & Sync", cls: "mod-cta" });
    this.confirmBtnEl = confirmBtn;

    cancelBtn.addEventListener("click", () => this.close());
    confirmBtn.addEventListener("click", () => {
      void this.handleConfirm();
    });

    select.addEventListener("change", () => {
      if (!this.nameInputEl) return;
      if (select.value) {
        this.nameInputEl.value = select.value;
      } else {
        this.nameInputEl.value = this.defaultRepoName;
      }
      this.updateRepoForm();
    });

    nameInput.addEventListener("input", () => {
      if (select.value) select.value = "";
      this.updateRepoForm();
    });

    refreshEl.addEventListener("click", () => {
      void this.loadRepos();
    });

    this.updateRepoForm();
    void this.loadRepos();
  }

  private renderSetup(): void {
    const { contentEl } = this;
    const waiting = contentEl.createDiv({ cls: "uos-waiting" });
    waiting.createDiv({ cls: "uos-spinner" });
    waiting.createSpan({
      text: `Preparing ${this.setupRepoName} — creating, cloning and pushing your vault. This can take a moment…`,
    });
    contentEl.createEl("p", {
      text: "You can close this window — setup continues in the background and you will be notified when it finishes.",
      cls: "uos-muted",
    });
  }

  private renderSuccess(): void {
    const { contentEl } = this;
    const done = contentEl.createDiv({ cls: "uos-waiting" });
    done.createSpan({
      text: `✓ Connected as @${this.successUsername} — syncing to ${this.successRepoName}.`,
    });
  }

  private renderError(): void {
    const { contentEl } = this;
    const detail = this.errorDetail;

    const msg = contentEl.createEl("p", { cls: "uos-error-text" });
    msg.setText(detail?.message ?? "Something went wrong.");

    if (detail?.action) {
      contentEl.createEl("p", { text: detail.action, cls: "uos-muted" });
    }
    if (detail?.detail && detail.detail !== detail.message) {
      contentEl.createEl("p", { text: detail.detail, cls: "uos-raw-detail" });
    }

    const btnRow = contentEl.createDiv({ cls: "uos-btn-row uos-btn-row--spaced" });
    const closeBtn = btnRow.createEl("button", { text: "Close" });
    closeBtn.addEventListener("click", () => this.close());

    if (this.errorRetryable) {
      const changeBtn = btnRow.createEl("button", { text: "Change repository" });
      const retryBtn = btnRow.createEl("button", { text: "Try again", cls: "mod-cta" });
      changeBtn.addEventListener("click", () => this.resolveError("change"));
      retryBtn.addEventListener("click", () => this.resolveError("retry"));
    }
  }

  // ── Repo-phase form logic ──────────────────────────────────────────────────

  private setStatus(text: string, isError = false): void {
    if (!this.statusEl) return;
    this.statusEl.setText(text);
    this.statusEl.toggleClass("uos-error-text", isError);
  }

  /** Re-validate the name field; also resets any pending content warning. */
  private updateRepoForm(): void {
    this.checkedName = null;
    if (!this.confirmBtnEl || !this.nameInputEl) return;
    this.confirmBtnEl.textContent = "Connect & Sync";
    const error = validateRepoName(this.nameInputEl.value);
    if (error) {
      this.setStatus(error, true);
      this.confirmBtnEl.disabled = true;
    } else {
      this.setStatus("");
      this.confirmBtnEl.disabled = false;
    }
  }

  /**
   * Load the user's private repositories into the select, with explicit
   * loading / empty / error states (the list is never silently blank).
   */
  private async loadRepos(): Promise<void> {
    const select = this.selectEl;
    const listStatus = this.listStatusEl;
    if (!select || !listStatus || this.loadingRepos || this.phase !== "repo") return;
    this.loadingRepos = true;
    if (this.refreshEl) this.refreshEl.setText("Refreshing…");
    select.empty();
    const loadingOption = select.createEl("option", {
      value: "",
      text: "Loading repositories…",
    });
    loadingOption.disabled = true;
    listStatus.setText("Loading repositories…");
    listStatus.removeClass("uos-error-text");
    try {
      const repos = await getUserRepos(this.repoToken);

      // The user may have left the repo phase (or the modal) while fetching.
      if (this.phase !== "repo" || this.selectEl !== select) return;

      select.empty();
      select.createEl("option", {
        value: "",
        text: "— Create new private repo with the name above —",
      });

      if (repos.length === 0) {
        const emptyOption = select.createEl("option", {
          value: "",
          text: "No private repositories found",
        });
        emptyOption.disabled = true;
        listStatus.setText(
          `@${this.repoUsername} has no private repositories. ` +
            "Enter a name above to create a new private repo, or make an existing repo private on GitHub."
        );
      } else {
        for (const repo of repos) {
          select.createEl("option", {
            value: repo.name,
            text: `${this.repoUsername}/${repo.name}`,
          });
        }
        if (listStatus.getText() === "Loading repositories…") {
          listStatus.setText("");
        }
      }
    } catch (error) {
      const info = errorInfo(error);
      void this.plugin.logWarning("repo-picker.load", "Could not load existing repos", {
        code: info.code,
        error: info.detail,
      });
      if (this.phase !== "repo" || this.selectEl !== select) return;
      select.empty();
      const errorOption = select.createEl("option", {
        value: "",
        text: "Could not load repositories",
      });
      errorOption.disabled = true;
      listStatus.addClass("uos-error-text");
      listStatus.setText(
        `Could not load your repositories — ${info.message}` +
          (info.detail ? ` (${info.detail})` : "") +
          " You can still create a new repo with the name above, or click Refresh list to retry."
      );
    } finally {
      this.loadingRepos = false;
      if (this.refreshEl) this.refreshEl.setText("Refresh list");
    }
  }

  /** Confirm handler: verify the chosen repo, double-confirm non-empty ones. */
  private async handleConfirm(): Promise<void> {
    const nameInput = this.nameInputEl;
    const confirmBtn = this.confirmBtnEl;
    if (!nameInput || !confirmBtn) return;

    const chosen = nameInput.value.trim();
    if (validateRepoName(chosen)) {
      this.updateRepoForm();
      return;
    }

    // Second click after the content warning — confirm into the checked repo.
    if (this.checkedName === chosen) {
      this.resolveRepoChoice(chosen);
      return;
    }

    this.checkedName = null;
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Checking repo…";
    try {
      const exists = await repoExists(this.repoToken, this.repoUsername, chosen);
      if (exists) {
        const hasCommits = await repoHasCommits(this.repoToken, this.repoUsername, chosen);
        if (hasCommits) {
          // Repo already has content — require a second, explicit confirm.
          if (this.phase !== "repo" || !this.nameInputEl || !this.confirmBtnEl) return;
          if (this.nameInputEl.value.trim() !== chosen) {
            this.updateRepoForm();
            return;
          }
          this.checkedName = chosen;
          this.setStatus(
            `This will REPLACE this device's vault content with ${this.repoUsername}/${chosen}. ` +
              "Files not in the repository are removed from this device and saved to a dated backup folder. " +
              "Plugins installed only on this device will be removed. Continue?",
            true
          );
          this.confirmBtnEl.disabled = false;
          this.confirmBtnEl.textContent = "Replace & Sync";
          return;
        }
      }
      // Re-read the field: if the user edited it while we checked, restart.
      if (this.phase !== "repo" || !this.nameInputEl) return;
      if (this.nameInputEl.value.trim() !== chosen) {
        this.updateRepoForm();
        return;
      }
      this.resolveRepoChoice(chosen);
    } catch (error) {
      const info = errorInfo(error);
      void this.plugin.logWarning("repo-picker.verify", "Could not verify repository", {
        code: info.code,
        error: info.detail,
      });
      if (this.phase !== "repo" || !this.confirmBtnEl) return;
      this.setStatus(info.action ? `${info.message} ${info.action}` : info.message, true);
      this.confirmBtnEl.disabled = false;
      this.confirmBtnEl.textContent = "Connect & Sync";
    }
  }
}

/** How a connect/resume flow ended. */
type FlowOutcome = "connected" | "cancelled" | "deferred" | "failed";

interface FlowResult {
  outcome: FlowOutcome;
  failure?: unknown;
  /** True when the failure was already surfaced inside the modal. */
  failureShownInModal: boolean;
}

/**
 * Drives repository selection → setup → success on `modal`. Shared by the
 * fresh-connect flow and the resume flow so both behave identically.
 *
 * Outcomes:
 * - "deferred": the user dismissed the picker — authorization stays persisted
 *   and setup can be resumed later from settings.
 * - "failed": setup failed and the user closed the error, or an unexpected
 *   error escaped; `failure` carries the error.
 */
async function driveRepoSelectionAndSetup(
  plugin: UltimateObsidianSyncPlugin,
  modal: GitHubConnectModal,
  token: string,
  username: string,
  opts: { openIntoRepoPhase?: boolean; defaultRepoName?: string } = {}
): Promise<FlowResult> {
  if (opts.openIntoRepoPhase) {
    modal.showRepoPhase(username, token, opts.defaultRepoName);
    modal.open();
  }

  let repoName = "";
  // When the SAME repository fails setup and is retried, wipe the partial
  // .git the failed attempt may have left behind (an interrupted clone can
  // leave a valid-looking HEAD that would be mistaken for a completed
  // setup). A different repository keeps the default remoteMatches handling.
  let lastFailedRepo: string | null = null;

  try {
    while (true) {
      modal.showRepoPhase(username, token, opts.defaultRepoName);
      const chosen = await modal.waitForRepoChoice();
      if (!chosen) {
        return { outcome: "deferred", failureShownInModal: false };
      }
      repoName = chosen;

      modal.showSetupPhase(chosen);
      while (true) {
        try {
          // Recomputed per attempt: after a failed attempt lastFailedRepo is
          // set to this repo, so the retry wipes any partial .git it left.
          const resetLocalFirst = chosen === lastFailedRepo;
          await plugin.initializeRepo(token, username, chosen, { resetLocalFirst });
          await modal.showSuccessPhase(username, repoName);
          return { outcome: "connected", failureShownInModal: false };
        } catch (err) {
          lastFailedRepo = chosen;
          const action = await modal.showSetupError(err, chosen);
          if (action === "retry") {
            modal.showSetupPhase(chosen);
            continue;
          }
          if (action === "change") {
            break; // back to repository selection
          }
          throw err; // "close"
        }
      }
    }
  } catch (err) {
    return {
      outcome: "failed",
      failure: err,
      failureShownInModal: await modal.showAuthError(err),
    };
  }
}

/** Shared teardown: close the modal, report the outcome, refresh settings. */
async function finishConnectFlow(
  plugin: UltimateObsidianSyncPlugin,
  modal: GitHubConnectModal,
  result: FlowResult,
  username: string,
  onFlowEnd: () => void,
  mode: "setup" | "switch" = "setup"
): Promise<void> {
  modal.finishFlow(`flow-end:${result.outcome}${mode === "switch" ? ":switch" : ""}`);
  plugin.setActiveConnectModal(null);

  if (mode === "switch") {
    // A repository switch never mutates the connection state:
    // - dismissal ("deferred") keeps the current repository — nothing happened;
    // - failure rolled back to the current repository inside initializeRepo,
    //   so there is no abortConnection here — the user stays connected;
    // - success is already announced by initializeRepo's own notices
    //   ("Created/Cloned/Initialised/Reconnected to …").
    if (result.outcome === "failed" && !result.failureShownInModal) {
      const info = errorInfo(result.failure);
      new Notice(
        `Repository change failed: ${info.message}${info.action ? ` ${info.action}` : ""}`
      );
    }
    onFlowEnd();
    return;
  }

  switch (result.outcome) {
    case "connected":
      new Notice(`Connected as @${username}. Vault syncing started!`);
      break;
    case "cancelled":
      // Auth-phase cancel only — nothing was persisted yet.
      await plugin.abortConnection();
      new Notice("Connection cancelled.");
      break;
    case "deferred":
      // Authorization is already persisted; leaving quietly keeps it usable.
      await plugin.pauseConnectionSetup();
      new Notice("GitHub account connected. Choose a repository in settings to finish setup.");
      break;
    case "failed":
      await plugin.abortConnection(result.failure);
      if (!result.failureShownInModal) {
        const info = errorInfo(result.failure);
        new Notice(`Connection failed: ${info.message}${info.action ? ` ${info.action}` : ""}`);
      }
      break;
  }
  onFlowEnd();
}

/**
 * Fresh connection flow: device-code auth → user lookup → stage credentials →
 * repository selection → repository setup (with retry that skips
 * re-authorization) → success.
 *
 * Never throws: every outcome (connected / cancelled / deferred / failed) is
 * reported through Notices, the plugin connection state and onFlowEnd.
 */
export async function runConnectFlow(
  app: App,
  plugin: UltimateObsidianSyncPlugin,
  onFlowEnd: () => void
): Promise<void> {
  const modal = new GitHubConnectModal(app, plugin);
  plugin.setActiveConnectModal(modal);

  let token: string | null = null;
  let username = "";
  let result: FlowResult = { outcome: "cancelled", failureShownInModal: false };

  try {
    void plugin.logInfo("connect-flow.start", "Fresh connect flow started", {
      build: BUILD_TIMESTAMP,
    });
    // ── Auth phase ───────────────────────────────────────────────────────────
    const deviceFlow = await requestDeviceCode();
    modal.showAuthPhase(deviceFlow.user_code, deviceFlow.verification_uri);
    modal.open();
    window.open(deviceFlow.verification_uri, "_blank");

    let breakRace: (() => void) | null = null;
    const cancelledSignal = new Promise<null>((resolve) => {
      breakRace = () => resolve(null);
    });
    modal.onCancelRequest = () => breakRace?.();

    token = await Promise.race([
      pollForToken(
        deviceFlow.device_code,
        deviceFlow.interval,
        deviceFlow.expires_in,
        undefined,
        () => modal.cancelled
      ),
      cancelledSignal,
    ]);

    if (modal.cancelled || !token) {
      result = { outcome: "cancelled", failureShownInModal: false };
      return;
    }

    const user = await getAuthenticatedUser(token);
    username = user.login;

    // Persist the granted authorization immediately — before any repository
    // decision — so dismissing the picker or a failed setup never costs a
    // browser re-authorization.
    await plugin.stageCredentials(token, username);

    result = await driveRepoSelectionAndSetup(plugin, modal, token, username);
  } catch (err) {
    result = {
      outcome: "failed",
      failure: err,
      failureShownInModal: await modal.showAuthError(err),
    };
  } finally {
    await finishConnectFlow(plugin, modal, result, username, onFlowEnd);
  }
}

/**
 * Resume flow for the pending-setup state (authorization persisted, no
 * repository chosen yet): validates the stored token, then opens the
 * repository picker directly — no browser re-authorization.
 *
 * Assumes the caller already ran beginConnection(). A revoked token (401) is
 * cleared automatically so the user can connect fresh; transient validation
 * failures (offline, rate limit) keep the pending state untouched.
 */
export async function runRepoSelectionFlow(
  app: App,
  plugin: UltimateObsidianSyncPlugin,
  onFlowEnd: () => void
): Promise<void> {
  const { githubToken } = plugin.settings;

  if (!githubToken || !plugin.hasPendingSetup()) {
    // Stale UI race — nothing to resume; just refresh.
    await plugin.pauseConnectionSetup();
    onFlowEnd();
    return;
  }

  void plugin.logInfo("resume-flow.start", "Resume flow started (pending setup)", {
    build: BUILD_TIMESTAMP,
  });

  let username: string;
  try {
    // Validate the persisted authorization before showing any UI.
    username = (await getAuthenticatedUser(githubToken)).login;
  } catch (err) {
    const info = errorInfo(err);
    if (info.code === "API_UNAUTHORIZED") {
      // Token genuinely revoked/invalid — clear the staged credentials so
      // settings falls back to the fresh Connect flow.
      await plugin.abortConnection(err);
      await plugin.disconnect();
      new Notice("Saved GitHub authorization is no longer valid. Please connect again.");
    } else {
      // Transient failure (offline, rate limit, GitHub outage) — the token may
      // be perfectly fine. Keep the pending state so the user can retry
      // without re-authorizing.
      await plugin.pauseConnectionSetup();
      new Notice(
        `Could not verify saved GitHub authorization (${info.message}${info.action ? ` ${info.action}` : ""}). Setup stays paused — try again shortly.`
      );
    }
    onFlowEnd();
    return;
  }

  // Refresh the stored username in case it changed since authorization.
  await plugin.stageCredentials(githubToken, username);

  const modal = new GitHubConnectModal(app, plugin);
  plugin.setActiveConnectModal(modal);

  const result = await driveRepoSelectionAndSetup(plugin, modal, githubToken, username, {
    openIntoRepoPhase: true,
  });
  await finishConnectFlow(plugin, modal, result, username, onFlowEnd);
}

/**
 * "Change repository" flow for a CONNECTED vault: validates the stored token,
 * opens the repository picker prefilled with the CURRENT repository, and
 * re-points the vault via the standard setup — initializeRepo detects the
 * mismatched local .git, wipes it, and creates/clones/pushes the new repo.
 *
 * Unlike the pending-setup resume flow, dismissal changes nothing (the user
 * stays connected to the current repository) and a failed switch rolls back
 * to it with the connection intact. The sync engine keeps running against
 * the old repository while the user browses the picker; initializeRepo
 * detaches it only once a new repository is confirmed.
 */
export async function runChangeRepositoryFlow(
  app: App,
  plugin: UltimateObsidianSyncPlugin,
  onFlowEnd: () => void
): Promise<void> {
  const { githubToken, githubUsername, repoName } = plugin.settings;

  if (plugin.getConnectionState() !== "connected" || !githubToken || !githubUsername || !repoName) {
    // Stale UI race — nothing to switch; just refresh.
    onFlowEnd();
    return;
  }

  void plugin.logInfo("change-repo-flow.start", "Change-repository flow started", {
    build: BUILD_TIMESTAMP,
    currentRepo: repoName,
  });

  let username: string;
  try {
    // Validate the persisted authorization before showing any UI.
    username = (await getAuthenticatedUser(githubToken)).login;
  } catch (err) {
    const info = errorInfo(err);
    if (info.code === "API_UNAUTHORIZED") {
      new Notice(
        "Saved GitHub authorization is no longer valid. Disconnect and reconnect to continue."
      );
    } else {
      new Notice(
        `Could not verify saved GitHub authorization (${info.message}${info.action ? ` ${info.action}` : ""}). Try again shortly.`
      );
    }
    onFlowEnd();
    return;
  }

  const modal = new GitHubConnectModal(app, plugin);
  plugin.setActiveConnectModal(modal);

  const result = await driveRepoSelectionAndSetup(plugin, modal, githubToken, username, {
    openIntoRepoPhase: true,
    defaultRepoName: repoName,
  });
  await finishConnectFlow(plugin, modal, result, username, onFlowEnd, "switch");
}
