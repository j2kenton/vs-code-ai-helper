#!/usr/bin/env node
/**
 * Thin verify entrypoint for the non-AI path-consumer inventory (plan §2.3).
 * Delegates to generateWorkflowPathConsumers.mjs in verify mode; exists so
 * the plan's named script surface is literal and the verify package script
 * can never accidentally run with --generate.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => a !== "--generate");
const result = spawnSync(
  process.execPath,
  [path.join(here, "generateWorkflowPathConsumers.mjs"), ...args],
  { stdio: "inherit" }
);
process.exitCode = result.status ?? 1;
