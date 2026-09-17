import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * The viewer → runner relay: how a viewer window hands the user's actions
 * to the always-on runner (hostRoleV1.ts), over the one thing both hosts
 * share — the workspace's own filesystem. No sockets, no daemon: the runner
 * and every viewer run as the same OS user on the same box, so a directory
 * under the task root (`.ensemble/relay-v1/`, git-ignored with the rest of
 * `.ensemble`) is a durable, crash-tolerant queue.
 *
 * Protocol (all files are complete-on-arrival: written to a temp name in
 * the same directory, then renamed):
 *   - a viewer writes `req-<id>.json` and waits for `res-<id>.json`;
 *   - the runner CLAIMS a request by exclusively creating
 *     `req-<id>.json.claimed` (O_EXCL: two runner sweeps — the watcher's and
 *     the periodic one — can never both execute it), runs it, writes the
 *     response, and removes the request and the claim;
 *   - the viewer removes the response once read.
 * A request older than `maxAgeMs` when claimed is answered `expired`, never
 * executed: a viewer that gave up must not have its action run minutes later.
 *
 * This module is VS Code-free (plain fs) so it is unit-testable; extension.ts
 * wires the runner's file watcher and the viewer's user-facing calls.
 */

export type HostRelayRequestV1 =
  | {
      readonly id: string;
      readonly kind: "command";
      /** A registered command id, e.g. "vs-code-ai-helper.applyCurrentStageAction". */
      readonly command: string;
      /** JSON-serializable arguments; the runner spreads them. */
      readonly args?: readonly unknown[];
      /** The task the action is for: the runner selects it as its current task first. */
      readonly taskFolderPath?: string;
      /** How long the viewer waits; the runner refuses a request claimed after that as expired. */
      readonly timeoutMs?: number;
      readonly createdAt: string;
    }
  | {
      readonly id: string;
      readonly kind: "interaction";
      readonly op: "submitAnswers" | "cancel" | "resume";
      /** Informational: the interaction ref alone identifies the durable transaction on the runner. */
      readonly taskFolderPath?: string;
      readonly ref: {
        readonly operationId: string;
        readonly interactionId: string;
        readonly taskBindingId: string;
        readonly chatDocumentId: string;
        readonly sourceAttemptId: string;
      };
      readonly rawAnswers?: unknown;
      readonly idempotencyId: string;
      readonly timeoutMs?: number;
      readonly createdAt: string;
    }
  | {
      readonly id: string;
      readonly kind: "resolveDecision";
      /** A pending workflow decision the runner raised (hostDecisionMirrorV1.ts). */
      readonly decisionId: string;
      readonly optionId: string;
      readonly timeoutMs?: number;
      readonly createdAt: string;
    }
  | {
      readonly id: string;
      readonly kind: "cancelOperation";
      /** The runner's own id for a running operation it mirrored (hostOperationsMirrorV1.ts). */
      readonly operationId: string;
      readonly timeoutMs?: number;
      readonly createdAt: string;
    };

export interface HostRelayResponseV1 {
  readonly id: string;
  readonly ok: boolean;
  /** The handler's serializable result (e.g. a resume settlement). */
  readonly result?: unknown;
  readonly reason?: string;
  readonly completedAt: string;
}

export const HOST_RELAY_DIRNAME_V1 = "relay-v1";
const REQUEST_PREFIX = "req-";
const RESPONSE_PREFIX = "res-";
const CLAIMED_SUFFIX = ".claimed";
const ID_PATTERN = /^[0-9a-f]{32}$/;

export interface HostRelayV1 {
  readonly dir: string;
  /** Viewer side: enqueue and wait. Rejects on timeout (the request file is removed then). */
  send(
    request: Omit<Extract<HostRelayRequestV1, { kind: "command" }>, "id" | "createdAt"> |
      Omit<Extract<HostRelayRequestV1, { kind: "interaction" }>, "id" | "createdAt"> |
      Omit<Extract<HostRelayRequestV1, { kind: "resolveDecision" }>, "id" | "createdAt"> |
      Omit<Extract<HostRelayRequestV1, { kind: "cancelOperation" }>, "id" | "createdAt">,
    options?: { readonly timeoutMs?: number; readonly pollMs?: number }
  ): Promise<HostRelayResponseV1>;
  /** Runner side: claim and answer every pending request, oldest first. Returns how many were handled. */
  drain(handler: (request: HostRelayRequestV1) => Promise<unknown>): Promise<number>;
}

export function allocateHostRelayIdV1(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function createHostRelayV1(options: {
  readonly dir: string;
  readonly now?: () => Date;
  /** Requests older than this when claimed are refused as expired. Default 10 minutes. */
  readonly maxAgeMs?: number;
}): HostRelayV1 {
  const { dir } = options;
  const now = options.now ?? ((): Date => new Date());
  const maxAgeMs = options.maxAgeMs ?? 10 * 60 * 1000;

  async function writeComplete(finalPath: string, body: unknown): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    const temp = `${finalPath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(temp, JSON.stringify(body), "utf8");
    // Windows: a just-written file can be held briefly by an indexer or
    // antivirus scan, and rename then fails EPERM/EBUSY for a few
    // milliseconds (seen in this repo's own test runs). Retry, briefly.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(temp, finalPath);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
          await fs.rm(temp, { force: true });
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  async function readJson(filePath: string): Promise<unknown> {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  }

  return {
    dir,

    async send(request, sendOptions) {
      const id = allocateHostRelayIdV1();
      const timeoutMs = sendOptions?.timeoutMs ?? 2 * 60 * 1000;
      const full: HostRelayRequestV1 = {
        ...request,
        id,
        timeoutMs,
        createdAt: now().toISOString(),
      } as HostRelayRequestV1;
      const requestPath = path.join(dir, `${REQUEST_PREFIX}${id}.json`);
      const responsePath = path.join(dir, `${RESPONSE_PREFIX}${id}.json`);
      await writeComplete(requestPath, full);
      const pollMs = sendOptions?.pollMs ?? 500;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          const response = (await readJson(responsePath)) as HostRelayResponseV1;
          await fs.rm(responsePath, { force: true });
          return response;
        } catch {
          // Not answered yet.
        }
        if (Date.now() >= deadline) {
          // Withdraw an unclaimed request so a late runner never runs it;
          // a claimed one is already the runner's, and its answer is dropped.
          await fs.rm(requestPath, { force: true });
          throw new Error(
            "the runner did not answer in time — is the runner VS Code on the box running?"
          );
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },

    async drain(handler) {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        return 0;
      }
      await collectGarbage(entries);
      const pending = entries
        .filter((name) => name.startsWith(REQUEST_PREFIX) && name.endsWith(".json"))
        .sort();
      // Claim first, then run every claimed request CONCURRENTLY: a serial
      // drain let one long implementation round block an answer to a
      // question behind it until the answer "expired" (review of the
      // runner/viewer split).
      const claimed: Array<{ readonly id: string; readonly requestPath: string; readonly claimPath: string }> = [];
      for (const name of pending) {
        const id = name.slice(REQUEST_PREFIX.length, -".json".length);
        if (!ID_PATTERN.test(id)) {
          continue;
        }
        const requestPath = path.join(dir, name);
        const claimPath = `${requestPath}${CLAIMED_SUFFIX}`;
        // The claim is an EXCLUSIVE CREATE (O_EXCL), not a rename: measured
        // on Windows, two concurrent renames of one file to one destination
        // BOTH report success (180 of 200 tries), so a rename-claim ran a
        // request twice. O_EXCL is atomic on every platform.
        try {
          const claim = await fs.open(claimPath, "wx");
          await claim.close();
          claimed.push({ id, requestPath, claimPath });
        } catch {
          // Claimed by the other sweep — unless that sweep died mid-way and
          // left the claim behind: a claim older than the request age limit
          // is dead, and its request is expired with it.
          await expireDeadClaim(id, requestPath, claimPath);
        }
      }
      await Promise.all(claimed.map(({ id, requestPath, claimPath }) => runClaimed(id, requestPath, claimPath)));
      return claimed.length;

      async function runClaimed(id: string, requestPath: string, claimPath: string): Promise<void> {
        let response: HostRelayResponseV1 | undefined;
        try {
          const request = (await readJson(requestPath)) as HostRelayRequestV1;
          const age = now().getTime() - new Date(request.createdAt).getTime();
          // Expired = the viewer that sent it has stopped waiting: its own
          // deadline when it said one, the age limit otherwise.
          if (!(age <= (request.timeoutMs ?? maxAgeMs))) {
            response = { id, ok: false, reason: "expired", completedAt: now().toISOString() };
          } else {
            const result = await handler(request);
            response = { id, ok: true, result, completedAt: now().toISOString() };
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            // Withdrawn by the viewer (it gave up) between the listing and
            // the claim: nothing to run, nobody waiting.
            response = undefined;
          } else {
            response = {
              id,
              ok: false,
              reason: error instanceof Error ? error.message : String(error),
              completedAt: now().toISOString(),
            };
          }
        }
        if (response !== undefined) {
          await writeComplete(path.join(dir, `${RESPONSE_PREFIX}${id}.json`), response);
        }
        await fs.rm(requestPath, { force: true });
        await fs.rm(claimPath, { force: true });
      }

      /** Answers nobody collected (a viewer that timed out) and stray temp files. */
      async function collectGarbage(names: readonly string[]): Promise<void> {
        const cutoffResponses = now().getTime() - 60 * 60 * 1000;
        const cutoffTemps = now().getTime() - 10 * 60 * 1000;
        for (const name of names) {
          const isResponse = name.startsWith(RESPONSE_PREFIX) && name.endsWith(".json");
          const isTemp = name.endsWith(".tmp");
          if (!isResponse && !isTemp) {
            continue;
          }
          try {
            const stat = await fs.stat(path.join(dir, name));
            if (stat.mtimeMs < (isResponse ? cutoffResponses : cutoffTemps)) {
              await fs.rm(path.join(dir, name), { force: true });
            }
          } catch {
            // Gone already.
          }
        }
      }

      async function expireDeadClaim(id: string, requestPath: string, claimPath: string): Promise<void> {
        try {
          const claimed = await fs.stat(claimPath);
          if (now().getTime() - claimed.mtimeMs <= maxAgeMs) {
            return;
          }
        } catch {
          return;
        }
        await writeComplete(path.join(dir, `${RESPONSE_PREFIX}${id}.json`), {
          id,
          ok: false,
          reason: "expired",
          completedAt: now().toISOString(),
        } satisfies HostRelayResponseV1);
        await fs.rm(requestPath, { force: true });
        await fs.rm(claimPath, { force: true });
      }
    },
  };
}
