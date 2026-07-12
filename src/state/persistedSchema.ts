export const PERSISTED_SCHEMA_VERSION = 2;
export interface PersistedStateEnvelope<T> { schemaVersion: number; data: T; }

/** Validate the small amount of shape that every persisted progress document
 * must have before it is allowed onto disk.  This deliberately rejects
 * malformed writes while leaving stage-specific fields extensible. */
export function validatePersistedTaskProgress(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Persisted task state must be an object.");
  const item = value as Record<string, unknown>;
  if (typeof item.currentStage !== "string" || typeof item.status !== "string" || typeof item.updatedAt !== "string") {
    throw new Error("Persisted task state is missing currentStage, status, or updatedAt.");
  }
  if (item.completedAt !== undefined && typeof item.completedAt !== "string") throw new Error("completedAt must be an ISO string.");
}
