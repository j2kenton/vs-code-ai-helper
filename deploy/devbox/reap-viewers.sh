#!/bin/sh
# Reclaim memory from browser-viewer sessions nobody is using.
#   sh reap-viewers.sh                # reap abandoned sessions (hourly)
#   sh reap-viewers.sh --restart-all   # drop every session (nightly)
#
# WHY: `code serve-web` gives each browser connection its own `server-main.js`,
# and each folder opened in it its own extension host at roughly 1 GB. The
# host is disposed when a browser disconnects GRACEFULLY; a closed lid, a
# killed tab or a dropped network leaves it resident indefinitely. On
# 2026-09-22 nine of them had accumulated (~7 GB) and the container hit its
# 28 GB cap: the kernel OOM-killed five processes, including a 4.3 GB provider
# and three VS Code windows, and took two live workflow rounds with them.
#
# Raising the cap is not the answer — the container already has 28 GB of a
# 32 GB VM, so the next GB comes out of the host that runs Docker and sshd.
# This reclaims what was never being used.
#
# WHAT IS SAFE TO KILL, and why this is conservative:
#
# A `server-main.js` session with NO extension-host children has no windows
# open in it — whatever the user was looking at is already gone, and the
# session is an empty shell. That is provable from the process tree, so it is
# the only thing the default mode touches, and only past an age threshold so
# a browser mid-handshake is never caught.
#
# A session WITH extension-host children is somebody's open viewer, and this
# script does not touch it in the default mode. The connections terminate at
# the `code-tunnel` listener rather than at the session, so there is no honest
# way from in here to tell an attached window from an abandoned one — and
# guessing would close a window somebody is reading.
#
# `--restart-all` drops every session regardless, for the nightly run: a
# viewer is just a viewer, it holds no state, and re-opening the URL rebuilds
# it in seconds. The `code serve-web` listener itself is left alone, so the
# URL and its connection token keep working.
set -u

IDLE_HOURS="${VIEWER_IDLE_HOURS:-3}"
LOG="${VIEWER_REAP_LOG:-$HOME/.devbox-logs/reap-viewers.log}"
mode="${1:-idle}"

mkdir -p "$(dirname "$LOG")"

note() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" >>"$LOG"
}

# Elapsed seconds for a pid, from ps's etimes (not the [[dd-]hh:]mm:ss form,
# which is a parsing trap).
age_seconds() {
  ps -o etimes= -p "$1" 2>/dev/null | tr -d ' '
}

rss_kb_tree() {
  total="$(ps -o rss= -p "$1" 2>/dev/null | tr -d ' ')"
  total="${total:-0}"
  for child in $(pgrep -P "$1" 2>/dev/null); do
    r="$(ps -o rss= -p "$child" 2>/dev/null | tr -d ' ')"
    total=$((total + ${r:-0}))
  done
  printf '%s\n' "$total"
}

reclaimed=0
killed=0
kept=0

for pid in $(pgrep -f '[s]erver-main.js' 2>/dev/null); do
  children="$(pgrep -P "$pid" -f extensionHost 2>/dev/null | grep -c . || true)"
  age="$(age_seconds "$pid")"
  [ -n "$age" ] || continue
  rss="$(rss_kb_tree "$pid")"

  if [ "$mode" = "--restart-all" ]; then
    reason="nightly restart"
  elif [ "$children" -gt 0 ]; then
    kept=$((kept + 1))
    continue
  elif [ "$age" -lt $((IDLE_HOURS * 3600)) ]; then
    # Childless but young: a browser may still be opening its first window.
    kept=$((kept + 1))
    continue
  else
    reason="no windows open, idle $((age / 3600))h"
  fi

  # The children first, so nothing is left parented to init.
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill "$child" 2>/dev/null || true
  done
  if kill "$pid" 2>/dev/null; then
    killed=$((killed + 1))
    reclaimed=$((reclaimed + rss))
    note "killed viewer session $pid ($((rss / 1024)) MB) - $reason"
  fi
done

if [ "$killed" -gt 0 ]; then
  note "reclaimed $((reclaimed / 1024)) MB from $killed session(s); left $kept in use"
else
  note "nothing to reap; $kept session(s) in use"
fi

printf 'reaped %s session(s), %s MB; left %s in use\n' "$killed" "$((reclaimed / 1024))" "$kept"
