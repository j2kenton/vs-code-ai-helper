import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { StageNode } from "../views/taskTreeProvider";
import { STAGE_ARTIFACT_FILENAMES, TaskStage } from "../types/taskProgress";
import { previousVersionUri, hasPreviousVersion } from "../utils/artifactBackups";
import { performJournaledRevertSwap, RevertArtifactMutatedError, revertJournalUri } from "../utils/artifactRevertJournal";
import { resolveCurrentPlanUri, withPlanFileWriteLockV1, markOwnSaveInFlightV1, clearOwnSaveInFlightV1 } from "../utils/fileUtils";
import { NotificationRouter } from "../utils/notificationRouter";
import { runTrackedOperation, resolveWorkflowRootTaskName } from "../utils/taskOperations";
import {
  readRedoSidecar,
  isRedoAvailableFromRecord,
  isRevertAvailableFromRecord,
  deleteRedoSidecar,
  fingerprintBytes,
} from "../utils/redoSidecar";

/** True when an interrupted swap's recovery journal is still on disk. */
async function hasPendingRevertJournal(artifact: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(revertJournalUri(artifact));
    return true;
  } catch {
    return false;
  }
}

/** Which direction of the (symmetric) artifact/backup swap this invocation performs. */
type StageSwapKind = "revert" | "redo";

async function artifactFor(node: StageNode): Promise<vscode.Uri | undefined> {
  if (node.stage === "plan") return resolveCurrentPlanUri(node.task.folderUri);
  const filename = STAGE_ARTIFACT_FILENAMES[node.stage as TaskStage];
  return filename ? vscode.Uri.joinPath(node.task.folderUri, filename) : undefined;
}

/**
 * Shared body for Revert Changes / Redo Changes: performJournaledRevertSwap's
 * swap of the artifact with its `_prev` backup is symmetric, so "redo" is
 * exactly "run the same swap again" — the only difference between the two
 * commands is the confirmation/result wording and which side of the durable
 * redo sidecar (utils/redoSidecar.ts) they leave the artifact on.
 */
async function performStageSwap(node: StageNode | undefined, kind: StageSwapKind): Promise<void> {
  if (!node) return;
  const artifact = await artifactFor(node);
  if (!artifact || !(await hasPreviousVersion(artifact))) {
    NotificationRouter.showInformation(
      kind === "revert"
        ? "No previous version is available to revert to for this stage."
        : "No reverted change is available to redo for this stage.",
      artifact?.fsPath
    );
    return;
  }
  // A pending recovery journal means a previous swap for this artifact was
  // interrupted (crash, sidecar-write failure) and has not yet been
  // finalized by activation-time recovery. Its files may currently be
  // mid-swap or its durable direction stale, so refuse EITHER direction
  // until the journal is resolved — running another symmetric swap on top
  // of an unresolved one risks silently discarding a version. Reloading the
  // window re-runs recoverRevertJournals, which finishes it deterministically.
  if (await hasPendingRevertJournal(artifact)) {
    NotificationRouter.showWarning(
      `${artifact.path.split("/").pop() ?? artifact.fsPath} has an interrupted revert/redo that has not finished recovering. ` +
        "Reload the window to finish recovery before reverting or redoing again.",
      artifact.fsPath
    );
    return;
  }

  const existingSidecar = await readRedoSidecar(artifact);
  if (kind === "redo" && !isRedoAvailableFromRecord(existingSidecar)) {
    NotificationRouter.showInformation(
      "No reverted change is available to redo for this stage.",
      artifact.fsPath
    );
    return;
  }
  // Symmetric guard for the other direction: a stale UI/context token (e.g.
  // a second window, or a tree that hasn't refreshed yet) could otherwise
  // let Revert Changes run again while the artifact is already on the
  // reverted side — which would silently perform a redo under the "Revert"
  // label and message. Refuse and point at the correct action instead.
  if (kind === "revert" && !isRevertAvailableFromRecord(existingSidecar)) {
    NotificationRouter.showInformation(
      "This stage has already been reverted. Use Redo Changes to restore the replaced content, or nothing more to revert.",
      artifact.fsPath
    );
    return;
  }

  const verb = kind === "revert" ? "revert" : "redo";
  const confirmLabel = kind === "revert" ? "Revert Changes" : "Redo Changes";

  // In-flight-operation gate: the swap holds the task's exclusive operation
  // lock for its whole span, so it is refused while a run that may be writing
  // this artifact is in progress (and, conversely, no such run can start
  // mid-swap). runTrackedOperation shows the standard busy warning on refusal.
  await runTrackedOperation(
    node.task.folderUri.fsPath,
    {
      label: kind === "revert" ? "Revert Stage Changes" : "Redo Stage Changes",
      stage: node.stage,
      taskName: resolveWorkflowRootTaskName(node.task.progress?.displayName, node.task.folderUri.fsPath),
    },
    async () => {
      const artifactName = artifact.path.split("/").pop() ?? artifact.fsPath;
      const openArtifactDoc = (): vscode.TextDocument | undefined =>
        vscode.workspace.textDocuments.find(
          (doc) => doc.uri.toString() === artifact.toString()
        );
      // Refuse while the artifact has unsaved editor changes: a filesystem
      // overwrite would silently clobber the open buffer's state (or a later
      // Ctrl+S would resurrect the pre-swap content over the restored one).
      if (openArtifactDoc()?.isDirty) {
        NotificationRouter.showWarning(
          `${artifactName} has unsaved changes in an open editor. Save or discard them before you ${verb}.`
        );
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        kind === "revert"
          ? "Are you sure you want to revert the changes? This restores the stage's file to its previous version."
          : "Are you sure you want to redo? This restores the content that the last revert replaced.",
        { modal: true },
        confirmLabel
      );
      if (choice !== confirmLabel) return;
      // Re-check after the modal: the dirty state can change while it was open.
      const doc = openArtifactDoc();
      if (doc?.isDirty) {
        NotificationRouter.showWarning(
          `${artifactName} picked up unsaved changes while confirming. Save or discard them, then ${verb} again.`
        );
        return;
      }
      // Capture the document version at the clean check — writeArtifact
      // rechecks it just before mutating the buffer, since the file reads
      // below yield and an edit could land in the gap.
      const versionAtCheck = doc?.version;

      // Serialized against every other writer of this artifact —
      // writeTextFileIfUnchangedV1 callers (reconcile, review-round
      // checklist merges) and materializeCanonicalIfNeeded/preparePlanPromotion
      // — via the same per-uri queue, so this swap's own read-then-write
      // cannot interleave with theirs (review-flagged 2026-08-26, narrowed
      // task-fixable blocker `739cfbbb-…-1`: this surface previously mutated
      // plan-final.md entirely outside that coordinator).
      await withPlanFileWriteLockV1(artifact, async () => {
        const backup = previousVersionUri(artifact);
        const previousBytes = await vscode.workspace.fs.readFile(backup);
        const currentBytes = await vscode.workspace.fs.readFile(artifact);

        // Revalidate the redo sidecar against the just-read bytes, in the
        // same locked section (runTrackedOperation, and now also this
        // per-uri write lock) immediately before swapping. If the sidecar
        // exists but its fingerprints no longer match the files — e.g. an
        // out-of-band edit, or a partially-applied earlier swap — the
        // sidecar's picture of "which side the artifact is on" can no longer
        // be trusted, so refuse the swap rather than risk overwriting
        // content the sidecar never saw. A missing/unknown sidecar is the
        // safe default and is not checked (matches pre-existing behavior).
        const sidecar = await readRedoSidecar(artifact);
        if (sidecar) {
          const expectedMatches =
            sidecar.artifactFingerprint === fingerprintBytes(currentBytes) &&
            sidecar.backupFingerprint === fingerprintBytes(previousBytes);
          if (!expectedMatches) {
            await deleteRedoSidecar(artifact);
            NotificationRouter.showWarning(
              `${artifactName}'s previous-version history is out of sync with its files (likely an out-of-band edit). ` +
                `Refusing to ${verb} to avoid losing content — the Redo/Revert history for this stage has been cleared.`,
              artifact.fsPath
            );
            return;
          }
          // Direction re-check under the lock: even with matching
          // fingerprints, a concurrent swap serialized just ahead of this
          // one (same task, same exclusive operation lock) could have
          // flipped the direction. Refuse rather than perform the
          // wrong-labeled swap.
          const directionOk = kind === "redo"
            ? isRedoAvailableFromRecord(sidecar)
            : isRevertAvailableFromRecord(sidecar);
          if (!directionOk) {
            NotificationRouter.showInformation(
              kind === "redo"
                ? "No reverted change is available to redo for this stage."
                : "This stage has already been reverted. Use Redo Changes to restore the replaced content.",
              artifact.fsPath
            );
            return;
          }
        }

        // Journal-backed SWAP: the artifact takes the backup's content and
        // the backup takes the pre-swap content, so both revert and redo are
        // themselves reversible; the journal makes an interrupted swap
        // recoverable on the next activation (artifactRevertJournal.ts).
        const writeArtifact = async (content: Uint8Array): Promise<void> => {
          if (doc) {
            // Version/dirty recheck: the clean check above and this edit are
            // separated by awaited file reads, so refuse if the buffer moved
            // in that gap (an edit would be silently clobbered otherwise).
            if (doc.isDirty || doc.version !== versionAtCheck) {
              throw new Error(
                `${artifactName} changed in the editor while performing this action. The file was not changed — try again.`
              );
            }
            // The artifact is open (clean): restore through a WorkspaceEdit +
            // save so the visible buffer reflects the change immediately and
            // cannot later re-save the pre-swap content over it.
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
              artifact,
              new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
              new TextDecoder().decode(content)
            );
            const applied = await vscode.workspace.applyEdit(edit);
            if (!applied) {
              throw new Error(
                `Could not update ${artifactName} in the open editor. The file was not changed.`
              );
            }
            // Own-save exemption bracketed as tightly as possible (mirrors
            // writeTextFile's onBeforeSave seam): set only immediately before
            // this save call, not around the preceding applyEdit await, so a
            // genuinely separate will-save arriving during applyEdit is still
            // correctly deferred by the guard rather than waved through.
            markOwnSaveInFlightV1(artifact);
            let saved: boolean;
            try {
              saved = await doc.save();
            } finally {
              clearOwnSaveInFlightV1(artifact);
            }
            if (!saved) {
              // The buffer shows the new content but the save failed, so the
              // editor is dirty while disk still holds the pre-swap content.
              // NEVER write beneath a dirty editor (a concurrent buffer edit
              // followed by a later manual save would clobber the swap after
              // the backup advanced). Instead roll the buffer back to the
              // pre-swap content through the editor, so buffer and disk agree
              // again and the whole action is reported as not applied (the
              // journal is then discarded — nothing changed).
              const rollback = new vscode.WorkspaceEdit();
              rollback.replace(
                artifact,
                new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
                new TextDecoder().decode(currentBytes)
              );
              const rolledBack = await vscode.workspace.applyEdit(rollback);
              if (!rolledBack) {
                // Buffer mutated, disk not, and the rollback edit was
                // refused: the journal must survive so activation-time
                // recovery finishes the swap.
                throw new RevertArtifactMutatedError(
                  `Updated ${artifactName} in the editor but could not save it, and rolling the editor back also failed. ` +
                    "The change will be completed automatically when the window reloads."
                );
              }
              // Best effort: clear the now-content-identical dirty flag.
              markOwnSaveInFlightV1(artifact);
              try {
                await doc.save();
              } catch {
                // Best-effort only — the error below is what actually reports.
              } finally {
                clearOwnSaveInFlightV1(artifact);
              }
              throw new Error(
                `Could not save ${artifactName} (the file may be read-only). ` +
                  "The action was rolled back — nothing was changed."
              );
            }
          } else {
            await vscode.workspace.fs.writeFile(artifact, content);
          }
        };
        let swapResult: { sidecarFinalized: boolean };
        try {
          swapResult = await performJournaledRevertSwap(
            artifact,
            backup,
            currentBytes,
            previousBytes,
            writeArtifact,
            undefined,
            kind === "revert" ? "reverted" : "applied"
          );
        } catch (error) {
          NotificationRouter.showError(
            error instanceof Error ? error.message : String(error)
          );
          return;
        }
        // The durable redo sidecar (redoSidecar.ts) is written by
        // performJournaledRevertSwap itself as part of the journaled swap, so
        // no separate bookkeeping is needed here — reverting makes a redo
        // available; redoing consumes it (the artifact is back on its
        // "revert-available" side), and it survives a reload/crash.
        if (!swapResult.sidecarFinalized) {
          // The file swap landed, but the durable redo-direction sidecar could
          // not be written this session — the journal was kept so the next
          // window reload finalizes it. Until then the tree still reflects the
          // PRE-swap direction, so do NOT claim the opposite action is now
          // available.
          NotificationRouter.showWarning(
            `${kind === "revert" ? "Reverted" : "Redid"} ${artifactName}, but could not record the change in its Redo/Revert history. ` +
              "Reload the window to finish updating Redo/Revert availability for this stage.",
            artifact.fsPath
          );
          return;
        }
        NotificationRouter.showInformation(
          kind === "revert"
            ? `Reverted ${artifactName} to its previous version. Use Redo Changes to restore the replaced content.`
            : `Redid the revert of ${artifactName}, restoring the previously replaced content.`,
          artifact.fsPath
        );
      });
    }
  );
}

export function registerViewStageChangesCommands(context: vscode.ExtensionContext, _inventory: TaskInventory): void {
  context.subscriptions.push(vscode.commands.registerCommand("vs-code-ai-helper.viewStageChanges", async (node?: StageNode) => {
    if (!node) return;
    const artifact = await artifactFor(node);
    if (!artifact || !(await hasPreviousVersion(artifact))) {
      NotificationRouter.showInformation(
        "No previous version is available for this stage yet.",
        artifact?.fsPath
      );
      return;
    }
    await vscode.commands.executeCommand("vscode.diff", previousVersionUri(artifact), artifact, `${artifact.path.split("/").pop()} — previous ↔ current`);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("vs-code-ai-helper.revertStageChanges", async (node?: StageNode) => {
    await performStageSwap(node, "revert");
  }));
  context.subscriptions.push(vscode.commands.registerCommand("vs-code-ai-helper.redoStageChanges", async (node?: StageNode) => {
    await performStageSwap(node, "redo");
  }));
  context.subscriptions.push(vscode.commands.registerCommand("vs-code-ai-helper.deleteStageBackup", async (node?: StageNode) => {
    if (!node) return;
    const artifact = await artifactFor(node);
    if (!artifact || !(await hasPreviousVersion(artifact))) {
      NotificationRouter.showInformation("No previous version is available to delete.", artifact?.fsPath);
      return;
    }
    // Tracked so it is serialized against a concurrent revert of the same
    // backup, and so the operation-end event refreshes the tree (clearing
    // the row's has-backup context token).
    await runTrackedOperation(
      node.task.folderUri.fsPath,
      {
        label: "Delete Previous Version",
        stage: node.stage,
        taskName: resolveWorkflowRootTaskName(
          node.task.progress?.displayName ?? node.task.folderName,
          node.task.folderUri.fsPath
        ),
      },
      async () => {
        await vscode.workspace.fs.delete(previousVersionUri(artifact), { useTrash: true });
        await deleteRedoSidecar(artifact);
        NotificationRouter.showInformation("Previous version deleted.", artifact.fsPath);
      }
    );
  }));
}
