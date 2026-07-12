import * as path from "path";

/** Explicit identity for a task-bound operation. */
export interface TaskRef {
  canonicalId: string;
  taskFolder: string;
  metaRoot: string;
  projectRoot: string;
  ownershipState: "resolved" | "ownership-unresolved";
}

export interface TaskOwnershipVerifier {
  verify(ref: TaskRef): Promise<boolean> | boolean;
}

/** Build the immutable identity used at command boundaries. */
export function taskRefFromResolved(value: {
  canonicalId: string; taskFolderPath: string; workspaceFolder?: { fsPath: string }; metaRoot?: string;
}): TaskRef {
  const projectRoot = value.workspaceFolder?.fsPath;
  if (!projectRoot) throw new Error(`Task ownership is unresolved: ${value.canonicalId}`);
  return {
    canonicalId: value.canonicalId,
    taskFolder: value.taskFolderPath,
    metaRoot: value.metaRoot ? path.resolve(value.metaRoot) : path.resolve(value.taskFolderPath, ".."),
    projectRoot,
    ownershipState: "resolved",
  };
}

export function assertResolvedTaskOwnership(ref: TaskRef): void {
  if (ref.ownershipState !== "resolved") {
    throw new Error(`Task ownership is unresolved: ${ref.canonicalId}`);
  }
}
