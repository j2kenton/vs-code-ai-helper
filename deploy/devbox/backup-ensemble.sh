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
# pull a copy to the laptop for that (see README note at the bottom).
#
# EVERY workspace, discovered each run: `/workspace/*/.ensemble` is globbed
# inside the container, so a workspace added later is picked up with no
# change here. That is the whole reason the glob is not a hardcoded list.
#
# Read-only against the box: tars to stdout, never writes into /workspace.
set -eu

BACKUP_DIR="${ENSEMBLE_BACKUP_DIR:-$HOME/ensemble-backups}"
KEEP_DAYS="${ENSEMBLE_BACKUP_KEEP_DAYS:-14}"
CONTAINER="${ENSEMBLE_BACKUP_CONTAINER:-ensemble-devbox}"
LOG="$BACKUP_DIR/backup.log"

mkdir -p "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/ensemble-tasks-$stamp.tar.gz"

note() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" >>"$LOG"
}

if ! sudo docker ps --filter "name=$CONTAINER" --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  note "SKIPPED: container $CONTAINER is not running; nothing backed up"
  exit 0
fi

# -u dev: the workspace files are dev's, and root reading them is what made
# status.sh report a reassuring "0 files changed" for a repo it could not
# actually read. `sh -c` so the glob expands INSIDE the container.
# Written to a .part file first and renamed on success, so an interrupted run
# can never leave a truncated archive looking like a good backup.
if sudo docker exec -u dev "$CONTAINER" sh -c '
      set -eu
      cd /workspace
      # Every workspace that actually has task state. Fails loudly rather
      # than producing an empty archive if the glob matches nothing.
      set -- */.ensemble
      [ -e "$1" ] || { echo "no .ensemble directories found under /workspace" >&2; exit 1; }
      exec tar czf - "$@"
    ' >"$out.part" 2>>"$LOG"; then
  mv "$out.part" "$out"
  size="$(du -h "$out" | cut -f1)"
  files="$(tar tzf "$out" | wc -l)"
  records="$(tar tzf "$out" | grep -c 'task-progress\.json$' || true)"
  note "OK: $out ($size, $files files, $records task record(s))"
else
  rm -f "$out.part"
  note "FAILED: could not archive task state (see stderr above)"
  exit 1
fi

# Prune old snapshots. Scoped to this directory and to the archive name
# pattern, so nothing else can be caught by it.
find "$BACKUP_DIR" -maxdepth 1 -name 'ensemble-tasks-*.tar.gz' -mtime "+$KEEP_DAYS" -print -delete >>"$LOG" 2>&1 || true

# To keep a copy off this machine, from the laptop:
#   scp ensemble-box:ensemble-backups/ensemble-tasks-*.tar.gz <somewhere local>
