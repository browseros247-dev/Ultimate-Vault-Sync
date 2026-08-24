import { App, Modal, Notice } from "obsidian";
import type UltimateObsidianSyncPlugin from "../main";
import { errorInfo } from "../debug/errors";
import { BUILD_TIMESTAMP } from "../constants";
import { validateRepoName } from "../github/api";

/**
 * Small overlay modal for renaming the connected repository (server-side
 * PATCH). Prefills the current name, validates live, and applies via
 * plugin.renameRepository — which pre-checks that the new name is free and
 * surfaces friendly errors. The local git origin is rewritten by the plugin
 * afterwards; GitHub redirects the old URL for any other device.
 */
export class RenameRepoModal extends Modal {
  private plugin: UltimateObsidianSyncPlugin;
  private currentName: string;
  /** Invoked when the modal closes for any reason (rename or dismiss). */
  onClosed: (() => void) | null = null;
  /** Invoked once after a successful rename — even if the modal was already dismissed mid-request. */
  onRenamed: (() => void) | null = null;

  private inputEl: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;
  private confirmBtnEl: HTMLButtonElement | null = null;
  private busy = false;
  private opened = false;

  constructor(app: App, plugin: UltimateObsidianSyncPlugin, currentName: string) {
    super(app);
    this.plugin = plugin;
    this.currentName = currentName;
  }

  onOpen(): void {
    this.opened = true;
    void this.plugin.logInfo("rename-modal.open", "Rename modal opened", {
      currentName: this.currentName,
      build: BUILD_TIMESTAMP,
    });
    this.titleEl.setText("Rename repository");
    const { contentEl } = this;
    contentEl.addClass("uos-connect-modal");

    contentEl.createEl("p", {
      text: `Renaming ${this.plugin.settings.githubUsername}/${this.currentName}. History, issues and stars are preserved, and the old URL will keep redirecting to the new one.`,
      cls: "uos-muted",
    });

    contentEl.createEl("span", {
      text: "New repository name",
      cls: "setting-item-name uos-label-block",
    });

    const input = contentEl.createEl("input", {
      type: "text",
      placeholder: this.currentName,
      cls: "uos-full-input",
    });
    input.value = this.currentName;
    this.inputEl = input;

    const status = contentEl.createEl("p", { cls: "setting-item-description" });
    this.statusEl = status;

    const btnRow = contentEl.createDiv({ cls: "uos-btn-row" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    const confirmBtn = btnRow.createEl("button", { text: "Rename", cls: "mod-cta" });
    this.confirmBtnEl = confirmBtn;

    cancelBtn.addEventListener("click", () => this.close());
    confirmBtn.addEventListener("click", () => {
      void this.handleConfirm();
    });
    input.addEventListener("input", () => this.updateForm());

    this.updateForm();
  }

  onClose(): void {
    this.opened = false;
    void this.plugin.logInfo("rename-modal.close", "Rename modal closed", {
      currentName: this.currentName,
    });
    this.onClosed?.();
    this.contentEl.empty();
  }

  private setStatus(text: string, isError = false): void {
    if (!this.statusEl) return;
    this.statusEl.setText(text);
    this.statusEl.toggleClass("uos-error-text", isError);
  }

  /** Live validation; the unchanged name disables the confirm button. */
  private updateForm(): void {
    if (!this.confirmBtnEl || !this.inputEl) return;
    const name = this.inputEl.value.trim();
    if (name === this.currentName) {
      this.setStatus("Name unchanged.");
      this.confirmBtnEl.disabled = true;
      return;
    }
    const error = validateRepoName(name);
    if (error) {
      this.setStatus(error, true);
      this.confirmBtnEl.disabled = true;
    } else {
      this.setStatus("");
      this.confirmBtnEl.disabled = false;
    }
  }

  private async handleConfirm(): Promise<void> {
    const input = this.inputEl;
    const confirmBtn = this.confirmBtnEl;
    if (!input || !confirmBtn || this.busy) return;

    const newName = input.value.trim();
    if (validateRepoName(newName) || newName === this.currentName) {
      this.updateForm();
      return;
    }

    this.busy = true;
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Renaming…";
    try {
      await this.plugin.renameRepository(newName);
      void this.plugin.logInfo("rename.success", "Repository renamed", {
        from: this.currentName,
        to: newName,
      });
      // Fire even if the user dismissed the modal mid-request, so the
      // settings tab can re-render the new repository name.
      this.onRenamed?.();
      new Notice(`Repository renamed to ${newName}.`);
      if (this.opened) this.close();
    } catch (error) {
      const info = errorInfo(error);
      void this.plugin.logInfo("rename.failed", "Repository rename failed", {
        code: info.code,
        detail: info.detail,
      });
      this.setStatus(info.action ? `${info.message} ${info.action}` : info.message, true);
      confirmBtn.textContent = "Rename";
      this.busy = false;
      // The name field may have been edited while the request ran — revalidate.
      this.updateForm();
    }
  }
}
