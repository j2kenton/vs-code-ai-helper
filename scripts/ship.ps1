#Requires -Version 5.1
<#
  Ship: release Ensemble, wait until the new version is live on the
  Marketplace, then update the dev box and this machine's VS Code to it.

    ship                  run the release menu (scripts/release.ps1), then roll out
    ship -Choice patch    answer the release menu without asking (1-6, or
                          patch / minor / major / pre-release / promote)
    ship -Version 1.20.0  skip the release; roll out 1.20.0 once it is live
    ship -SkipBox         do not touch the dev box
    ship -SkipLocal       do not touch this machine's VS Code

  Nothing is rolled out until the Marketplace both LISTS the version and
  SERVES its package (the same download the box's update-ensemble.sh makes),
  so a failed or still-processing publish never reaches the box or VS Code.

  The box update is ~/update-ensemble.sh <version> (see deploy/devbox/): it
  installs into the runner and both viewers, and touches the runner only once
  every runner is idle. Local VS Code gets the same version through the
  `code` CLI; reload the window afterwards to load it.

  One-time setup, so "ship" works in every PowerShell window: add this line to
  your profile (notepad $PROFILE), with the path to your clone:
    function ship { & 'C:\path\to\vs-code-ai-helper\scripts\ship.ps1' @args }

  ASCII only, deliberately: Windows PowerShell 5.1 reads a UTF-8 file with no
  BOM as ANSI (see install-local.ps1).
#>

param(
    [string]$Choice,
    [string]$Version,
    [switch]$SkipBox,
    [switch]$SkipLocal,
    [int]$TimeoutMinutes = 30,
    [int]$PollSeconds = 30
)

$ErrorActionPreference = 'Stop'

$ExtensionId = 'j2kenton.vs-code-ai-helper'
$Publisher, $Name = $ExtensionId.Split('.', 2)
$BoxHost = 'ensemble-devbox'
$RepoRoot = Split-Path -Parent $PSScriptRoot

function Get-PackageVersion {
    [string](Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json).version
}

function Test-Listed([string]$v) {
    $body = '{"filters":[{"criteria":[{"filterType":7,"value":"' + $ExtensionId + '"}],"pageSize":1}],"flags":17}'
    try {
        $r = Invoke-RestMethod -Method Post -TimeoutSec 30 `
            -Uri 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery' `
            -ContentType 'application/json' `
            -Headers @{ Accept = 'application/json;api-version=7.2-preview.1' } `
            -Body $body
        $versions = @($r.results[0].extensions[0].versions)
        return @($versions | Where-Object { $_.version -eq $v }).Count -gt 0
    }
    catch {
        return $false
    }
}

function Test-Downloadable([string]$v) {
    # HEAD is refused (405) and Range is ignored, so this is a full GET of the
    # package (a few MB), thrown away. Only made once the version is listed.
    $url = "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/$Publisher/vsextensions/$Name/$v/vspackage"
    $code = & curl.exe -s -L -m 120 -o NUL -w '%{http_code}' $url
    return ($LASTEXITCODE -eq 0 -and $code -eq '200')
}

function Test-Live([string]$v) {
    (Test-Listed $v) -and (Test-Downloadable $v)
}

function Wait-Live([string]$v) {
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    Write-Host ""
    Write-Host "Waiting for $v to go live on the Marketplace (checking every $PollSeconds s, up to $TimeoutMinutes min)..." -ForegroundColor Cyan
    while ($true) {
        if (Test-Live $v) {
            Write-Host "$v is live." -ForegroundColor Green
            return
        }
        if ((Get-Date) -gt $deadline) {
            throw "$v is still not live after $TimeoutMinutes minutes. Nothing was rolled out. Once it shows on the Marketplace, run: ship -Version $v"
        }
        Write-Host ("  {0}  not live yet" -f (Get-Date -Format 'HH:mm:ss')) -ForegroundColor DarkGray
        Start-Sleep -Seconds $PollSeconds
    }
}

if ($Version -and $Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "-Version must look like 1.20.0 (got '$Version')."
}
if ($Version -and $Choice) {
    throw "Use -Choice to release, or -Version to roll out an existing version, not both."
}

# The caller's folder is restored in the finally below: a script run with &
# from the profile shares the terminal's location, so without this every
# ship would leave the terminal sitting in the repo.
Push-Location $RepoRoot
try {

# --- 1. Release (unless a version was given) ---
if ($Version) {
    $target = $Version
    Write-Host "Skipping the release; rolling out $target." -ForegroundColor Cyan
}
else {
    $before = Get-PackageVersion
    $releaseArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $RepoRoot 'scripts\release.ps1'))
    if ($Choice) { $releaseArgs += @('-Choice', $Choice) }
    & powershell @releaseArgs
    $releaseExit = $LASTEXITCODE
    $target = Get-PackageVersion

    if ($target -eq $before) {
        throw "Version is still $before, so nothing was published. Nothing was rolled out."
    }
    if ($releaseExit -ne 0) {
        # release.ps1 can fail AFTER publishing (for example the git push), so
        # ask the Marketplace instead of giving up or waiting blindly.
        Write-Host ""
        Write-Host "The release script failed (exit $releaseExit), but package.json is now $target. Checking the Marketplace..." -ForegroundColor Yellow
        if (-not (Test-Listed $target)) {
            throw "$target is not on the Marketplace, so it was not published. Nothing was rolled out. Fix the release, then run: ship -Version $target"
        }
        Write-Host "$target was published; continuing. Fix whatever the release script reported (above) separately." -ForegroundColor Yellow
    }
}

# --- 2. Wait until it is live ---
Wait-Live $target

$failed = @()

# --- 3. Dev box ---
if ($SkipBox) {
    Write-Host "Skipping the dev box." -ForegroundColor DarkGray
}
else {
    Write-Host ""
    Write-Host "Updating the dev box to $target..." -ForegroundColor Cyan
    & ssh $BoxHost "~/update-ensemble.sh $target"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Dev box update failed (exit $LASTEXITCODE). Retry with: box update $target" -ForegroundColor Red
        $failed += 'dev box'
    }
}

# --- 4. Local VS Code ---
if ($SkipLocal) {
    Write-Host "Skipping local VS Code." -ForegroundColor DarkGray
}
else {
    Write-Host ""
    Write-Host "Updating local VS Code to $target..." -ForegroundColor Cyan
    if (-not (Get-Command code -ErrorAction SilentlyContinue)) {
        Write-Host "The 'code' CLI is not on PATH. In VS Code run: Shell Command: Install 'code' command in PATH." -ForegroundColor Red
        $failed += 'local VS Code'
    }
    else {
        & code --install-extension "$ExtensionId@$target" --force
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Local install failed (exit $LASTEXITCODE). Retry with: code --install-extension $ExtensionId@$target --force" -ForegroundColor Red
            $failed += 'local VS Code'
        }
    }
}

# --- Summary ---
Write-Host ""
if ($failed.Count -gt 0) {
    Write-Host ("Shipped $target, but these did not update: " + ($failed -join ', ') + '.') -ForegroundColor Red
    exit 1
}
Write-Host "Shipped $target." -ForegroundColor Green
if (-not $SkipLocal) {
    Write-Host "Reload your VS Code windows (Developer: Reload Window) to load it." -ForegroundColor Green
}
if (-not $SkipBox) {
    Write-Host "Box viewer windows load it on their next reload; a busy runner restarts once it is idle (see the box output above)." -ForegroundColor Green
}

}
finally {
    Pop-Location
}
