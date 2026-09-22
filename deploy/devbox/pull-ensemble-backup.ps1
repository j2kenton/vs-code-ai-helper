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
# EXIT STATUS IS THE RETRY SIGNAL. The scheduled task is registered with three
# retries fifteen minutes apart, and Task Scheduler only retries a run that
# FAILED. The first version exited 0 when it could not reach the VM, so the
# scheduler recorded success and the retries it was given never fired - on
# exactly the wake-with-no-network morning they exist for (review,
# 2026-09-22). A network or transport failure now exits non-zero; only a
# genuinely-nothing-to-do outcome exits 0.
#
# Safe by construction: it only reads over SSH, only writes into $LocalDir,
# and the only delete is of files matching the archive name pattern in that
# one directory.
#
# ASCII only, deliberately: written with em-dashes this parsed under pwsh 7
# and failed under Windows PowerShell 5.1, which reads a UTF-8 file with no
# BOM as ANSI. A scheduled task that silently stops parsing is worse than no
# scheduled task.

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

# Reads back an archive and reports whether it is a usable backup. Size alone
# is not evidence: a multi-megabyte truncated archive passed the old check,
# was renamed to its final name, logged as OK, and then counted as the newest
# protected copy while older restoreable ones were pruned (review,
# 2026-09-22). bsdtar ships with Windows, so the listing is a real check on
# any machine this runs on.
function Test-BackupArchive([string]$Path) {
  $entries = & tar -tzf $Path 2>$null
  if ($LASTEXITCODE -ne 0) {
    return @{ Ok = $false; Reason = 'not a readable gzip tar' }
  }
  $records = @($entries | Where-Object { $_ -match 'task-progress\.json$' }).Count
  if ($records -lt 1) {
    return @{ Ok = $false; Reason = 'holds no task records' }
  }
  return @{ Ok = $true; Records = $records; Files = @($entries).Count }
}

try {
  if (-not (Test-Path -LiteralPath $LocalDir)) {
    New-Item -ItemType Directory -Path $LocalDir | Out-Null
  }

  # The remote command sets its OWN exit status, because `ls ... | head -1`
  # reports head's status and hides every ls failure behind an empty line
  # (review, 2026-09-22):
  #   0 + a path  a snapshot to fetch
  #   3           the directory exists and is empty - nothing to do yet
  #   4           no backup directory at all - the VM job has not run
  #   anything else (255 and friends) is a transport or shell failure
  $remote = 'newest=$(ls -t ' + $RemoteDir + '/ensemble-tasks-*.tar.gz 2>/dev/null | head -1); ' +
            'if [ -n "$newest" ]; then printf "%s\n" "$newest"; exit 0; fi; ' +
            'if [ -d ' + $RemoteDir + ' ]; then exit 3; fi; exit 4'

  $newest = & ssh -o BatchMode=yes -o ConnectTimeout=20 $SshHost $remote
  $sshExit = $LASTEXITCODE

  if ($sshExit -eq 3 -or $sshExit -eq 4) {
    Write-Log "SKIPPED: no archive on $SshHost yet (remote status $sshExit)"
    exit 0
  }
  if ($sshExit -ne 0) {
    # Non-zero on purpose: this is what arms the scheduler's retries.
    Write-Log "FAILED: could not reach $SshHost (ssh exit $sshExit) - retrying per the task's retry policy"
    exit 1
  }

  $newest = ($newest | Out-String).Trim()
  if ([string]::IsNullOrWhiteSpace($newest)) {
    Write-Log "FAILED: $SshHost reported success but named no archive"
    exit 1
  }

  $name = Split-Path -Leaf $newest
  $dest = Join-Path $LocalDir $name

  if (Test-Path -LiteralPath $dest) {
    # Validate what is already here too: a copy that was promoted before this
    # check existed may not be a usable backup at all.
    $have = Test-BackupArchive $dest
    if ($have.Ok) {
      Write-Log "OK: already have $name ($($have.Records) task record(s))"
    } else {
      Write-Log "re-fetching $name - the local copy is unusable ($($have.Reason))"
      Remove-Item -LiteralPath $dest -Force
    }
  }

  if (-not (Test-Path -LiteralPath $dest)) {
    # Download to a .part and rename only after it reads back as a real
    # backup, so an interrupted or corrupt copy can never take the final name.
    $part = "$dest.part"
    if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
    & scp -o BatchMode=yes -o ConnectTimeout=20 -q "${SshHost}:$newest" $part
    if ($LASTEXITCODE -ne 0) {
      if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
      Write-Log "FAILED: scp of $name exited $LASTEXITCODE"
      exit 1
    }
    $check = Test-BackupArchive $part
    if (-not $check.Ok) {
      Remove-Item -LiteralPath $part -Force
      Write-Log "FAILED: $name $($check.Reason) - discarded, the previous copy is untouched"
      exit 1
    }
    $size = (Get-Item -LiteralPath $part).Length
    Move-Item -LiteralPath $part -Destination $dest
    Write-Log ("OK: pulled {0} ({1:N1} MB, {2} files, {3} task record(s))" -f $name, ($size / 1MB), $check.Files, $check.Records)
  }

  # Prune, scoped to this directory and this name pattern, and only ever
  # after a validated copy is in place. Never removes the newest file even if
  # it is older than $KeepDays, so a long gap in runs cannot leave the laptop
  # with no copy at all.
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
