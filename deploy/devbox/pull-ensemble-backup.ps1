# Pull the newest Ensemble task-state snapshot off the cloud VM to this laptop.
#
# WHY: the VM's nightly backup and the docker volumes it backs up sit on the
# same disk, so it covers an accidental delete but not losing the VM. This is
# the off-machine copy. Task state is gitignored, so nothing else keeps it.
#
# Scheduled daily, but a laptop is often off at that hour. The scheduled task
# is registered with StartWhenAvailable, so a missed run fires shortly after
# the machine is next awake and logged on - this script is written to be
# safe to run late, twice, or many days after the last success.
#
# Safe by construction: it only reads over SSH, only writes into $LocalDir,
# and the only delete is of files matching the archive name pattern in that
# one directory.

$ErrorActionPreference = 'Stop'

$LocalDir  = 'C:\Users\jjk61\ensemble-backups'
$RemoteDir = 'ensemble-backups'
$SshHost   = 'ensemble-box'
$KeepDays  = 30
$Log       = Join-Path $LocalDir 'pull.log'

function Write-Log([string]$Message) {
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'), $Message
  Add-Content -LiteralPath $Log -Value $line
}

try {
  if (-not (Test-Path -LiteralPath $LocalDir)) {
    New-Item -ItemType Directory -Path $LocalDir | Out-Null
  }

  # BatchMode: never sit at a prompt under the scheduler. A laptop that just
  # woke may have no network yet, which is a plain failure here - the task's
  # own retry, and tomorrow's run, cover it.
  $newest = & ssh -o BatchMode=yes -o ConnectTimeout=20 $SshHost `
    "ls -t $RemoteDir/ensemble-tasks-*.tar.gz 2>/dev/null | head -1"
  if ($LASTEXITCODE -ne 0) {
    Write-Log "SKIPPED: could not reach $SshHost (ssh exit $LASTEXITCODE) - probably no network yet"
    exit 0
  }

  $newest = ($newest | Out-String).Trim()
  if ([string]::IsNullOrWhiteSpace($newest)) {
    Write-Log "SKIPPED: no archive on $SshHost yet"
    exit 0
  }

  $name  = Split-Path -Leaf $newest
  $dest  = Join-Path $LocalDir $name

  if (Test-Path -LiteralPath $dest) {
    Write-Log "OK: already have $name"
  } else {
    # Download to a .part and rename, so an interrupted copy can never leave
    # a truncated file that looks like a good backup.
    $part = "$dest.part"
    if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
    & scp -o BatchMode=yes -o ConnectTimeout=20 -q "${SshHost}:$newest" $part
    if ($LASTEXITCODE -ne 0) {
      if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
      Write-Log "FAILED: scp of $name exited $LASTEXITCODE"
      exit 1
    }
    # A snapshot of task records is ~10 MB; anything tiny means a truncated
    # or error-page download, not a backup.
    $size = (Get-Item -LiteralPath $part).Length
    if ($size -lt 100KB) {
      Remove-Item -LiteralPath $part -Force
      Write-Log "FAILED: $name came back only $size byte(s) - discarded"
      exit 1
    }
    Move-Item -LiteralPath $part -Destination $dest
    Write-Log ("OK: pulled {0} ({1:N1} MB)" -f $name, ($size / 1MB))
  }

  # Prune, scoped to this directory and this name pattern. Never removes the
  # newest file even if it is older than $KeepDays, so a long gap in runs
  # cannot leave the laptop with no copy at all.
  $archives = Get-ChildItem -LiteralPath $LocalDir -Filter 'ensemble-tasks-*.tar.gz' |
    Sort-Object LastWriteTime -Descending
  $cutoff = (Get-Date).AddDays(-$KeepDays)
  foreach ($old in $archives | Select-Object -Skip 1) {
    if ($old.LastWriteTime -lt $cutoff) {
      Remove-Item -LiteralPath $old.FullName -Force
      Write-Log "pruned $($old.Name)"
    }
  }
} catch {
  Write-Log "FAILED: $($_.Exception.Message)"
  exit 1
}
