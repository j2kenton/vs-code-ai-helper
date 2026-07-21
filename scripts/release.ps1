#Requires -Version 5.1
<#
  Release script: bumps the extension version and publishes to the VS Code Marketplace.
  Replaces the "update versioning if not done yet and publish" AI prompt with a fixed script.
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

# Validate the release entry point before executing it. This prevents a
# modified package script from turning a release into arbitrary command execution.
$package = Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
$allowedRunners = @("npm", "pnpm", "yarn", "bun", "vsce")
foreach ($name in @("package", "publish:patch", "publish:minor", "publish:major")) {
    $command = [string]$package.scripts.$name
    if (-not $command) { throw "Missing package script '$name'." }
    $runner = ($command -split '\s+')[0]
    # Package scripts are deliberately limited to a runner plus `run <script>`
    # chains.  The package script uses &&, so validate each command rather than
    # rejecting the shell operator outright.
    $safe = ($command -match '^(?:[a-zA-Z0-9_:\-.]+\s+run\s+[a-zA-Z0-9_:\-.]+)(?:\s+&&\s+(?:[a-zA-Z0-9_:\-.]+\s+run\s+[a-zA-Z0-9_:\-.]+|node\s+[a-zA-Z0-9_./:\-]+(?:\s+--production)?))*$') -or
      ($command -match '^vsce\s+publish\s+(patch|minor|major)$')
    if ($allowedRunners -notcontains $runner -or -not $safe) {
        throw "Unsafe package script '$name': $command"
    }
}

# --- Guard: working tree must be clean, otherwise vsce will bump/commit/tag on top of unrelated changes ---
$status = & git status --porcelain
if ($status) {
    Write-Host "Working tree has uncommitted changes:" -ForegroundColor Yellow
    Write-Host $status
    throw "Commit or stash your changes before releasing."
}

$currentVersion = (Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json).version
Write-Host "Current published version: $currentVersion" -ForegroundColor Cyan
Write-Host ""

# --- Prompt for bump type, with a reminder of what each one means ---
Write-Host "Which kind of release is this?" -ForegroundColor Cyan
Write-Host "  [1] patch  -> 0.0.X  bug fixes, small internal changes, no new features, nothing breaks"
Write-Host "  [2] minor  -> 0.X.0  new features / commands, backwards compatible"
Write-Host "  [3] major  -> X.0.0  breaking changes (rare for an extension: e.g. dropped commands/settings)"
Write-Host ""

$choice = Read-Host "Enter 1, 2, or 3 (or type patch/minor/major)"

switch -Regex ($choice.Trim().ToLower()) {
    '^(1|patch)$' { $bump = "patch" }
    '^(2|minor)$' { $bump = "minor" }
    '^(3|major)$' { $bump = "major" }
    default {
        throw "Unrecognized choice '$choice'. Expected patch, minor, or major."
    }
}

Write-Host ""
Write-Host "Selected: $bump release" -ForegroundColor Green

# --- Build/verify before publishing (same checks vscode:prepublish would run) ---
Write-Host ""
Write-Host "Running checks (type-check, lint, build)..." -ForegroundColor Cyan
& pnpm run package
if ($LASTEXITCODE -ne 0) {
    throw "pnpm run package failed. Fix the errors above before publishing."
}

# --- Guard: the package must not contain task run logs, notes, or other private
# files. v0.53.0-v0.56.1 shipped ~82 MB of AI prompts and run logs because a
# folder rename updated .gitignore but not .vscodeignore, and vsce ignores
# .gitignore whenever .vscodeignore exists. That failure was silent; this check
# is not. See scripts/verify-package-contents.js. ---
Write-Host ""
Write-Host "Verifying package contents..." -ForegroundColor Cyan
& node (Join-Path $repoRoot "scripts/verify-package-contents.js")
if ($LASTEXITCODE -ne 0) {
    throw "Package contents check failed. Fix .vscodeignore before publishing."
}

# --- vsce publish <bump> bumps package.json, commits "<version>", tags v<version>, and publishes ---
Write-Host ""
Write-Host "Publishing ($bump)..." -ForegroundColor Cyan
& pnpm run "publish:$bump"
if ($LASTEXITCODE -ne 0) {
    throw "vsce publish failed. package.json version may or may not have been bumped locally - check 'git status' and 'git log'."
}

$newVersion = (Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json).version
Write-Host ""
Write-Host "Published $newVersion ($bump)." -ForegroundColor Green

# --- Push the version-bump commit and tag that vsce created locally ---
Write-Host ""
Write-Host "Pushing commit and tags..." -ForegroundColor Cyan
& git push --follow-tags
if ($LASTEXITCODE -ne 0) {
    throw "git push --follow-tags failed. The extension is already published to the Marketplace - push manually to sync the repo."
}
