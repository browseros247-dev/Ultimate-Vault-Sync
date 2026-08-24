import { App, PluginSettingTab, Setting, Notice, ButtonComponent, Platform } from "obsidian";
import type UltimateObsidianSyncPlugin from "../main";
import { errorInfo } from "../debug/errors";
import { BUILD_TIMESTAMP, SYNC_DEBOUNCE_MIN_MS, SYNC_DEBOUNCE_MAX_MS, SYNC_DEBOUNCE_STEP_MS, PULL_INTERVAL_SEC, PULL_INTERVAL_MIN_SEC, PULL_INTERVAL_MAX_SEC } from "../constants";
import { runConnectFlow, runRepoSelectionFlow, runChangeRepositoryFlow } from "./connect-flow";
import { RenameRepoModal } from "./rename-modal";

export class UltimateObsidianSyncSettingsTab extends PluginSettingTab {
  plugin: UltimateObsidianSyncPlugin;
  isDisplayed = false;

  constructor(app: App, plugin: UltimateObsidianSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    this.isDisplayed = true;
    void this.plugin.logInfo("settings.render", "Settings rendered", {
      connectionState: this.plugin.getConnectionState(),
      build: BUILD_TIMESTAMP,
    });
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("Ultimate Vault Sync").setHeading();
    new Setting(containerEl).setDesc(
      `${this.plugin.manifest.id} v${this.plugin.manifest.version} · built ${BUILD_TIMESTAMP}`
    );

    const settings = this.plugin.settings;

    new Setting(containerEl).setName("GitHub Account").setHeading();

    const connectionState = this.plugin.getConnectionState();

    if (connectionState === "connecting") {
      new Setting(containerEl)
        .setName("Connecting GitHub account")
        .setDesc("Waiting for GitHub authorization and repository setup to finish.")
        .addButton((btn) => btn.setButtonText("Connecting…").setDisabled(true));
    } else if (connectionState === "connected" && settings.githubToken && settings.githubUsername) {
      // Connected state
      new Setting(containerEl)
        .setName("Connected account")
        .setDesc(`Signed in as @${settings.githubUsername}`)
        .addButton((btn) =>
          btn
             .setButtonText("Disconnect")
            .setWarning()
            .onClick(async () => {
              await this.plugin.disconnect();
              this.display();
              new Notice("Disconnected from GitHub.");
            })
        );

      new Setting(containerEl)
        .setName("Vault repo")
        .setDesc(`github.com/${settings.githubUsername}/${settings.repoName}`)
        .addButton((btn) =>
          btn.setButtonText("Rename").onClick(async () => {
            await this.startRenameRepository(btn);
          })
        )
        .addButton((btn) =>
          btn.setButtonText("Change repository").onClick(async () => {
            await this.startChangeRepository(btn);
          })
        );
    } else if (this.plugin.hasPendingSetup()) {
      // Authorized but no repository chosen yet — resumable without re-auth.
      new Setting(containerEl)
        .setName("Finish GitHub setup")
        .setDesc(
          `Authorized as @${settings.githubUsername} — choose a repository for this vault to start syncing.`
        )
        .addButton((btn) => {
          btn
            .setButtonText("Choose repository")
            .setCta()
            .onClick(async () => {
              await this.startRepoSelection(btn);
            });
        })
        .addButton((btn) =>
          btn
            .setButtonText("Disconnect")
            .setWarning()
            .onClick(async () => {
              await this.plugin.disconnect();
              this.display();
              new Notice("Disconnected from GitHub.");
            })
        );
    } else {
      // Disconnected state
      new Setting(containerEl)
        .setName("Connect GitHub account")
        .setDesc(
          "Authorise Ultimate Obsidian Sync to access your private repos. Opens a browser window."
        )
        .addButton((btn) => {
          btn
            .setButtonText("Connect GitHub")
            .setCta()
            .onClick(async () => {
              await this.startDeviceFlow(btn);
            });
        });
    }

    new Setting(containerEl).setName("Sync Options").setHeading();

    new Setting(containerEl)
      .setName("Auto-sync")
      .setDesc("Automatically sync when files are modified.")
      .addToggle((toggle) =>
        toggle.setValue(settings.autoSync).onChange(async (val) => {
          settings.autoSync = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Sync debounce (ms)")
      .setDesc("Wait after the last edit before syncing. Default 1000ms; 500ms steps (500–10000).")
      .addSlider((slider) =>
        slider
          .setLimits(SYNC_DEBOUNCE_MIN_MS, SYNC_DEBOUNCE_MAX_MS, SYNC_DEBOUNCE_STEP_MS)
          .setValue(settings.syncIntervalMs)
          .setDynamicTooltip()
          .onChange(async (val) => {
            await this.plugin.setSyncIntervalMs(val);
          })
      );

    new Setting(containerEl)
      .setName("Commit message template")
      .setDesc("Template for auto-sync commit messages. Available placeholder: {{datetime}}")
      .addText((text) =>
        text
          .setPlaceholder("sync: {{datetime}}")
          .setValue(settings.commitMessageTemplate)
          .onChange(async (val) => {
            settings.commitMessageTemplate = val || "sync: {{datetime}}";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync on window focus")
      .setDesc("Pull remote changes when the window or tab regains focus.")
      .addToggle((toggle) =>
        toggle.setValue(settings.syncOnFocus).onChange(async (val) => {
          settings.syncOnFocus = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Background pulling")
      .setDesc(
        "Periodically pull remote changes while connected, even without local edits. Keeps two open devices in sync."
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.backgroundPullEnabled).onChange(async (val) => {
          await this.plugin.setBackgroundPullEnabled(val);
        })
      );

    new Setting(containerEl)
      .setName(`Background pull interval (${PULL_INTERVAL_MIN_SEC}–${PULL_INTERVAL_MAX_SEC}s)`)
      .setDesc(
        `Seconds between background pull checks. Default ${PULL_INTERVAL_SEC}s. Applied immediately.`
      )
      .addText((text) =>
        text
          .setValue(String(settings.pullIntervalSec))
          .onChange(async (val) => {
            const parsed = Number.parseInt(val, 10);
            if (Number.isFinite(parsed)) {
              await this.plugin.setPullIntervalSec(parsed);
            }
          })
      );

    new Setting(containerEl)
      .setName("Excluded patterns")
      .setDesc("One pattern per line. These files will never be synced.")
      .addTextArea((ta) =>
        ta
          .setValue(settings.excludePatterns.join("\n"))
          .onChange(async (val) => {
            settings.excludePatterns = val
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Include patterns")
      .setDesc("One pattern per line. Only matching files will be synced. Leave empty to sync everything.")
      .addTextArea((ta) =>
        ta
          .setValue(settings.includePatterns.join("\n"))
          .onChange(async (val) => {
            settings.includePatterns = val
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("Manual Sync").setHeading();

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc("Immediately push all local changes and pull remote changes.")
      .addButton((btn) =>
        btn.setButtonText("Sync Now").setDisabled(connectionState !== "connected").onClick(async () => {
          await this.plugin.triggerManualSync();
        })
      );

    new Setting(containerEl).setName("Debugging").setHeading();
    new Setting(containerEl)
      .setName("Debug log")
      .setDesc(`Sanitized connection and sync diagnostics: ${this.plugin.getDebugLogPath()}`)
      .addButton((btn) =>
        btn.setButtonText("Copy log").onClick(async () => {
          try {
            const log = await this.app.vault.adapter.read(this.plugin.getDebugLogPath());
            await navigator.clipboard.writeText(log);
            new Notice("Debug log copied to clipboard.");
          } catch (err) {
            new Notice(
              `Could not copy log: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Clear log").onClick(async () => {
          await this.plugin.clearDebugLog();
          new Notice("Ultimate Obsidian Sync debug log cleared.");
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Copy diagnostics").onClick(async () => {
          try {
            const snapshot = await this.buildDiagnostics();
            await navigator.clipboard.writeText(snapshot);
            new Notice("Diagnostics copied to clipboard.");
          } catch (err) {
            new Notice(
              `Could not copy diagnostics: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        })
      );

    const outcome = settings.lastSyncOutcome;
    if (outcome) {
      const label =
        outcome.status === "ok" ? "OK" : outcome.status === "conflict" ? "CONFLICT" : "ERROR";
      const codeText = outcome.code ? ` (${outcome.code})` : "";
      let message = "";
      if (outcome.message) {
        if (outcome.code) {
          // Code + raw message stored: render the friendly mapping, not raw text.
          const info = errorInfo(outcome.message);
          message = info.action ? ` — ${info.message} ${info.action}` : ` — ${info.message}`;
        } else {
          // Legacy outcome without a code: keep the stored message as-is.
          message = ` — ${outcome.message.slice(0, 200)}`;
        }
      }
      containerEl.createEl("p", {
        text: `Last sync result: ${label}${codeText} · ${this.relativeTime(outcome.timestamp)}${message}`,
        cls: "setting-item-description",
      });
    }

    // ── Last sync time ────────────────────────────────────────────────────────
    if (settings.lastSyncTime > 0) {
      const lastSync = new Date(settings.lastSyncTime).toLocaleString();
      containerEl.createEl("p", {
        text: `Last synced: ${lastSync}`,
        cls: "setting-item-description",
      });
    }
  }

  hide(): void {
    this.isDisplayed = false;
    super.hide();
  }

  private relativeTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }

  /** One-click sanitized snapshot for bug reports: version, state, outcome, log tail. */
  private async buildDiagnostics(): Promise<string> {
    const settings = this.plugin.settings;
    const outcome = settings.lastSyncOutcome;
    const lines: string[] = [];
    lines.push("Ultimate Obsidian Sync — diagnostics");
    lines.push(
      `Plugin: ${this.plugin.manifest.id} v${this.plugin.manifest.version ?? "unknown"} · built ${BUILD_TIMESTAMP}`
    );
    lines.push(`Version: ${this.plugin.manifest.version ?? "unknown"}`);
    lines.push(`Platform: ${Platform.isMobile ? "mobile" : "desktop"}`);
    lines.push(`Connection state: ${this.plugin.getConnectionState()}`);
    lines.push(
      settings.githubUsername
        ? `Signed in as: @${settings.githubUsername}`
        : "Signed in as: (not connected)"
    );
    lines.push(`Repository: ${settings.repoName || "(none)"}`);
    if (outcome) {
      const label =
        outcome.status === "ok" ? "OK" : outcome.status === "conflict" ? "CONFLICT" : "ERROR";
      lines.push(
        `Last sync: ${label}${outcome.code ? ` (${outcome.code})` : ""}` +
          (outcome.message ? ` — ${outcome.message}` : "") +
          ` at ${new Date(outcome.timestamp).toISOString()}`
      );
    } else {
      lines.push("Last sync: never");
    }
    lines.push(
      `Auto-sync: ${settings.autoSync} · Debounce: ${settings.syncIntervalMs}ms · Sync on focus: ${settings.syncOnFocus}`
    );
    lines.push(
      `Exclude patterns: ${settings.excludePatterns.length} · Include patterns: ${settings.includePatterns.length}`
    );
    lines.push(`Commit message template: ${settings.commitMessageTemplate || "(default)"}`);
    lines.push("--- debug log (last 150 lines) ---");
    const tail = await this.plugin.getLogTail(150);
    lines.push(tail || "(no log entries yet)");
    return lines.join("\n");
  }

  /**
   * Rename the connected repository (server-side PATCH — history preserved,
   * other devices keep syncing via GitHub's old-URL redirect).
   */
  private async startRenameRepository(btn: ButtonComponent): Promise<void> {
    if (this.plugin.getConnectionState() !== "connected" || !this.plugin.settings.repoName) {
      // Stale UI — refresh so the row disappears.
      this.display();
      return;
    }
    btn.setDisabled(true);
    try {
      await new Promise<void>((resolve) => {
        const modal = new RenameRepoModal(this.app, this.plugin, this.plugin.settings.repoName);
        // Refresh even when the rename lands after the user dismissed the
        // modal mid-request, so the row never shows a stale repo name.
        modal.onRenamed = () => {
          if (this.isDisplayed) this.display();
        };
        modal.onClosed = () => resolve();
        modal.open();
      });
    } finally {
      btn.setDisabled(false);
      if (this.isDisplayed) this.display();
    }
  }

  /**
   * Point this vault at a different repository (existing or new) without
   * disconnecting. Dismissal changes nothing; a failed switch rolls back to
   * the current repository with the connection intact.
   */
  private async startChangeRepository(btn: ButtonComponent): Promise<void> {
    if (this.plugin.getConnectionState() !== "connected" || !this.plugin.settings.repoName) {
      this.display();
      return;
    }
    btn.setDisabled(true);
    try {
      await runChangeRepositoryFlow(this.app, this.plugin, () => {
        if (this.isDisplayed) this.display();
      });
    } catch (err) {
      // runChangeRepositoryFlow reports its own failures; defensive net only.
      const info = errorInfo(err);
      new Notice(
        `Repository change failed: ${info.message}${info.action ? ` ${info.action}` : ""}`
      );
    } finally {
      btn.setDisabled(false);
    }
  }

  /**
   * Resume entry point for the pending-setup state: reopens the repository
   * picker using the persisted authorization — no browser re-authorization.
   */
  private async startRepoSelection(btn: ButtonComponent): Promise<void> {
    if (!this.plugin.hasPendingSetup()) {
      // Stale UI — refresh so the card disappears.
      this.display();
      return;
    }
    if (!this.plugin.beginConnection()) {
      new Notice("A GitHub connection is already in progress.");
      return;
    }
    btn.setButtonText("Opening…").setDisabled(true);
    try {
      await runRepoSelectionFlow(this.app, this.plugin, () => {
        if (this.isDisplayed) this.display();
      });
    } catch (err) {
      // runRepoSelectionFlow reports its own failures; defensive net only.
      const info = errorInfo(err);
      new Notice(`Connection failed: ${info.message}${info.action ? ` ${info.action}` : ""}`);
    } finally {
      btn.setButtonText("Choose repository").setDisabled(false);
    }
  }

  /**
   * Entry point for the Connect GitHub button. The whole interaction — device
   * code, authorization wait, repository selection and repository setup —
   * runs inside the overlay modal managed by runConnectFlow; this wrapper
   * only guards re-entry and keeps the button state honest.
   */
  private async startDeviceFlow(btn: ButtonComponent): Promise<void> {
    if (!this.plugin.beginConnection()) {
      new Notice("A GitHub connection is already in progress.");
      return;
    }
    btn.setButtonText("Connecting…").setDisabled(true);
    try {
      await runConnectFlow(this.app, this.plugin, () => {
        if (this.isDisplayed) this.display();
      });
    } catch (err) {
      // runConnectFlow reports its own failures; this is a defensive net only.
      const info = errorInfo(err);
      new Notice(`Connection failed: ${info.message}${info.action ? ` ${info.action}` : ""}`);
    } finally {
      // On success the tab re-render already shows the connected state; on
      // cancel/failure this restores the Connect button.
      btn.setButtonText("Connect GitHub").setDisabled(false);
    }
  }
}
