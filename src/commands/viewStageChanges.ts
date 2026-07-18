import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { StageNode } from "../views/taskTreeProvider";
import { STAGE_ARTIFACT_FILENAMES, TaskStage } from "../types/taskProgress";
import { previousVersionUri, hasPreviousVersion } from "../utils/artifactBackups";
import { performJournaledRevertSwap, RevertArtifactMutatedError } from "../utils/artifactRevertJournal";
import { resolveCurrentPlanUri } from "../utils/fileUtils";
import { NotificationRouter } from "../utils/notificationRouter";
import { runTrackedOperation } from "../utils/taskOperations";

async function artifactFor(node: StageNode): Promise<vscode.Uri | undefined> {
  if (node.stage === "plan") return resolveCurrentPlanUri(node.task.folderUri);
  const filename = STAGE_ARTIFACT_FILENAMES[node.stage as TaskStage];
  return filename ? vscode.Uri.joinPath(node.task.folderUri, filename) : undefined;
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
    if (!node) return;
    const artifact = await artifactFor(node);
    if (!artifact || !(await hasPreviousVersion(artifact))) {
      NotificationRouter.showInformation(
        "No previous version is available to revert to for this stage.",
        artifact?.fsPath
      );
      return;
    }
    // In-flight-operation gate: the revert holds the task's exclusive
    // operation lock for its whole span, so it is refused while a run that
    // may be writing this artifact is in progress (and, conversely, no such
    // run can start mid-revert). runTrackedOperation shows the standard busy
    // warning on refusal.
    await runTrackedOperation(
      node.task.folderUri.fsPath,
      { label: "Revert Stage Changes", stage: node.stage, taskName: node.task.folderName },
      async () => {
        const artifactName = artifact.path.split("/").pop() ?? artifact.fsPath;
        const openArtifactDoc = (): vscode.TextDocument | undefined =>
          vscode.workspace.textDocuments.find(
            (doc) => doc.uri.toString() === artifact.toString()
          );
        // Refuse while the artifact has unsaved editor changes: a filesystem
        // overwrite would silently clobber the open buffer's state (or a later
        // Ctrl+S would resurrect the pre-revert content over the restored one).
        if (openArtifactDoc()?.isDirty) {
          NotificationRouter.showWarning(
            `${artifactName} has unsaved changes in an open editor. Save or discard them before reverting.`
          );
          return;
        }
        const choice = await vscode.window.showWarningMessage(
          "Are you sure you want to revert the changes? This restores the stage's file to its previous version.",
          { modal: true },
          "Revert Changes"
        );
        if (choice !== "Revert Changes") return;
        // Re-check after the modal: the dirty state can change while it was open.
        const doc = openArtifactDoc();
        if (doc?.isDirty) {
          NotificationRouter.showWarning(
            `${artifactName} picked up unsaved changes while confirming. Save or discard them, then revert again.`
          );
          return;
        }
        // Capture the document version at the clean check — writeArtifact
        // rechecks it just before mutating the buffer, since the file reads
        // below yield and an edit could land in the gap.
        const versionAtCheck = doc?.version;
        const backup = previousVersionUri(artifact);
        const previousBytes = await vscode.workspace.fs.readFile(backup);
        const currentBytes = await vscode.workspace.fs.readFile(artifact);
        // Journal-backed SWAP: the artifact takes the backup's content and
        // the backup takes the pre-revert content, so a revert can itself be
        // reverted; the journal makes an interrupted swap recoverable on the
        // next activation (artifactRevertJournal.ts).
        const writeArtifact = async (content: Uint8Array): Promise<void> => {
          if (doc) {
            // Version/dirty recheck: the clean check above and this edit are
            // separated by awaited file reads, so refuse if the buffer moved
            // in that gap (an edit would be silently clobbered otherwise).
            if (doc.isDirty || doc.version !== versionAtCheck) {
              throw new Error(
                `${artifactName} changed in the editor while reverting. The file was not changed — revert again.`
              );
            }
            // The artifact is open (clean): restore through a WorkspaceEdit +
            // save so the visible buffer reflects the revert immediately and
            // cannot later re-save the pre-revert content over it.
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
              artifact,
              new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
              new TextDecoder().decode(content)
            );
            const applied = await vscode.workspace.applyEdit(edit);
            if (!applied) {
              throw new Error(
                `Could not revert ${artifactName} in the open editor. The file was not changed.`
              );
            }
            if (!(await doc.save())) {
              // The buffer shows the reverted content but the save failed, so
              // the editor is dirty while disk still holds the pre-revert
              // content. NEVER write beneath a dirty editor (a concurrent
              // buffer edit followed by a later manual save would clobber the
              // swap after the backup advanced). Instead roll the buffer back
              // to the pre-revert content through the editor, so buffer and
              // disk agree again and the whole revert is reported as not
              // applied (the journal is then discarded — nothing changed).
              const rollback = new vscode.WorkspaceEdit();
              rollback.replace(
                artifact,
                new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
                new TextDecoder().decode(currentBytes)
              );
              const rolledBack = await vscode.workspace.applyEdit(rollback);
              if (!rolledBack) {
                // Buffer mutated (reverted), disk not, and the rollback edit
                // was refused: the journal must survive so activation-time
                // recovery finishes the swap.
                throw new RevertArtifactMutatedError(
                  `Reverted ${artifactName} in the editor but could not save it, and rolling the editor back also failed. ` +
                    "The revert will be completed automatically when the window reloads."
                );
              }
              // Best effort: clear the now-content-identical dirty flag.
              await doc.save().then(
                () => undefined,
                () => undefined
              );
              throw new Error(
                `Could not save ${artifactName} after reverting it in the editor (the file may be read-only). ` +
                  "The revert was rolled back — nothing was changed."
              );
            }
          } else {
            await vscode.workspace.fs.writeFile(artifact, content);
          }
        };
        try {
          await performJournaledRevertSwap(artifact, backup, currentBytes, previousBytes, writeArtifact);
        } catch (error) {
          void vscode.window.showErrorMessage(
            error instanceof Error ? error.message : String(error)
          );
          return;
        }
        NotificationRouter.showInformation(
          `Reverted ${artifactName} to its previous version. The replaced content is kept as the previous version — revert again to restore it.`,
          artifact.fsPath
        );
      }
    );
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
      { label: "Delete Previous Version", stage: node.stage, taskName: node.task.folderName },
      async () => {
        await vscode.workspace.fs.delete(previousVersionUri(artifact), { useTrash: true });
        NotificationRouter.showInformation("Previous version deleted.", artifact.fsPath);
      }
    );
  }));
}
