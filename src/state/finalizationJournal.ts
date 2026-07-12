import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { writeAtomic } from "./writeAtomic";
import * as vscode from "vscode";

export interface FinalizationJournal { schemaVersion: 1; id: string; taskFolder: string; operation: string; stage?: string; target?: string; runId?: string; createdAt: string; phase: "intent-recorded" | "artifact-committed" | "progress-committed"; preImageHash?: string; outputHash?: string; checksum: string; }

function checksum(value: Omit<FinalizationJournal, "checksum">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function beginFinalization(root: string, taskFolder: string, operation: string, details: Pick<FinalizationJournal, "stage" | "target" | "runId" | "preImageHash" | "outputHash"> = {}): Promise<FinalizationJournal> {
  const base = { schemaVersion: 1 as const, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, taskFolder, operation, createdAt: new Date().toISOString(), phase: "intent-recorded" as const, ...details };
  const journal: FinalizationJournal = { ...base, checksum: checksum(base) };
  await fs.promises.mkdir(root, { recursive: true });
  await writeAtomic(vscode.Uri.file(path.join(root, "finalization-journal.json")), JSON.stringify(journal, null, 2) + "\n");
  return journal;
}

export async function finishFinalization(root: string): Promise<void> {
  try { await fs.promises.unlink(path.join(root, "finalization-journal.json")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Returns a verified interrupted operation; callers complete or roll it back before clearing it. */
export async function recoverFinalization(root: string): Promise<FinalizationJournal | undefined> {
  const file = path.join(root, "finalization-journal.json");
  try { const value = JSON.parse(await fs.promises.readFile(file, "utf8")) as FinalizationJournal; const { checksum: stored, ...base } = value; if (value.schemaVersion !== 1 || stored !== checksum(base)) throw new Error("Invalid finalization journal checksum."); return value; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Reconcile journals in task folders, not only at the meta-root level. */
export async function recoverFinalizationTree(root: string): Promise<FinalizationJournal[]> {
  const roots: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    roots.push(dir);
    if (depth >= 3) return;
    try {
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await visit(path.join(dir, entry.name), depth + 1);
      }
    } catch { /* a task can disappear while startup is scanning */ }
  };
  await visit(root, 0);
  const recovered: FinalizationJournal[] = [];
  for (const candidate of roots) {
    const journal = await recoverFinalization(candidate);
    if (journal) recovered.push(journal);
  }
  return recovered;
}
