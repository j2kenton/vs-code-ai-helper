#!/usr/bin/env node
/**
 * Thin verify entrypoint for the workflow route inventory (plan §1.2).
 * Delegates to generateWorkflowRoutes.mjs in verify mode, forwarding scope
 * flags (--live / --annotations / --removals; no flag = everything). Kept as
 * a separate script so the plan's named surface (generateWorkflowRoutes.mjs
 * + verifyWorkflowRoutes.mjs) exists literally and package.json's
 * verify:workflow-route-* scripts have an entry that can never accidentally
 * be run with --generate.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => a !== "--generate");
const result = spawnSync(
  process.execPath,
  [path.join(here, "generateWorkflowRoutes.mjs"), ...args],
  { stdio: "inherit" }
);
process.exitCode = result.status ?? 1;
