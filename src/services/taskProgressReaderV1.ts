/**
 * Strict V1 task-progress reader (plan §3.10/§3.12 consumer cutover).
 *
 * Reads `task-progress.json` and decodes it with `decodeTaskProgressTextV1`
 * — no normalization, no silently-invented values. A missing/unreadable file
 * is reported distinctly (`code: "missing"`) from an unsupported/invalid
 * document (a decoder recovery result): both are failures a caller must
 * handle explicitly, unlike the permissive reader's single collapsed
 * `undefined`. Fenced from the permissive legacy reader/writer exactly like
 * the rest of the strict stack (scripts/verifyProgressReaderFence.mjs).
 */
import * as vscode from "vscode";
import { TASK_PROGRESS_FILENAME } from "../types/taskProgress";
import {
  DecodeTaskProgressOptionsV1,
  TaskProgressDecodeResultV1,
  decodeTaskProgressTextV1,
} from "./taskProgressDecoderV1";

export type TaskProgressReadResultV1 =
  | TaskProgressDecodeResultV1
  | { readonly ok: false; readonly code: "missing"; readonly reason: string };

/**
 * Strictly read and decode one task's `task-progress.json`. Returns
 * `{ ok: false, code: "missing" }` when the file does not exist or cannot be
 * read; any other unsupported/invalid content is the decoder's own recovery
 * result — never coerced, never silently dropped.
 */
export async function readTaskProgressStrictV1(
  taskFolderUri: vscode.Uri,
  options?: DecodeTaskProgressOptionsV1
): Promise<TaskProgressReadResultV1> {
  const progressFileUri = vscode.Uri.joinPath(taskFolderUri, TASK_PROGRESS_FILENAME);
  let text: string;
  try {
    const content = await vscode.workspace.fs.readFile(progressFileUri);
    text = new TextDecoder().decode(content);
  } catch (error) {
    return {
      ok: false,
      code: "missing",
      reason: `task-progress.json could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return decodeTaskProgressTextV1(text, options);
}
