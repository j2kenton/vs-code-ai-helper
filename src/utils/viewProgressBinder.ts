import * as vscode from "vscode";
import { TASKS_VIEW_ID } from "../views/taskTreeProvider";
import { STATUS_VIEW_ID } from "../views/statusView";
import { TaskOperationRegistry } from "./taskOperations";

export class ViewProgressBinder implements vscode.Disposable {
  private readonly sub: vscode.Disposable;
  private resolveIdle?: () => void;

  constructor(private readonly registry: TaskOperationRegistry) {
    this.sub = this.registry.onDidChange(() => this.sync());
    this.sync();
  }

  private sync(): void {
    const busy = this.registry.hasAny();
    if (busy && !this.resolveIdle) {
      const idle = new Promise<void>((r) => {
        this.resolveIdle = r;
      });
      for (const viewId of [TASKS_VIEW_ID, STATUS_VIEW_ID]) {
        void vscode.window.withProgress({ location: { viewId } }, () => idle);
      }
    } else if (!busy && this.resolveIdle) {
      const r = this.resolveIdle;
      this.resolveIdle = undefined;
      r();
    }
  }

  dispose(): void {
    this.sub.dispose();
    // Resolve any in-flight bar so it does not hang on the view after deactivate.
    const resolve = this.resolveIdle;
    this.resolveIdle = undefined;
    resolve?.();
  }
}
