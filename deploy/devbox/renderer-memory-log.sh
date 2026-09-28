#!/bin/sh
# Record every VS Code renderer's memory, so the NEXT crash comes with evidence.
#
# WHY: three renderers died with "renderer process gone (reason: crashed, code:
# 133)" inside 24 hours (box A 2026-09-22 afternoon, box D 18:50, box A
# 2026-09-23 09:53), each taking its extension host and a live workflow round
# with it — the last one a Fast Forward Review that had been running for 96
# minutes. Neither known cause applied to the overnight one: no OOM kill in the
# kernel log, and /dev/shm was 2 GB with nothing used. The remaining candidate
# is the renderer memory growth measured earlier in this project (550 MB
# climbing to ~2.8 GB over about eight hours), but a dead renderer cannot be
# measured afterwards — the process is gone before anyone looks.
#
# So this samples them while they live. It reads `ps` and appends a line per
# renderer. It starts nothing, kills nothing, and writes only to its own log:
# it cannot affect a running round, which is the whole point of it being safe
# to leave on.
#
# Attribution: a renderer is a child of the ZYGOTE, not of its window, so the
# process tree does not lead back to a workspace. It does carry
# `--user-data-dir=`, and one profile is one box here, so that is the reliable
# link. Note the command line cannot be split on NULs the usual way —
# Chromium rewrites it as a single string — so this greps the whole thing
# rather than walking argv, which is why an earlier per-argument version
# reported every renderer as `unknown`.
set -u

INTERVAL="${RENDERER_LOG_INTERVAL:-120}"
LOG="${RENDERER_LOG_FILE:-$HOME/.devbox-logs/renderer-memory.log}"
MAX_LINES="${RENDERER_LOG_MAX_LINES:-20000}"

mkdir -p "$(dirname "$LOG")"

# One profile is one box. Named rather than left as a path so a line of this
# log is readable without knowing the layout.
box_for_profile() {
  case "$1" in
    */.config/Code) echo "A:vs-code-ai-helper" ;;
    */.config/Code-runner-2) echo "B:wt-b" ;;
    */.config/Code-runner-3) echo "C:wt-c" ;;
    */.config/Code-runner-4) echo "D:wt-d" ;;
    "") echo "unknown" ;;
    *) basename "$1" ;;
  esac
}

sample() {
  stamp="$(date -u +%FT%TZ)"
  for pid in $(pgrep -f 'type=renderer' 2>/dev/null); do
    rss="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')"
    [ -n "$rss" ] || continue
    age="$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')"
    profile="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null |
      grep -o '\-\-user-data-dir=[^ ]*' | head -1 | cut -d= -f2)"
    box="$(box_for_profile "$profile")"
    printf '%s pid=%s box=%s rss_mb=%s age_s=%s\n' \
      "$stamp" "$pid" "${box:-unknown}" "$((rss / 1024))" "${age:-0}" >>"$LOG"
  done
  # Also the container total, so a sample can be read against the cap.
  if [ -r /sys/fs/cgroup/memory.current ]; then
    cur="$(cat /sys/fs/cgroup/memory.current)"
    max="$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo 0)"
    printf '%s container_mb=%s of %s\n' \
      "$stamp" "$((cur / 1048576))" "$((max / 1048576))" >>"$LOG"
  fi
}

trim() {
  lines="$(wc -l <"$LOG" 2>/dev/null || echo 0)"
  if [ "$lines" -gt "$MAX_LINES" ]; then
    tail -n "$((MAX_LINES / 2))" "$LOG" >"$LOG.trimmed" && mv "$LOG.trimmed" "$LOG"
  fi
}

printf '%s renderer-memory-log starting (every %ss)\n' "$(date -u +%FT%TZ)" "$INTERVAL" >>"$LOG"
while true; do
  sample
  trim
  sleep "$INTERVAL"
done
