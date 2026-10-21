#!/bin/sh
# Bring every copy of Ensemble on the dev box to the newest Marketplace
# version, and say what each window is actually running.
#
#   update-ensemble.sh            install the newest version everywhere, then report
#   update-ensemble.sh --status   report only; change nothing
#   update-ensemble.sh 1.3.0      install that version instead of the newest
#
# From a laptop:  ssh ensemble-devbox ~/update-ensemble.sh
#
# Three copies live on the box, and VS Code updates none of them by itself:
#   runner      ~/.vscode/extensions            the desktop windows (noVNC)
#   remote-ssh  ~/.vscode-server/extensions     a laptop's Remote-SSH window
#   browser     ~/.serve-web-viewer/extensions  the browser/phone viewer
# install-extension.sh pins the first two, and the browser viewer keeps its
# own folder that nothing else installed into: it was still on 0.117.5 on
# 2026-10-20, a month after the others had moved on. Installing all three from
# one package keeps them identical, and all three are pinned so none of them
# moves on by itself.
#
# "Newest" means the newest version on the Marketplace, pre-release or not,
# which is what VS Code's pre-release channel would pick.
#
# THE RUNNER COPY IS ONLY TOUCHED WHEN EVERY RUNNER IS IDLE. Its folder is
# shared by all runner windows, and installing rewrites it underneath whatever
# is running (runner.sh has the history), so a busy runner defers both the
# install and the restart to a detached waiter that does them once every
# runner is idle. The viewer copies hold no rounds and are installed at once.
# A runner window loads the new version when it restarts (runner.sh's loop
# reopens it in 10 s); viewer windows are never touched: reload them when it
# suits you.
#
# "Idle" is read from files the runner publishes, so a round started in the
# second between the last check and the restart can still be cut off. Closing
# that needs the extension to accept a "drain, then tell me" request; until
# then the check is repeated immediately before every restart.
set -u

EXTENSION_ID="j2kenton.vs-code-ai-helper"
PUBLISHER="${EXTENSION_ID%%.*}"
NAME="${EXTENSION_ID#*.}"
RUNNER_EXT="$HOME/.vscode/extensions"
SERVER_EXT="$HOME/.vscode-server/extensions"
BROWSER_EXT="$HOME/.serve-web-viewer/extensions"
VSIX="$HOME/ensemble.vsix"
LOCK="$HOME/.devbox-logs/install.lock"
CKSUM_FILE="$HOME/.devbox-logs/installed-vsix.cksum"
LOG="$HOME/.devbox-logs/update-ensemble.log"
# Rounds are killed at 60 minutes; an "open" row older than this is an orphan.
MAX_ROUND_MIN="${MAX_ROUND_MIN:-75}"
# How long the waiter keeps waiting for busy runners before giving up.
WAIT_HOURS="${UPDATE_WAIT_HOURS:-12}"
mkdir -p "$(dirname "$LOG")"

log() { echo "$(date -u +%FT%TZ) $*" >>"$LOG"; }
say() { echo "$*"; log "$*"; }

# ---------------------------------------------------------------- versions

# "<version> <published> <pre-release|stable>" for the newest universal build.
marketplace_newest() {
  curl -fsS -X POST \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json;api-version=7.2-preview.1' \
    --data "{\"filters\":[{\"criteria\":[{\"filterType\":7,\"value\":\"$EXTENSION_ID\"}],\"pageSize\":1}],\"flags\":17}" \
    https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery |
    python3 -c '
import json, sys
versions = json.load(sys.stdin)["results"][0]["extensions"][0]["versions"]
v = next(v for v in versions if not v.get("targetPlatform"))
pre = any(p["key"].endswith("PreRelease") and p["value"] == "true" for p in v.get("properties", []))
print(v["version"], v["lastUpdated"][:16] + "Z", "pre-release" if pre else "stable")'
}

# "<version> <installed epoch seconds> <pinned|->" from an extensions folder,
# or nothing when the extension is not installed there.
installed() {
  node -e '
    const [file, id] = process.argv.slice(1);
    let entries = [];
    try { entries = JSON.parse(require("fs").readFileSync(file, "utf8")); } catch {}
    const e = entries.filter((x) => x.identifier && x.identifier.id === id)
      .sort((a, b) => (b.metadata?.installedTimestamp ?? 0) - (a.metadata?.installedTimestamp ?? 0))[0];
    if (e) console.log(e.version, Math.floor((e.metadata?.installedTimestamp ?? 0) / 1000), e.metadata?.pinned ? "pinned" : "-");
  ' "$1/extensions.json" "$EXTENSION_ID"
}
installed_version() { installed "$1" | awk '{print $1}'; }
installed_at() { installed "$1" | awk '{print $2}'; }

# Pin this extension in each folder given; fails if any folder that has it
# could not be pinned.
pin() {
  node -e '
    const fs = require("fs");
    const id = process.argv[1];
    let failed = false;
    for (const dir of process.argv.slice(2)) {
      const file = dir + "/extensions.json";
      if (!fs.existsSync(file)) continue;
      try {
        const entries = JSON.parse(fs.readFileSync(file, "utf8"));
        let changed = false;
        for (const e of entries) {
          if (e.identifier && e.identifier.id === id && !e.metadata?.pinned) {
            e.metadata = { ...(e.metadata || {}), pinned: true };
            changed = true;
          }
        }
        if (changed) fs.writeFileSync(file, JSON.stringify(entries));
      } catch (err) {
        console.error(`could not pin in ${file}: ${err.message}`);
        failed = true;
      }
    }
    process.exit(failed ? 1 : 0);
  ' "$EXTENSION_ID" "$@"
}

# Seconds since the epoch at which a process started.
started_at() {
  elapsed="$(ps -o etimes= -p "$1" 2>/dev/null | tr -d ' ')"
  echo $(( $(date +%s) - ${elapsed:-0} ))
}

# ---------------------------------------------------------------- runners

# Workspaces with a runner window open, one per line. runner.sh and
# start-runner.sh both launch `dbus-run-session -- code ... --new-window <ws>`,
# so the workspace is that command's last argument (read NUL-separated, so a
# path is never split); VS Code's own main process reorders its arguments.
runner_workspaces() {
  for p in $(pgrep -f '^dbus-run-session -- code --wait '); do
    tr '\0' '\n' <"/proc/$p/cmdline" 2>/dev/null | sed '/^$/d' | tail -1
  done | sort -u
}

# A workspace path as a literal inside an extended regular expression.
regex_literal() { printf '%s' "$1" | sed 's#[][\.*^$+?(){}|]#\\&#g'; }

# The window's main VS Code process. Its workspace argument is followed by a
# space or ends the command line, so /workspace/wt-b never matches wt-b2.
window_root() {
  pgrep -f "^/usr/share/code/code --wait .*--new-window .* $(regex_literal "$1")( |\$)" | head -1
}

ops_file() { echo "$1/.ensemble/relay-v1/operations-v1.json"; }

activation_id() {
  node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activationId||"")}catch{console.log("")}' "$(ops_file "$1")"
}

# Prints what keeps a runner busy (nothing when it is idle): any operation the
# runner publishes (Fast Forward, a round, Publish Checks), or an AI round
# still open in a task's ledger — the memory guard's test.
busy_reason() {
  node -e '
    const fs = require("fs"), path = require("path");
    const [ws, maxMin] = process.argv.slice(1);
    const out = [];
    try {
      const ops = JSON.parse(fs.readFileSync(path.join(ws, ".ensemble/relay-v1/operations-v1.json"), "utf8")).operations || [];
      for (const o of ops) out.push(`${o.kind || "operation"}${o.key ? " on " + path.basename(o.key) : ""}`);
    } catch {}
    const cutoff = Date.now() - Number(maxMin) * 60000;
    let dirs = [];
    try { dirs = fs.readdirSync(path.join(ws, ".ensemble")); } catch {}
    for (const d of dirs) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(ws, ".ensemble", d, "task-progress.json"), "utf8"));
        const open = (p.roundLedger || []).filter((r) => r.state === "open" &&
          (r.attemptIds || []).length > 0 && Date.parse(r.startedAt) > cutoff).length;
        if (open) out.push(`AI round in ${p.displayName || d}`);
      } catch {}
    }
    console.log([...new Set(out)].join(", "));
  ' "$1" "$MAX_ROUND_MIN"
}

# Every busy runner as "<ws>: <reason>", one per line; nothing when all are idle.
busy_runners() {
  runner_workspaces | while IFS= read -r ws; do
    reason="$(busy_reason "$ws")"
    [ -n "$reason" ] && echo "$ws: $reason"
  done
}

# A runner window that started before the runner copy was installed.
runner_is_stale() {
  root="$(window_root "$1")"
  ts="$(installed_at "$RUNNER_EXT")"
  [ -n "$root" ] && [ -n "$ts" ] && [ "$(started_at "$root")" -lt "$ts" ]
}

# True when any open runner window is stale.
any_runner_stale() {
  runner_workspaces | while IFS= read -r ws; do
    runner_is_stale "$ws" && echo stale
  done | grep -q stale
}

# Close a runner window; runner.sh (or start-runner.sh) reopens it in 10 s.
# Returns 2 without touching it if it became busy since the caller looked.
restart_runner() {
  ws="$1"
  root="$(window_root "$ws")"
  [ -n "$root" ] || return 0
  [ -z "$(busy_reason "$ws")" ] || return 2
  old="$(activation_id "$ws")"
  log "restarting the runner window on $ws (pid $root) to load $(installed_version "$RUNNER_EXT")"
  kill -TERM "$root" 2>/dev/null
  i=0
  while kill -0 "$root" 2>/dev/null && [ "$i" -lt 20 ]; do i=$((i + 1)); sleep 1; done
  kill -KILL "$root" 2>/dev/null || true
  i=0
  while [ "$i" -lt 60 ]; do
    if [ "$(activation_id "$ws")" != "$old" ] &&
       [ $(( $(date +%s) - $(stat -c %Y "$(ops_file "$ws")" 2>/dev/null || echo 0) )) -lt 60 ]; then
      log "runner window on $ws is reporting again"
      return 0
    fi
    i=$((i + 1))
    sleep 5
  done
  log "runner window on $ws did not report within 5 minutes; leaving it to the restart loop"
  return 1
}

# Install ~/ensemble.vsix into the runner copy, if it is not on it already.
# Only call this with every runner idle. The checksum file is written only
# after a verified install: runner.sh skips its own install-on-start when it
# matches, so writing it early would hide a failed install for good.
install_runner_copy() {
  want="$1"
  (
    flock 9
    if [ "$(installed_version "$RUNNER_EXT")" != "$want" ]; then
      code --no-sandbox --install-extension "$VSIX" --force >>"$LOG" 2>&1
    fi
    if [ "$(installed_version "$RUNNER_EXT")" = "$want" ]; then
      pin "$RUNNER_EXT" >>"$LOG" 2>&1
      cksum <"$VSIX" >"$CKSUM_FILE.tmp" && mv "$CKSUM_FILE.tmp" "$CKSUM_FILE"
    else
      echo "runner install of $want failed (see $LOG)"
      exit 1
    fi
  ) 9>"$LOCK"
}

# Install the runner copy and restart every runner window that predates it,
# but only while every runner is idle. Returns 2 if some runner is busy.
update_runners_if_idle() {
  want="$1"
  [ -z "$(busy_runners)" ] || return 2
  install_runner_copy "$want" || return 1
  # The loop runs in a pipeline subshell: `exit 2` ends it, and its status is
  # the function's.
  runner_workspaces | while IFS= read -r ws; do
    runner_is_stale "$ws" || continue
    say "restarting the idle runner on $ws (back in about a minute)"
    restart_runner "$ws"
    case $? in
      1) echo "  it has not reported yet; see $LOG" ;;
      2) say "  it became busy just now; it is restarted once idle"; exit 2 ;;
    esac
  done
}

# Detached: wait until every runner is idle, then install and restart.
if [ "${1:-}" = "--when-idle" ]; then
  want="$2"
  deadline=$(( $(date +%s) + WAIT_HOURS * 3600 ))
  log "waiting for every runner to go idle to install $want and restart"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    update_runners_if_idle "$want" >>"$LOG" 2>&1
    case $? in
      0) log "runners updated to $want"; exit 0 ;;
      1) log "runner install failed; giving up"; exit 1 ;;
    esac
    sleep 60
  done
  log "gave up after $WAIT_HOURS h with a runner still busy; runner.sh installs $want on that runner's next restart"
  exit 0
fi

# ---------------------------------------------------------------- report

report() {
  echo
  echo "Installed"
  for pair in "runner:$RUNNER_EXT" "remote-ssh:$SERVER_EXT" "browser:$BROWSER_EXT"; do
    label="${pair%%:*}"
    v="$(installed "${pair#*:}")"
    if [ -z "$v" ]; then
      line="not installed"
    else
      line="$(echo "$v" | awk '{print $1 ($3 == "pinned" ? "  (pinned)" : "")}')"
      [ -n "$newest" ] && [ "${v%% *}" != "$newest" ] && line="$line   <- not $newest"
    fi
    printf '  %-11s %s\n' "$label" "$line"
  done

  echo
  echo "Running"
  runner_v="$(installed_version "$RUNNER_EXT")"
  workspaces="$(runner_workspaces)"
  [ -n "$workspaces" ] || echo "  runner      no runner window open"
  [ -z "$workspaces" ] || echo "$workspaces" | while IFS= read -r ws; do
    busy="$(busy_reason "$ws")"
    if [ -z "$runner_v" ]; then
      state="not installed"
    elif runner_is_stale "$ws"; then
      state="an older version (window predates $runner_v; restart pending)"
    else
      state="$runner_v"
    fi
    printf '  runner      %-32s %s, %s\n' "$ws" "$state" "${busy:-idle}"
  done

  for pair in "remote-ssh:$SERVER_EXT:/.vscode-server/" "browser:$BROWSER_EXT:/serve-web/"; do
    label="${pair%%:*}"
    rest="${pair#*:}"
    ext="${rest%%:*}"
    match="${rest#*:}"
    ts="$(installed_at "$ext")"
    v="$(installed_version "$ext")"
    n=0
    for p in $(pgrep -f -- '--type=extensionHost'); do
      tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null | grep -q -- "$match" || continue
      n=$((n + 1))
      if [ -z "$v" ]; then
        printf '  %-11s window %s: %s\n' "$label" "$n" "not installed"
      elif [ "$(started_at "$p")" -ge "$ts" ]; then
        printf '  %-11s window %s: %s\n' "$label" "$n" "$v"
      else
        printf '  %-11s window %s: %s\n' "$label" "$n" "an older version; reload the window to load $v"
      fi
    done
    [ "$n" -gt 0 ] || printf '  %-11s no window open\n' "$label"
  done
}

# ---------------------------------------------------------------- main

newest=""
latest="$(marketplace_newest 2>/dev/null)"
if [ -n "$latest" ]; then
  echo "Newest on the Marketplace: $(echo "$latest" | awk '{print $1 " (" $3 ", published " $2 ")"}')"
  newest="${latest%% *}"
else
  echo "Could not reach the Marketplace; showing the box only"
fi

case "${1:-}" in
  --status) report; exit 0 ;;
  [0-9]*) newest="$1" ;;
esac
[ -n "$newest" ] || { report; exit 1; }

# 1. Put the package in place, verified, unless ~/ensemble.vsix already is it.
have="$(unzip -p "$VSIX" extension/package.json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])' 2>/dev/null)"
if [ "$have" != "$newest" ]; then
  dir="$(mktemp -d)"
  say "downloading $EXTENSION_ID $newest from the Marketplace"
  if ! curl -fsSL --compressed -o "$dir/new.vsix" \
      "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/$PUBLISHER/vsextensions/$NAME/$newest/vspackage"; then
    say "download failed; nothing was changed"
    rm -rf "$dir"; report; exit 1
  fi
  got="$(unzip -p "$dir/new.vsix" extension/package.json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])' 2>/dev/null)"
  if [ "$got" != "$newest" ]; then
    say "the download is not $newest (got '${got:-not a VS Code package}'); nothing was changed"
    rm -rf "$dir"; report; exit 1
  fi
  (
    flock 9
    [ -f "$VSIX" ] && cp "$VSIX" "$VSIX.prev"
    cp "$dir/new.vsix" "$VSIX.tmp" && mv "$VSIX.tmp" "$VSIX"
  ) 9>"$LOCK"
  rm -rf "$dir"
fi

# 2. The viewer copies: no rounds run in them, so they are installed now.
failed=0
if [ "$(installed_version "$SERVER_EXT")" != "$newest" ]; then
  server="$(ls -td "$HOME"/.vscode-server/cli/servers/Stable-*/server 2>/dev/null | head -1)"
  if [ -z "$server" ]; then
    echo "remote-ssh: no Remote-SSH server on the box yet; run this again after a laptop connects"
  else
    "$server/bin/code-server" --install-extension "$VSIX" --force >>"$LOG" 2>&1
    [ "$(installed_version "$SERVER_EXT")" = "$newest" ] || { echo "remote-ssh: install of $newest failed (see $LOG)"; failed=1; }
  fi
fi
if [ "$(installed_version "$BROWSER_EXT")" != "$newest" ]; then
  browser_server="$(ls -td "$HOME"/.vscode/cli/serve-web/*/bin/code-server 2>/dev/null | head -1)"
  if [ -z "$browser_server" ]; then
    echo "browser: the viewer server has not been downloaded yet; it installs ~/ensemble.vsix when it first starts"
  else
    "$browser_server" --extensions-dir "$BROWSER_EXT" --install-extension "$VSIX" --force >>"$LOG" 2>&1
    [ "$(installed_version "$BROWSER_EXT")" = "$newest" ] || { echo "browser: install of $newest failed (see $LOG)"; failed=1; }
  fi
fi
pin "$SERVER_EXT" "$BROWSER_EXT" || failed=1

# 3. The runner copy and stale runner windows: now if every runner is idle,
#    otherwise by a detached waiter.
if [ "$(installed_version "$RUNNER_EXT")" != "$newest" ] || any_runner_stale; then
  update_runners_if_idle "$newest"
  case $? in
    1) failed=1 ;;
    2)
      busy="$(busy_runners | tr '\n' ';')"
      if pgrep -f '[-]-when-idle ' >/dev/null; then
        echo "a runner is busy (${busy%;}); the waiter already running installs and restarts once all are idle"
      else
        echo "a runner is busy (${busy%;}); the runner copy is installed and restarted once all are idle (log: $LOG)"
        setsid nohup sh "$0" --when-idle "$newest" >/dev/null 2>&1 </dev/null &
      fi
      ;;
  esac
fi

report
if [ "$failed" = 1 ]; then
  echo
  echo "Some copies did not update; see above and $LOG"
  exit 1
fi
