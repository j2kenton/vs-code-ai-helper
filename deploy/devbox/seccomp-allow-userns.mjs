#!/usr/bin/env node
// Docker's default seccomp profile, patched to allow ONE thing: creating the
// namespaces bubblewrap needs.
//
// Codex runs every review inside bubblewrap, which needs a user namespace.
// Docker's default profile allows clone/unshare/mount/setns only with
// CAP_SYS_ADMIN, and otherwise only permits `clone` with every CLONE_NEW* bit
// masked OFF — so the sandbox cannot start (measured on the box, 2026-09-17:
// "bwrap: No permissions to create a new namespace"). Turning the filter off
// entirely (`--security-opt seccomp=unconfined`) is the usual shortcut and
// costs the whole syscall allow-list; this keeps all ~350 of Docker's rules
// and relaxes only the namespace ones, which is what Docker's own
// documentation recommends doing instead.
//
//   node seccomp-allow-userns.mjs <base-default.json> <out.json>
//
// `base-default.json` is moby's profiles/seccomp/default.json for the running
// daemon (run.sh fetches it and falls back to seccomp=unconfined if it cannot).
import { readFileSync, writeFileSync } from "node:fs";

const [, , basePath, outPath] = process.argv;
if (!basePath || !outPath) {
  console.error("usage: seccomp-allow-userns.mjs <base-default.json> <out.json>");
  process.exit(2);
}

const profile = JSON.parse(readFileSync(basePath, "utf8"));
if (profile.defaultAction !== "SCMP_ACT_ERRNO" || !Array.isArray(profile.syscalls)) {
  console.error("seccomp-allow-userns: unexpected profile shape — not patching");
  process.exit(3);
}

// The namespace syscalls bubblewrap uses. `clone` is listed unconditionally
// (no arg filter), which is precisely the CLONE_NEWUSER restriction being
// lifted; `clone3` is allowed too, since the default denies it with ENOSYS to
// force the `clone` fallback and there is no reason to keep that detour once
// `clone` itself is unrestricted.
const NAMESPACE_SYSCALLS = ["clone", "clone3", "unshare", "setns", "mount", "umount2", "pivot_root", "keyctl"];

profile.syscalls = [
  ...profile.syscalls,
  {
    names: NAMESPACE_SYSCALLS,
    action: "SCMP_ACT_ALLOW",
    comment: "Ensemble dev box: bubblewrap (Codex's review sandbox) needs its own namespaces",
  },
];

writeFileSync(outPath, JSON.stringify(profile, null, 2));
console.log(`seccomp-allow-userns: wrote ${outPath} (${profile.syscalls.length} rules, namespace syscalls allowed)`);
