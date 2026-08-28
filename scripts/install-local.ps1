#Requires -Version 5.1
<#
  Local install: package the CURRENT working tree into a .vsix and install it
  over whatever copy of the extension is running, without publishing.

  Deliberately NOT scripts/release.ps1. That script bumps the version, commits,
  tags and publishes to the Marketplace, and refuses to run on a dirty tree.
  This one exists for the dogfooding loop — testing an uncommitted change in the
  real editor — so it:
    * requires no version bump (installs over the same version with --force)
    * requires no clean tree (testing uncommitted work is the point)
    * publishes nothing

  A locally installed build is replaced the next time a HIGHER version is
  published to the Marketplace, since the extension is still Marketplace-linked.
  Same-version publishes will not displace it.
#>

$ErrorActionPreference = "Stop"

function Get-RepoRoot {
    $root = & git rev-parse --show-toplevel 2>$null
    if (-not $root) {
        throw "Not inside a git repository."
    }
    return $root.Trim()
}

$repoRoot = Get-RepoRoot
Set-Location $repoRoot

# `code` is what actually installs the package; fail here with something
# actionable rather than after a multi-minute build.
$codeCmd = Get-Command code -ErrorAction SilentlyContinue
if (-not $codeCmd) {
    throw "The 'code' CLI is not on PATH. In VS Code run: Shell Command: Install 'code' command in PATH."
}

$package = Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
$name = [string]$package.name
$version = [string]$package.version
if (-not $name -or -not $version) {
    throw "package.json is missing 'name' or 'version'."
}
$vsixPath = Join-Path $repoRoot "$name-$version.vsix"

$dirty = & git status --porcelain
if ($dirty) {
    $count = ($dirty | Measure-Object -Line).Lines
    Write-Host "Packaging working tree with $count uncommitted change(s) — that is the point of this script." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Packaging $name $version ..." -ForegroundColor Cyan
Write-Host "(runs check-types, lint, esbuild --production and verify:workflow-safety)" -ForegroundColor DarkGray

# `npm run vsix` is `vsce package`, whose vscode:prepublish runs the full
# package + contents verification. Let its own output through; it is the part
# most likely to fail and the reason to fail is worth reading.
& npm run vsix
if ($LASTEXITCODE -ne 0) {
    throw "Packaging failed (npm run vsix exited $LASTEXITCODE). Nothing was installed; the running extension is unchanged."
}

if (-not (Test-Path $vsixPath)) {
    throw "Packaging reported success but $vsixPath was not produced. Check whether package.json's name/version changed mid-build."
}

$sizeMb = [Math]::Round((Get-Item $vsixPath).Length / 1MB, 2)
Write-Host ""
Write-Host "Installing $([System.IO.Path]::GetFileName($vsixPath)) ($sizeMb MB) ..." -ForegroundColor Cyan
# --force because the version is unchanged; without it VS Code skips the
# install as already-present and you silently keep running the old build.
& $codeCmd.Source --install-extension $vsixPath --force
if ($LASTEXITCODE -ne 0) {
    throw "Install failed (code --install-extension exited $LASTEXITCODE)."
}

Write-Host ""
Write-Host "Installed $name $version from the local working tree." -ForegroundColor Green
Write-Host "Reload the window for it to take effect: Developer: Reload Window." -ForegroundColor Yellow
