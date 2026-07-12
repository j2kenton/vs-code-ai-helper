import * as vscode from "vscode";
export type PendingOperationState = "pending" | "claimed" | "running" | "waiting-for-model" | "needs-reconciliation" | "done" | "completed" | "failed" | "cancelled" | "invalid";
export interface PendingOperation { id: string; kind: string; taskCanonicalId: string; createdAt: string; state?: PendingOperationState; payload?: unknown; error?: string; }
export class PendingOperationsStore {
  constructor(private readonly state: vscode.Memento) {}
  get(): PendingOperation[] { return this.state.get<PendingOperation[]>("pendingOperations", []); }
  async add(operation: PendingOperation): Promise<void> { await this.state.update("pendingOperations", [...this.get(), { ...operation, state: operation.state ?? "pending" }]); }
  async update(id: string, state: PendingOperationState, error?: string): Promise<void> { await this.state.update("pendingOperations", this.get().map(item => item.id === id ? { ...item, state, error } : item)); }
  recoverable(): PendingOperation[] { return this.get().filter(item => item.state === "pending" || item.state === "running" || item.state === "waiting-for-model" || item.state === "needs-reconciliation" || !item.state); }
  async remove(id: string): Promise<void> { await this.state.update("pendingOperations", this.get().filter(item => item.id !== id)); }
}
