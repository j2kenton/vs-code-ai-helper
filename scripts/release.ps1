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

# --- vsce publish <bump> bumps package.json, commits "<version>", tags v<version>, and publishes ---
Write-Host ""
Write-Host "Publishing ($bump)..." -ForegroundColor Cyan
& pnpm run "publish:$bump"
if ($LASTEXITCODE -ne 0) {
    throw "vsce publish failed. package.json version may or may not have been bumped locally - check 'git status' and 'git log'."
}

$newVersion = (Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json).version
Write-Host ""
Write-Host "Published $newVersion ($bump). Don't forget to 'git push --follow-tags'." -ForegroundColor Green
