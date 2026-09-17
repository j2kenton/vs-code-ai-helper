#!/bin/sh
# Install the Ensemble build (~/ensemble.vsix) into BOTH VS Code profiles on
# the dev box — the runner's desktop profile and the Remote-SSH server's —
# and PIN it there.
#
# Why pin: the build deployed here is built from the branch being tested and
# must be exactly what both windows run. Unpinned, VS Code replaced it with
# the Marketplace release (0.108.0, which has no runner/viewer roles) and the
# viewer window silently went back to running work itself (2026-09-17).
# Pinning turns off automatic updates for this one extension; installing
# another version by hand still works.
#
#   sh install-extension.sh [path/to/extension.vsix]
set -eu
VSIX="${1:-$HOME/ensemble.vsix}"
EXTENSION_ID="j2kenton.vs-code-ai-helper"

code --no-sandbox --install-extension "$VSIX" --force

# The server profile exists once a Remote-SSH window has connected at least once.
server="$(ls -d "$HOME"/.vscode-server/cli/servers/Stable-*/server 2>/dev/null | tail -1 || true)"
if [ -n "$server" ]; then
  "$server/bin/code-server" --install-extension "$VSIX" --force
fi

EXTENSION_ID="$EXTENSION_ID" node -e '
const fs = require("fs");
const id = process.env.EXTENSION_ID;
for (const file of [
  process.env.HOME + "/.vscode/extensions/extensions.json",
  process.env.HOME + "/.vscode-server/extensions/extensions.json",
]) {
  let entries;
  try { entries = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
  let pinned = 0;
  for (const entry of entries) {
    if (entry.identifier && entry.identifier.id === id) {
      entry.metadata = { ...(entry.metadata || {}), pinned: true };
      pinned += 1;
    }
  }
  fs.writeFileSync(file, JSON.stringify(entries));
  console.log(`pinned ${pinned} ${id} entr${pinned === 1 ? "y" : "ies"} in ${file}`);
}
'
