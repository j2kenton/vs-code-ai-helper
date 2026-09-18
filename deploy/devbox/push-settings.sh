#!/bin/sh
# Push THIS machine's Ensemble model settings to the runner(s) on the box.
#
#   sh deploy/devbox/push-settings.sh
#
# Why this exists: the runner is a separate VS Code installation on a separate
# machine, so it has its own settings.json. Nothing bridges the two — VS Code
# Settings Sync is not enabled there, signing in to Copilot does not enable it,
# and a Remote-SSH window writes "User" settings on the CLIENT and "Remote"
# settings to ~/.vscode-server, neither of which the runner reads. On
# 2026-09-18 that drift cost a round: the laptop had `primaryEnabled: false`
# for impl-high-review (skip Codex, run Copilot), the box's copy of that stage
# had no such flag, so the box ran Codex, hit its usage limit and parked the
# task while the same stage ran fine on the laptop.
#
# Only these keys are copied — never the whole file, which holds
# machine-specific paths:
#   ensemble.modelSettings, ensemble.aiModelDefaults, ensemble.enabledProviders
#
# The runner picks the change up live (VS Code watches settings.json); no
# restart is needed. Each target is backed up first. Comments in the target
# file are NOT preserved.
set -eu

HOST="${ENSEMBLE_DEVBOX_HOST:-ensemble-devbox}"
# Windows (Git Bash), macOS, then Linux.
if [ -n "${ENSEMBLE_LOCAL_SETTINGS:-}" ]; then
  LOCAL_SETTINGS="$ENSEMBLE_LOCAL_SETTINGS"
elif [ -n "${APPDATA:-}" ] && [ -f "$APPDATA/Code/User/settings.json" ]; then
  LOCAL_SETTINGS="$APPDATA/Code/User/settings.json"
elif [ -f "$HOME/Library/Application Support/Code/User/settings.json" ]; then
  LOCAL_SETTINGS="$HOME/Library/Application Support/Code/User/settings.json"
else
  LOCAL_SETTINGS="$HOME/.config/Code/User/settings.json"
fi
[ -f "$LOCAL_SETTINGS" ] || { echo "No settings.json at $LOCAL_SETTINGS (set ENSEMBLE_LOCAL_SETTINGS)." >&2; exit 1; }

extract="$(mktemp)"
merge="$(mktemp)"
trap 'rm -f "$extract" "$merge"' EXIT

# settings.json is JSONC: strip line/block comments and trailing commas before
# parsing. Node is used rather than jq because the repo already requires it.
node -e '
const fs = require("fs");
let raw = fs.readFileSync(process.argv[1], "utf8");
raw = raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/,(\s*[}\]])/g, (m, p) => p);
const all = JSON.parse(raw);
const picked = {};
for (const key of ["ensemble.modelSettings", "ensemble.aiModelDefaults", "ensemble.enabledProviders"]) {
  if (all[key] !== undefined) picked[key] = all[key];
}
if (Object.keys(picked).length === 0) throw new Error("no ensemble.* model settings found to push");
fs.writeFileSync(process.argv[2], JSON.stringify(picked, null, 2));
const stages = picked["ensemble.modelSettings"] ?? {};
for (const [stage, setting] of Object.entries(stages)) {
  const enabled = setting.backupsEnabled ?? [];
  const live = [];
  // Absent primaryEnabled means ENABLED (see src/utils/modelFallback.ts).
  if (setting.primaryEnabled !== false) live.push(setting.primary);
  (setting.backups ?? []).forEach((model, index) => { if (enabled[index] === true) live.push(model); });
  console.log("  " + stage.padEnd(18) + live.join("  ->  "));
}
' "$LOCAL_SETTINGS" "$extract"

cat > "$merge" <<'NODE'
const fs = require("fs");
const incoming = JSON.parse(fs.readFileSync("/tmp/ensemble-push-settings.json", "utf8"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
for (const target of process.argv.slice(2)) {
  if (!fs.existsSync(target)) { console.log("skipped (no such profile): " + target); continue; }
  const raw = fs.readFileSync(target, "utf8");
  fs.writeFileSync(target + ".bak-" + stamp, raw);
  const cleaned = raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/,(\s*[}\]])/g, (m, p) => p);
  const current = JSON.parse(cleaned);
  const before = JSON.stringify(current["ensemble.modelSettings"] ?? null);
  for (const [key, value] of Object.entries(incoming)) current[key] = value;
  fs.writeFileSync(target, JSON.stringify(current, null, 2) + "\n");
  const changed = before !== JSON.stringify(current["ensemble.modelSettings"]);
  console.log((changed ? "updated" : "unchanged") + ": " + target);
}
NODE

echo "Pushing to $HOST:"
scp -q "$extract" "$HOST:/tmp/ensemble-push-settings.json"
scp -q "$merge" "$HOST:/tmp/ensemble-push-settings-merge.js"
# Every runner profile: the first keeps VS Code's default user-data directory,
# runners 2+ have their own (runner.sh).
ssh "$HOST" 'node /tmp/ensemble-push-settings-merge.js "$HOME/.config/Code/User/settings.json" "$HOME"/.config/Code-runner-*/User/settings.json'
