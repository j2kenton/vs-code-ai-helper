#!/bin/sh
# One-screen status of every task on this box, for a phone.
# Reads only what the runner already publishes; starts nothing, changes nothing.
#   ssh ensemble-box "sudo docker exec ensemble-devbox sh /home/dev/status.sh"
set -u
now=$(date +%s)
printf '%s  (box time)\n' "$(date '+%a %H:%M:%S')"

for relay in /workspace/*/.ensemble/relay-v1; do
  [ -d "$relay" ] || continue
  ws=${relay%/.ensemble/relay-v1}
  ops="$relay/operations-v1.json"
  printf '\n== %s\n' "${ws##*/}"
  if [ ! -f "$ops" ]; then
    printf '   no runner has reported here\n'
    continue
  fi
  age=$(( now - $(stat -c %Y "$ops") ))
  if [ "$age" -gt 90 ]; then
    printf '   RUNNER SILENT for %dm %ds — nothing is running\n' $((age / 60)) $((age % 60))
  else
    printf '   runner alive (%ds ago)\n' "$age"
  fi
  node -e '
    const fs = require("fs");
    const snap = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const roots = snap.operations.filter((o) => o.parentId === undefined);
    if (roots.length === 0) { console.log("   idle — no operation running"); }
    for (const op of roots) {
      const mins = Math.round((Date.now() - op.startedAt) / 60000);
      const kids = snap.operations.filter((o) => o.parentId === op.id).map((o) => o.label);
      console.log(`   ▶ ${op.label} — ${op.taskName}`);
      console.log(`     ${op.detail ?? ""} ${op.activity ?? ""} | ${op.modelId ?? "?"} | ${mins}m` +
        (op.waitingForUser ? "  << WAITING FOR YOU" : ""));
      if (kids.length) console.log(`     doing: ${kids.join(", ")}`);
    }
    const dec = process.argv[2];
    if (fs.existsSync(dec)) {
      const d = JSON.parse(fs.readFileSync(dec, "utf8"));
      const fresh = Date.now() - d.writtenAt < 90000;
      if (d.decisions.length && fresh) {
        console.log(`   ?? ${d.decisions.length} question(s) waiting: ` +
          d.decisions.map((x) => `${x.stage}/${x.decisionKey}`).join(", "));
      }
    }
  ' "$ops" "$relay/decisions-v1.json" 2>/dev/null || printf '   (could not read the snapshot)\n'

  # The last few things the runner announced, newest first.
  notes="$relay/notifications-v1.jsonl"
  if [ -f "$notes" ]; then
    printf '   recent:\n'
    tail -6 "$notes" | tac 2>/dev/null | node -e '
      let raw = "";
      process.stdin.on("data", (c) => (raw += c)).on("end", () => {
        for (const line of raw.split(/\r?\n/).filter(Boolean)) {
          try {
            const e = JSON.parse(line);
            const t = new Date(e.at).toLocaleTimeString();
            const mark = e.level === "warning" ? "!" : e.level === "error" ? "X" : "-";
            console.log(`     ${mark} ${t} ${String(e.message).slice(0, 120)}`);
          } catch { /* a torn line */ }
        }
      });
    ' 2>/dev/null
  fi

  # Files the round has changed so far, if this workspace is a git checkout.
  # Never silently prints 0: git refuses a repository owned by another user
  # ("dubious ownership"), which made an empty result look like a clean tree
  # when the script was run as root through `docker exec`.
  if [ -d "$ws/.git" ] || [ -f "$ws/.git" ]; then
    if status=$(git -C "$ws" status --porcelain 2>&1); then
      printf '   %s file(s) changed in the checkout\n' "$(printf '%s' "$status" | grep -c .)"
    else
      printf '   could not read the checkout: %s\n' "$(printf '%s' "$status" | head -1)"
    fi
  fi
done
