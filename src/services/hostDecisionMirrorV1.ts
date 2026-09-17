import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";

/**
 * The runner's pending workflow decisions, visible and answerable in every
 * viewer window (hostRoleV1.ts).
 *
 * Decisions ("Advance to Publish / Keep iterating / Leave it paused") live in
 * the raising window's own `workspaceState`, which another VS Code process
 * cannot read. A viewer therefore showed "escalated" on the stage with no
 * decision icon and no decision card in chat — the task sat paused on a
 * question the user could not see (seen live 2026-09-17).
 *
 * The runner writes its pending decisions to `<relay dir>/decisions-v1.json`
 * whenever they change. A viewer hands its decision store a Memento whose
 * decisions key reads that file (everything else stays the viewer's own
 * workspaceState), so the tree and chat render the runner's decisions with
 * their ordinary code. An answer is never recorded here: the viewer relays it
 * to the runner, which resolves the decision and runs its effect exactly as
 * a click on the runner would. VS Code-free (type imports only), so it is
 * unit-testable.
 */

export const HOST_DECISIONS_MIRROR_FILENAME_V1 = "decisions-v1.json";

/** Runner side: write the pending decisions atomically. Never throws. */
export async function writeRunnerDecisionsSnapshotV1(dir: string, decisions: readonly unknown[]): Promise<void> {
  const file = path.join(dir, HOST_DECISIONS_MIRROR_FILENAME_V1);
  const temp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(temp, JSON.stringify({ writtenAt: Date.now(), decisions }), "utf8");
    await fs.rename(temp, file);
  } catch {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

/** Viewer side: the runner's pending decisions; empty when there is no readable snapshot. */
export async function readRunnerDecisionsSnapshotV1(dir: string): Promise<readonly unknown[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(dir, HOST_DECISIONS_MIRROR_FILENAME_V1), "utf8"));
    if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>).decisions)) {
      return ((parsed as Record<string, unknown>).decisions as unknown[]).filter(
        (decision) => typeof decision === "object" && decision !== null
      );
    }
  } catch {
    // No runner has written yet, or a torn read: nothing to show.
  }
  return [];
}

export interface MirroredDecisionsMementoV1 {
  readonly memento: vscode.Memento;
  /** Replace the mirrored decisions; true when they changed. */
  setDecisions(decisions: readonly unknown[]): boolean;
}

/**
 * A Memento that is `base` for every key except `decisionsKey`, which reads
 * the mirrored decisions and ignores writes (the runner owns the records).
 */
export function createMirroredDecisionsMementoV1(base: vscode.Memento, decisionsKey: string): MirroredDecisionsMementoV1 {
  let decisions: readonly unknown[] = [];
  let signature = "[]";
  const memento: vscode.Memento = {
    keys: () => base.keys(),
    get: (<T>(key: string, defaultValue?: T): T | undefined => {
      if (key === decisionsKey) {
        return decisions as unknown as T;
      }
      return defaultValue === undefined ? base.get<T>(key) : base.get<T>(key, defaultValue);
    }) as vscode.Memento["get"],
    update: (key: string, value: unknown) => (key === decisionsKey ? Promise.resolve() : base.update(key, value)),
  };
  return {
    memento,
    setDecisions(next) {
      const nextSignature = JSON.stringify(next);
      if (nextSignature === signature) {
        return false;
      }
      signature = nextSignature;
      decisions = next;
      return true;
    },
  };
}
