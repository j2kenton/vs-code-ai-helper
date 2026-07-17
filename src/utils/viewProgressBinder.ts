import * as vscode from "vscode";
import { STATUS_VIEW_ID } from "../views/statusView";
import { TaskOperationRegistry } from "./taskOperations";

/**
 * How long the registry must stay busy before the Tasks view progress bar is
 * shown. Instant mutations (create/rename/pause/complete persist in
 * milliseconds) would otherwise flash the bar for a single frame — the
 * reported intermittent "blue flicker in the top left of the Tasks section".
 * Long-running operations (AI runs, commit/push) comfortably outlast this
 * delay, so their bar still appears effectively immediately; the optimistic
 * in-progress state for instant actions is carried by the Notifications
 * operation row and stage-row spinner, not by this bar.
 */
export const VIEW_PROGRESS_SHOW_DELAY_MS = 250;

export class ViewProgressBinder implements vscode.Disposable {
  private readonly sub: vscode.Disposable;
  private resolveIdle?: () => void;
  private showTimer?: NodeJS.Timeout;

  constructor(
    private readonly registry: TaskOperationRegistry,
    private readonly showDelayMs: number = VIEW_PROGRESS_SHOW_DELAY_MS
  ) {
    this.sub = this.registry.onDidChange(() => this.sync());
    this.sync();
  }

  private sync(): void {
    const busy = this.registry.hasAny();
    if (busy && !this.resolveIdle && !this.showTimer) {
      // Debounced show: only surface the bar if the registry is still busy
      // once the delay elapses, so sub-delay operations never flash it.
      this.showTimer = setTimeout(() => {
        this.showTimer = undefined;
        if (!this.registry.hasAny() || this.resolveIdle) {
          return;
        }
        const idle = new Promise<void>((r) => {
          this.resolveIdle = r;
        });
        // The horizontal progress animation lives on the Notifications view
        // (where the running-operation rows already are), NOT the tasks
        // area — per-row spinners in the Tasks view are untouched.
        void vscode.window.withProgress({ location: { viewId: STATUS_VIEW_ID } }, () => idle);
      }, this.showDelayMs);
    } else if (!busy) {
      if (this.showTimer) {
        clearTimeout(this.showTimer);
        this.showTimer = undefined;
      }
      if (this.resolveIdle) {
        const r = this.resolveIdle;
        this.resolveIdle = undefined;
        r();
      }
    }
  }

  dispose(): void {
    this.sub.dispose();
    if (this.showTimer) {
      clearTimeout(this.showTimer);
      this.showTimer = undefined;
    }
    // Resolve any in-flight bar so it does not hang on the view after deactivate.
    const resolve = this.resolveIdle;
    this.resolveIdle = undefined;
    resolve?.();
  }
}
