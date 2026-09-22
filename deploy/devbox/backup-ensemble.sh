#!/bin/sh
# Nightly snapshot of every task's state on the dev box.
#
# WHY: `.ensemble` is gitignored, so task records never travel with a commit
# and nothing in git protects them. A `git clean -xdf` in any workspace — an
# ordinary thing to type, and other agents work in these checkouts — deletes
# every task record on the box instantly. So does removing the workspace
# volume by hand. Restarts and image rebuilds do NOT (run.sh never touches
# the volumes), so this guards against deletion, not against downtime.
#
# Runs on the VM HOST, not in the container: a backup that lives only inside
# the thing it is backing up protects nothing from that thing being removed.
# It is still the same physical disk, so it does not cover losing the VM —
# pull a copy to the laptop for that (see the note at the bottom).
#
# FAILS CLOSED, everywhere. The first version of this script reported OK in
# three situations where it had backed up nothing or something unusable, and
# a backup that lies is worse than no backup: it is the one you find out about
# on the day you need it. Every such path below is marked (review, 2026-09-22).
#
# Read-only against the box: tars to stdout, never writes into /workspace.
set -eu

BACKUP_DIR="${ENSEMBLE_BACKUP_DIR:-$HOME/ensemble-backups}"
KEEP_DAYS="${ENSEMBLE_BACKUP_KEEP_DAYS:-14}"
CONTAINER="${ENSEMBLE_BACKUP_CONTAINER:-ensemble-devbox}"
LOG="$BACKUP_DIR/backup.log"

mkdir -p "$BACKUP_DIR"

note() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" >>"$LOG"
}

fail() {
  note "FAILED: $1"
  exit 1
}

# One backup at a time. Two runs in the same second used to derive the same
# temporary filename and interleave their gzip streams, and one could rename
# the file while the other was still writing to it (review, 2026-09-22).
LOCK_DIR="$BACKUP_DIR/.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  note "SKIPPED: another backup holds $LOCK_DIR"
  exit 0
fi
trap 'rm -rf "$LOCK_DIR"; rm -f "${out:-}.part"' EXIT INT TERM

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/ensemble-tasks-$stamp.tar.gz"
# $$ as well as the timestamp: the lock makes a collision unreachable, and the
# unique name means a stale .part from a killed run cannot be picked up as
# this run's output either.
part="$out.part.$$"

# The container probe, with `docker ps` checked on its OWN exit status. Tested
# as a pipeline, the status was grep's, so a sudo failure or a broken Docker
# looked identical to "the container is stopped" and the job exited 0 with no
# backup taken (review, 2026-09-22).
if ! running="$(sudo docker ps --filter "name=$CONTAINER" --format '{{.Names}}' 2>&1)"; then
  fail "could not run 'docker ps' (sudo or Docker unavailable): $running"
fi
if ! printf '%s\n' "$running" | grep -qx "$CONTAINER"; then
  note "SKIPPED: container $CONTAINER is not running; nothing backed up"
  exit 0
fi

# -u dev: the workspace files are dev's, and root reading them is what made
# status.sh report a reassuring "0 files changed" for a repo it could not
# actually read.
#
# The list is built INSIDE the container, from two sources unioned:
#   - `*/.ensemble`, which is every workspace at the top level, and
#   - every workspace named in ~/.devbox-runner-workspaces that has a
#     `.ensemble` directory.
# The glob alone matches exactly one directory level, so a runner configured
# for a nested path (a git worktree under a checkout, say) was silently left
# out while the job still reported OK (review, 2026-09-22). The configured
# list is the authority on what a runner is actually working in, so anything
# on it is archived whatever its depth.
if ! sudo docker exec -u dev "$CONTAINER" sh -c '
      set -eu
      cd /workspace
      list=""
      for d in */.ensemble; do
        [ -d "$d" ] && list="$list
$d"
      done
      if [ -f "$HOME/.devbox-runner-workspaces" ]; then
        while IFS= read -r ws; do
          case "$ws" in
            /workspace/*) ;;
            *) continue ;;
          esac
          rel="${ws#/workspace/}"
          [ -d "$rel/.ensemble" ] || continue
          list="$list
$rel/.ensemble"
        done <"$HOME/.devbox-runner-workspaces"
      fi
      # Deduplicate, drop the leading blank line, and refuse to produce an
      # archive of nothing.
      set -- $(printf "%s\n" "$list" | grep -v "^$" | sort -u)
      [ "$#" -gt 0 ] || { echo "no .ensemble directories found under /workspace" >&2; exit 1; }
      exec tar czf - "$@"
    ' >"$part" 2>>"$LOG"; then
  rm -f "$part"
  fail "could not archive task state (see the error above)"
fi

# Real validation, each step on its own exit status. The previous version ran
# `tar tzf "$out" | wc -l` and read wc's status, and counted records with
# `grep -c ... || true` — so a truncated or corrupt archive passed both checks
# and was published and logged as OK (review, 2026-09-22).
gzip -t "$part" 2>>"$LOG" || { rm -f "$part"; fail "the archive is not valid gzip"; }

if ! entries="$(tar tzf "$part" 2>>"$LOG")"; then
  rm -f "$part"
  fail "the archive is not a readable tar"
fi

records="$(printf '%s\n' "$entries" | grep -c 'task-progress\.json$' || true)"
if [ "$records" -lt 1 ]; then
  rm -f "$part"
  fail "the archive holds no task records — refusing to publish it as a backup"
fi
files="$(printf '%s\n' "$entries" | grep -c . || true)"

# Published only now that it has been read back and found to contain task
# records. Everything above leaves the previous good snapshot untouched.
mv "$part" "$out"
size="$(du -h "$out" | cut -f1)"
note "OK: $out ($size, $files files, $records task record(s))"

# Prune old snapshots, and only AFTER a verified archive has been published,
# so a failed run can never delete the last good copy. Scoped to this
# directory and to the archive name pattern, so nothing else can be caught.
find "$BACKUP_DIR" -maxdepth 1 -name 'ensemble-tasks-*.tar.gz' -mtime "+$KEEP_DAYS" -print -delete >>"$LOG" 2>&1 || true

# To keep a copy off this machine, from the laptop:
#   scp ensemble-box:ensemble-backups/ensemble-tasks-*.tar.gz <somewhere local>
