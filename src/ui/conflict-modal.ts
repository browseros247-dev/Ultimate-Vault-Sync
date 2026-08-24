import { App, Modal, Setting, Component } from "obsidian";
import { ConflictFile } from "../types";
import { diffSummary } from "../sync/conflict";

type ResolveCallback = (filepath: string, resolvedContent: string) => Promise<void>;

export class ConflictModal extends Modal {
  private conflicts: ConflictFile[];
  private currentIndex = 0;
  private onResolve: ResolveCallback;
  private component: Component;
  onClosed: (() => void) | null = null;

  constructor(app: App, conflicts: ConflictFile[], onResolve: ResolveCallback) {
    super(app);
    this.conflicts = conflicts;
    this.onResolve = onResolve;
    this.component = new Component();
  }

  onOpen(): void {
    this.component.load();
    this.renderCurrent();
  }

  onClose(): void {
    this.component.unload();
    this.contentEl.empty();
    this.onClosed?.();
  }

  private renderCurrent(): void {
    const conflict = this.conflicts[this.currentIndex];
    const { contentEl } = this;
    contentEl.empty();

    this.titleEl.setText(
      `Sync Conflict (${this.currentIndex + 1} / ${this.conflicts.length})`
    );
    contentEl.createEl("p", {
      text: `File: ${conflict.path}`,
      cls: "conflict-filepath",
    });

    // Diff summary
    const diffEl = contentEl.createEl("pre", { cls: "uos-conflict-diff" });
    diffEl.textContent = diffSummary(conflict);

    // Two-column layout
    const cols = contentEl.createDiv({ cls: "uos-conflict-columns" });

    // OURS
    const oursCol = cols.createDiv();
    oursCol.createEl("strong", { text: "Your version (this device)" });
    const oursPre = oursCol.createEl("pre", { cls: "uos-conflict-ours" });
    oursPre.textContent = conflict.binary
      ? "(binary file)"
      : conflict.ours.slice(0, 2000) +
        (conflict.ours.length > 2000 ? "\n…(truncated)" : "");

    // THEIRS
    const theirsCol = cols.createDiv();
    theirsCol.createEl("strong", { text: "Remote version (other device)" });
    const theirsPre = theirsCol.createEl("pre", { cls: "uos-conflict-theirs" });
    theirsPre.textContent = conflict.binary
      ? "(binary file)"
      : conflict.theirs.slice(0, 2000) +
        (conflict.theirs.length > 2000 ? "\n…(truncated)" : "");

    // Action buttons
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Keep Mine").onClick(() => {
          void this.resolve(conflict, conflict.ours);
        })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Keep Theirs")
          .setCta()
          .onClick(() => {
            void this.resolve(conflict, conflict.theirs);
          })
      )
      .addButton((btn) =>
        btn.setButtonText("Open in Editor").onClick(() => {
          this.close();
          this.app.workspace.openLinkText(conflict.path, "", true);
        })
      );
  }

  private async resolve(conflict: ConflictFile, content: string): Promise<void> {
    await this.onResolve(conflict.path, content);
    this.currentIndex++;
    if (this.currentIndex < this.conflicts.length) {
      this.renderCurrent();
    } else {
      this.close();
    }
  }
}
