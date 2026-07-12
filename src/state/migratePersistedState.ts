import { migrateStage, migrateStatus, TaskProgress } from "../types/taskProgress";
import { PERSISTED_SCHEMA_VERSION, PersistedStateEnvelope } from "./persistedSchema";

export function migratePersistedState(value: unknown): PersistedStateEnvelope<TaskProgress> {
  const envelope = value && typeof value === "object" && "data" in value ? value as PersistedStateEnvelope<TaskProgress> : { schemaVersion: 1, data: value as TaskProgress };
  const legacyStage = String(envelope.data?.currentStage ?? "desc");
  const legacyStatus = (envelope.data as unknown as { status?: unknown } | undefined)?.status;
  // Older versions used a synthetic "completed" stage.  Preserve completion
  // when the task already has a completion timestamp or publish artifacts;
  // otherwise it was only an attempted transition and must remain actionable.
  const legacyData = (envelope.data ?? {}) as TaskProgress & { publishArtifact?: unknown; artifacts?: unknown };
  const hasCompletionEvidence = Boolean(
    legacyData.completedAt || legacyData.publishArtifact || legacyData.artifacts
  );
  const legacyCompleted = legacyStage === "completed" || legacyStatus === "finished" || legacyStatus === "done";
  const completed = legacyCompleted && (hasCompletionEvidence || legacyStatus === "finished" || legacyStatus === "done");
  const data = {
    ...envelope.data,
    currentStage: completed ? "publish" : migrateStage(legacyStage === "completed" ? "publish" : legacyStage),
    status: completed ? "completed" : migrateStatus(envelope.data?.status),
    ...(completed && !envelope.data?.completedAt ? { completedAt: new Date().toISOString() } : {}),
  };
  return { schemaVersion: PERSISTED_SCHEMA_VERSION, data };
}
