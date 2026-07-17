import * as vscode from "vscode";
import { normalizePath } from "../utils/taskRoot";
export type PendingOperationState = "pending" | "claimed" | "running" | "waiting-for-model" | "needs-reconciliation" | "done" | "completed" | "failed" | "cancelled" | "invalid";
export interface PendingOperation { id: string; kind: string; taskCanonicalId: string; createdAt: string; state?: PendingOperationState; payload?: unknown; error?: string; }
export class PendingOperationsStore {
  constructor(private readonly state: vscode.Memento) {}
  get(): PendingOperation[] { return this.state.get<PendingOperation[]>("pendingOperations", []); }
  async add(operation: PendingOperation): Promise<void> { await this.state.update("pendingOperations", [...this.get(), { ...operation, state: operation.state ?? "pending" }]); }
  async update(id: string, state: PendingOperationState, error?: string): Promise<void> { await this.state.update("pendingOperations", this.get().map(item => item.id === id ? { ...item, state, error } : item)); }
  recoverable(): PendingOperation[] { return this.get().filter(item => item.state === "pending" || item.state === "running" || item.state === "waiting-for-model" || item.state === "needs-reconciliation" || !item.state); }
  async remove(id: string): Promise<void> { await this.state.update("pendingOperations", this.get().filter(item => item.id !== id)); }
  /**
   * Drop every persisted operation belonging to one task (canonicalId is a
   * normalized absolute task-folder path — compare normalized so records
   * written with a differently-cased path on Windows still match). Used
   * when a task is archived or repaired: parked/stuck pending records must
   * not survive for a task the user has parked or explicitly repaired.
   * Returns how many records were removed.
   */
  async removeForTask(taskCanonicalId: string): Promise<number> {
    const needle = normalizePath(taskCanonicalId);
    const all = this.get();
    const kept = all.filter(item => normalizePath(item.taskCanonicalId) !== needle);
    if (kept.length !== all.length) {
      await this.state.update("pendingOperations", kept);
    }
    return all.length - kept.length;
  }
}
