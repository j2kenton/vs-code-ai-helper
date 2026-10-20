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

function Get-LatestPublishedVersion {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ExtensionId
    )

    try {
        $json = & pnpm exec vsce show $ExtensionId --json 2>$null
        if (-not $json) {
            return $null
        }
        $data = $json | ConvertFrom-Json
        $latest = $data.versions | Select-Object -First 1
        if (-not $latest -or -not $latest.version) {
            return $null
        }
        return [string]$latest.version
    }
    catch {
        return $null
    }
}

function TryParse-SemVer {
    param(
        [Parameter(Mandatory = $true)]
        [string]$VersionText
    )

    try {
        return [Version]$VersionText
    }
    catch {
        return $null
    }
}

function Get-NewestReleaseTag {
    # Newest vMAJOR.MINOR.PATCH tag by version order (vsce tags every publish).
    $tags = @(& git tag --list "v*" --sort=-v:refname) | Where-Object { $_ -match '^v\d+\.\d+\.\d+$' }
    if ($tags.Count -eq 0) { return $null }
    return [string]$tags[0]
}

function Remove-PromoteWorktree {
    param([Parameter(Mandatory = $true)][string]$Path)
    # Only ever called on the uniquely named worktree this run created.
    # `git worktree remove` cannot delete a fresh node_modules on Windows
    # ("Directory not empty", "Filename too long" for deep react-native
    # paths), so delete it with rmdir and the \\?\ long-path prefix, then
    # drop git's record of the worktree. The name check keeps rmdir away from
    # any other folder.
    $full = [System.IO.Path]::GetFullPath($Path)
    if ((Test-Path -LiteralPath $full) -and (Split-Path $full -Leaf) -like "ensemble-promote-*") {
        # \\?\C:\... for a drive path, \\?\UNC\server\share\... for a UNC one.
        $longPath = if ($full.StartsWith("\\")) { "\\?\UNC\" + $full.Substring(2) } else { "\\?\" + $full }
        # Passed through an environment variable, not the command line: cmd
        # expands %...% only once, so a literal % in the path is never
        # re-expanded into a different folder.
        $env:ENSEMBLE_PROMOTE_RMDIR = $longPath
        try {
            & cmd /c 'rmdir /s /q "%ENSEMBLE_PROMOTE_RMDIR%"'
        }
        finally {
            Remove-Item Env:\ENSEMBLE_PROMOTE_RMDIR -ErrorAction SilentlyContinue
        }
    }
    & git worktree prune
    if (Test-Path $Path) {
        Write-Host "Could not delete the temporary folder $Path; delete it by hand." -ForegroundColor Yellow
    }
}

function Write-PromoteRecovery {
    # What is left to do by hand after a partial failure, as exact commands.
    param([Parameter(Mandatory = $true)][string[]]$Steps)
    Write-Host ""
    Write-Host "To finish by hand, run in the repository (on main):" -ForegroundColor Yellow
    foreach ($step in $Steps) { Write-Host "  $step" -ForegroundColor Yellow }
}

function Invoke-PromotePreRelease {
    <#
      Option 5: publish the newest PRE-RELEASE as the next STABLE version, built
      from that pre-release's own tag in a temporary worktree, so nothing on
      main that was never published goes out. The Marketplace will not re-mark
      an existing version as stable, so the same code gets the next even minor.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$FromTag,
        [Parameter(Mandatory = $true)][string]$ToVersion,
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$ExtensionId
    )

    $fromVersion = $FromTag.TrimStart('v')
    $message = "$ToVersion (stable, promoted from $FromTag)"
    $setVersionStep = "npm pkg set version=$ToVersion"
    $commitStep = "git commit --only -m `"$message`" -- package.json"
    $tagStep = "git tag -a v$ToVersion -m `"$message`" `"$FromTag^{commit}`""
    $pushMainStep = "git push origin main"
    $pushTagStep = "git push origin v$ToVersion"

    # The version commit and the push go to main, so refuse anywhere else.
    $branch = & git symbolic-ref --quiet --short HEAD
    if ($branch -ne "main") {
        $where = if ($branch) { $branch } else { "a detached HEAD" }
        throw "Option 5 must run on main (you are on $where). Check out main and try again."
    }
    # Uncommitted work elsewhere is fine (it is neither built nor committed),
    # but the version commit below must contain only the version change.
    if (& git status --porcelain -- package.json) {
        throw "package.json has uncommitted changes. Commit or stash them first; option 5 commits only the new version number."
    }
    if (& git tag --list "v$ToVersion") {
        throw "Tag v$ToVersion already exists locally; $ToVersion has been released before."
    }
    # A local clone can lack a tag that exists on GitHub, and the push at the
    # end needs GitHub anyway, so check it there too before publishing.
    $remoteTag = & git ls-remote --tags origin "refs/tags/v$ToVersion"
    if ($LASTEXITCODE -ne 0) {
        throw "Could not reach origin to check for tag v$ToVersion. Nothing was published."
    }
    if ($remoteTag) {
        throw "Tag v$ToVersion already exists on origin; $ToVersion has been released before. Run 'git fetch --tags'."
    }
    $published = Get-LatestPublishedVersion -ExtensionId $ExtensionId
    if (-not $published) {
        Write-Host "Could not read the Marketplace's latest version; continuing on the git tags alone." -ForegroundColor Yellow
    }
    elseif ($published -ne $fromVersion) {
        throw "The Marketplace's latest version is $published, not $fromVersion. Promote only the newest published pre-release."
    }

    Write-Host ""
    Write-Host "Promote pre-release $fromVersion to stable $ToVersion" -ForegroundColor Cyan
    Write-Host "  - builds the code at $FromTag in a temporary worktree (nothing unpublished on main is included)"
    Write-Host "  - publishes it as stable $ToVersion"
    Write-Host "  - sets main's package.json to $ToVersion and commits only that file"
    Write-Host "  - tags v$ToVersion on the same commit as $FromTag, and pushes main and the tag"
    Write-Host "    (your uncommitted changes are left as they are and are not pushed)"

    # A fresh, uniquely named folder per run, so cleanup can only ever delete
    # what this run created.
    $suffix = [guid]::NewGuid().ToString("N").Substring(0, 8)
    $worktree = Join-Path ([System.IO.Path]::GetTempPath()) "ensemble-promote-$ToVersion-$suffix"
    & git worktree prune
    & git worktree add --detach $worktree $FromTag
    if ($LASTEXITCODE -ne 0) { throw "git worktree add failed for $FromTag. Nothing was published." }

    try {
        Push-Location $worktree
        try {
            Write-Host ""
            Write-Host "Installing dependencies for $FromTag..." -ForegroundColor Cyan
            & pnpm install --frozen-lockfile
            if ($LASTEXITCODE -ne 0) { throw "pnpm install failed in the $FromTag worktree. Nothing was published." }

            # vsce runs vscode:prepublish (type-check, lint, production build,
            # workflow-safety, package-contents check) before publishing, so a
            # failing build publishes nothing. --no-update-package-json and
            # --no-git-tag-version keep the worktree untouched: the version is
            # set only in the published package.
            Write-Host ""
            Write-Host "Publishing $FromTag as stable $ToVersion..." -ForegroundColor Cyan
            & pnpm exec vsce publish $ToVersion --no-update-package-json --no-git-tag-version
            if ($LASTEXITCODE -ne 0) {
                # A dropped connection can fail here after the Marketplace has
                # already accepted the version, so do not claim nothing happened.
                Write-Host ""
                Write-Host "vsce publish reported a failure. Check the Marketplace for ${ToVersion}:" -ForegroundColor Yellow
                Write-Host "  pnpm exec vsce show $ExtensionId" -ForegroundColor Yellow
                Write-Host "If $ToVersion is NOT listed, nothing was released: fix the error and run option 5 again." -ForegroundColor Yellow
                Write-Host "If $ToVersion IS listed, the publish went through." -ForegroundColor Yellow
                Write-PromoteRecovery -Steps @($setVersionStep, $commitStep, $tagStep, $pushMainStep, $pushTagStep)
                throw "vsce publish failed."
            }
        }
        finally {
            Pop-Location
        }
    }
    finally {
        Remove-PromoteWorktree -Path $worktree
    }

    Write-Host ""
    Write-Host "Published $ToVersion (stable, from $FromTag)." -ForegroundColor Green

    # Record it in git, version commit first so a failure never leaves a tag
    # without it: main's package.json moves to the stable number so the next
    # release continues from it (pre-release -> next odd minor, patch ->
    # $ToVersion + 1 patch), then an annotated tag on the promoted commit.
    $packagePath = Join-Path $RepoRoot "package.json"
    $packageText = [System.IO.File]::ReadAllText($packagePath)
    $updated = [regex]::new('"version"\s*:\s*"[^"]*"').Replace($packageText, "`"version`": `"$ToVersion`"", 1)
    [System.IO.File]::WriteAllText($packagePath, $updated, (New-Object System.Text.UTF8Encoding($false)))
    # --only commits package.json alone; anything else you have staged stays
    # staged and uncommitted.
    & git commit --only -m $message -- package.json
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Published, but committing package.json failed (package.json already says $ToVersion)." -ForegroundColor Yellow
        Write-PromoteRecovery -Steps @($commitStep, $tagStep, $pushMainStep, $pushTagStep)
        throw "git commit failed."
    }

    & git tag -a "v$ToVersion" -m $message "$FromTag^{commit}"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Published and committed, but creating tag v$ToVersion failed." -ForegroundColor Yellow
        Write-PromoteRecovery -Steps @($tagStep, $pushMainStep, $pushTagStep)
        throw "git tag failed."
    }

    Write-Host ""
    Write-Host "Pushing main and v$ToVersion..." -ForegroundColor Cyan
    & git push origin main
    $pushMain = $LASTEXITCODE
    & git push origin "v$ToVersion"
    $pushTag = $LASTEXITCODE
    if ($pushMain -ne 0 -or $pushTag -ne 0) {
        $left = @()
        if ($pushMain -ne 0) { $left += $pushMainStep }
        if ($pushTag -ne 0) { $left += $pushTagStep }
        Write-Host "Published, committed and tagged, but a push failed. Fix the cause shown above" -ForegroundColor Yellow
        Write-Host "(network, sign-in, branch protection) first. If git said main on GitHub has" -ForegroundColor Yellow
        Write-Host "commits you do not have, run 'git pull --rebase --autostash origin main' first." -ForegroundColor Yellow
        Write-PromoteRecovery -Steps $left
        throw "git push failed."
    }
    Write-Host "Done." -ForegroundColor Green
}

$repoRoot = Get-RepoRoot
Set-Location $repoRoot

# Validate the release entry point before executing it. This prevents a
# modified package script from turning a release into arbitrary command execution.
$package = Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
$allowedRunners = @("npm", "pnpm", "yarn", "bun", "vsce")
# Only scripts the release actually runs: `package` (options 1-4) and
# `vscode:prepublish`, which vsce runs before packaging or publishing. Every
# option calls vsce directly, so the publish:* scripts are not used here.
foreach ($name in @("package", "vscode:prepublish")) {
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

$currentVersion = (Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json).version
Write-Host "Current version (package.json): $currentVersion" -ForegroundColor Cyan
Write-Host ""

# --- Version lines: the Marketplace has no "-beta" style labels, so stable and
# pre-release builds are told apart by the minor number: EVEN minors are stable
# (1.0.x, 1.2.x), ODD minors are pre-release (1.1.x, 1.3.x). A pre-release is
# always numbered above the latest stable, so users who opt in keep getting it. ---
if ($currentVersion -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
    throw "package.json version '$currentVersion' is not a plain MAJOR.MINOR.PATCH version."
}
$curMajor = [int]$Matches[1]; $curMinor = [int]$Matches[2]; $curPatch = [int]$Matches[3]
$onPreReleaseLine = ($curMinor % 2) -eq 1

if ($onPreReleaseLine) {
    $nextPatch = "$curMajor.$($curMinor + 1).0"   # leave the pre-release line
    $nextMinor = "$curMajor.$($curMinor + 1).0"
    $nextPreRelease = "$curMajor.$curMinor.$($curPatch + 1)"
}
else {
    $nextPatch = "$curMajor.$curMinor.$($curPatch + 1)"
    $nextMinor = "$curMajor.$($curMinor + 2).0"
    $nextPreRelease = "$curMajor.$($curMinor + 1).0"
}
$nextMajor = "$($curMajor + 1).0.0"

# Option 5 is offered only when the newest released tag is a pre-release.
$newestTag = Get-NewestReleaseTag
$promoteTo = $null
if ($newestTag -and $newestTag -match '^v(\d+)\.(\d+)\.(\d+)$' -and ([int]$Matches[2] % 2) -eq 1) {
    $promoteTo = "$($Matches[1]).$([int]$Matches[2] + 1).0"
    # Option 6: the pre-release that follows the promoted stable.
    $preReleaseAfterPromote = "$($Matches[1]).$([int]$Matches[2] + 2).0"
}

# --- Prompt for release type, with a reminder of what each one means ---
Write-Host "Which kind of release is this?" -ForegroundColor Cyan
Write-Host "  [1] patch       -> $nextPatch  bug fixes, small internal changes, no new features, nothing breaks"
Write-Host "  [2] minor       -> $nextMinor  new features / commands, backwards compatible"
Write-Host "  [3] major       -> $nextMajor  breaking changes (rare for an extension: e.g. dropped commands/settings)"
Write-Host "  [4] pre-release -> $nextPreRelease  only for users who chose 'Switch to Pre-Release Version'"
if ($promoteTo) {
    Write-Host "  [5] promote     -> $promoteTo  publish pre-release $newestTag as stable, without anything unpublished on main"
}
else {
    Write-Host "  [5] promote     -> (unavailable: the newest release, $newestTag, is not a pre-release)" -ForegroundColor DarkGray
}
if ($promoteTo) {
    Write-Host "  [6] promote + pre-release -> $promoteTo, then $preReleaseAfterPromote  option 5, then option 4 for everything on main since $newestTag"
}
else {
    Write-Host "  [6] promote + pre-release -> (unavailable: needs a pre-release to promote, as option 5 does)" -ForegroundColor DarkGray
}
if ($onPreReleaseLine) {
    Write-Host ""
    Write-Host "  (You are on the pre-release line, so patch and minor both publish the next stable minor.)" -ForegroundColor DarkGray
}
Write-Host ""

$choice = Read-Host "Enter 1-6 (or type patch/minor/major/pre-release/promote)"

$promoteThenPreRelease = $choice.Trim() -eq "6"
if ($promoteThenPreRelease -or $choice.Trim().ToLower() -match '^(5|promote)$') {
    if (-not $promoteTo) {
        throw "Nothing to promote: the newest release, $newestTag, is not a pre-release."
    }
    if ($promoteThenPreRelease) {
        # Check everything the option 4 half needs BEFORE the promote
        # publishes anything: it builds from the working folder, so that must
        # be clean, and there must be something new to pre-release.
        $status = & git status --porcelain
        if ($status) {
            Write-Host "Working tree has uncommitted changes:" -ForegroundColor Yellow
            Write-Host $status
            throw "Option 6 also pre-releases your working folder, so commit or stash your changes first (or use option 5 alone)."
        }
        # The pre-release must be part of main's history, or "commits since
        # the tag" would count unrelated work and promote a side branch.
        & git merge-base --is-ancestor $newestTag HEAD
        if ($LASTEXITCODE -ne 0) {
            throw "$newestTag is not part of main's history, so option 6 cannot tell what is new. Use option 5 and option 4 separately."
        }
        $newCommits = [int](& git rev-list --count "$newestTag..HEAD")
        if ($newCommits -eq 0) {
            throw "main has no commits since $newestTag, so there is nothing new to pre-release. Use option 5 alone."
        }
    }
    Invoke-PromotePreRelease -FromTag $newestTag -ToVersion $promoteTo -RepoRoot $repoRoot -ExtensionId "$($package.publisher).$($package.name)"
    if (-not $promoteThenPreRelease) {
        return
    }

    # Second half: continue exactly as option 4, from the version the promote
    # just committed to main's package.json.
    $promotedVersion = (Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json).version
    if ($promotedVersion -ne $promoteTo) {
        throw "Promoted to $promoteTo, but package.json says $promotedVersion. Stopping before the pre-release; run option 4 once that is fixed."
    }
    Write-Host ""
    Write-Host "Stable $promoteTo is out. Now pre-releasing main as $preReleaseAfterPromote..." -ForegroundColor Cyan
    $nextPreRelease = $preReleaseAfterPromote
    $choice = "4"
}

# --- Guard (options 1-4, and option 6's pre-release half): working tree must
# be clean, otherwise vsce will bump/commit/tag on top of unrelated changes and
# build them into the release. Option 5 builds from a tag in its own worktree,
# so it skips this. ---
$status = & git status --porcelain
if ($status) {
    Write-Host "Working tree has uncommitted changes:" -ForegroundColor Yellow
    Write-Host $status
    throw "Commit or stash your changes before releasing."
}

$preRelease = $false
switch -Regex ($choice.Trim().ToLower()) {
    '^(1|patch)$' { $bump = "patch"; $targetVersion = $nextPatch }
    '^(2|minor)$' { $bump = "minor"; $targetVersion = $nextMinor }
    '^(3|major)$' { $bump = "major"; $targetVersion = $nextMajor }
    '^(4|pre-?release)$' { $bump = "pre-release"; $targetVersion = $nextPreRelease; $preRelease = $true }
    default {
        throw "Unrecognized choice '$choice'. Expected patch, minor, major, or pre-release."
    }
}

# Belt and braces: the minor number must match the channel.
$targetMinor = [int]($targetVersion -split '\.')[1]
if ($preRelease -ne (($targetMinor % 2) -eq 1)) {
    throw "Internal error: $targetVersion does not fit the $bump channel (odd minor = pre-release, even minor = stable)."
}

Write-Host ""
Write-Host "Selected: $bump release -> $targetVersion" -ForegroundColor Green

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

# --- vsce publish <version> sets package.json to that version, commits "<version>",
# tags v<version>, and publishes. An explicit version (not patch/minor/major) keeps
# stable releases on even minors and pre-releases on odd ones. ---
Write-Host ""
Write-Host "Publishing $targetVersion ($bump)..." -ForegroundColor Cyan
$publishArgs = @("exec", "vsce", "publish", $targetVersion)
if ($preRelease) { $publishArgs += "--pre-release" }
$previousErrorActionPreference = $ErrorActionPreference
$hadNativeStderrPreference = Test-Path Variable:PSNativeCommandUseErrorActionPreference
if ($hadNativeStderrPreference) {
    $previousNativeStderrPreference = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
}

try {
    # Capture stdout+stderr so transient Marketplace errors can be classified
    # without letting warning-only stderr lines short-circuit the script.
    $ErrorActionPreference = "Continue"
    $publishLines = @(& pnpm @publishArgs 2>&1)
    $publishExitCode = $LASTEXITCODE
}
finally {
    $ErrorActionPreference = $previousErrorActionPreference
    if ($hadNativeStderrPreference) {
        $PSNativeCommandUseErrorActionPreference = $previousNativeStderrPreference
    }
}

$publishLines | ForEach-Object { Write-Host $_ }
if ($publishExitCode -ne 0) {
    $publishText = ($publishLines | ForEach-Object { $_.ToString() }) -join "`n"
    $isMarketplaceTransient =
    ($publishText -match "TF10216") -or
    ($publishText -match "Azure DevOps services are currently unavailable")

    $localVersionAfterFailure = (Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json).version
    $extensionId = "$($package.publisher).$($package.name)"
    $publishedVersion = Get-LatestPublishedVersion -ExtensionId $extensionId

    $localVersionParsed = TryParse-SemVer -VersionText $localVersionAfterFailure
    $publishedVersionParsed = if ($publishedVersion) { TryParse-SemVer -VersionText $publishedVersion } else { $null }

    $tagsAtHead = @(& git tag --points-at HEAD)
    $hasCurrentVersionTagAtHead = $tagsAtHead -contains "v$localVersionAfterFailure"

    Write-Host "" -ForegroundColor Yellow
    Write-Host "Publish failed." -ForegroundColor Yellow
    if ($publishedVersion) {
        Write-Host "Marketplace latest version: $publishedVersion" -ForegroundColor Yellow
    }
    else {
        Write-Host "Marketplace latest version: (unavailable)" -ForegroundColor Yellow
    }
    Write-Host "Local package.json version: $localVersionAfterFailure" -ForegroundColor Yellow

    if ($isMarketplaceTransient) {
        Write-Host "" -ForegroundColor Yellow
        Write-Host "Detected transient Marketplace outage (TF10216)." -ForegroundColor Yellow
    }

    if ($localVersionParsed -and $publishedVersionParsed -and $localVersionParsed -gt $publishedVersionParsed -and $hasCurrentVersionTagAtHead) {
        Write-Host "" -ForegroundColor Yellow
        Write-Host "A local release commit/tag appears to exist but is not published yet." -ForegroundColor Yellow
        Write-Host "Retry publishing THIS exact version (no extra bump):" -ForegroundColor Yellow
        $preReleaseFlag = if ($preRelease) { " --pre-release" } else { "" }
        Write-Host "  pnpm exec vsce publish $localVersionAfterFailure --no-git-tag-version --no-update-package-json --skip-duplicate$preReleaseFlag" -ForegroundColor Yellow
    }
    else {
        Write-Host "" -ForegroundColor Yellow
        Write-Host "Check local release state before retrying:" -ForegroundColor Yellow
        Write-Host "  git status --short" -ForegroundColor Yellow
        Write-Host "  git log --oneline -n 5" -ForegroundColor Yellow
    }

    throw "vsce publish failed. See diagnostics above."
}

$newVersion = (Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json).version
Write-Host ""
Write-Host "Published $newVersion ($bump)." -ForegroundColor Green
if ($preRelease) {
    Write-Host "Only users who chose 'Switch to Pre-Release Version' get this build; everyone else stays on stable." -ForegroundColor Green
}

# --- Push the version-bump commit and tag that vsce created locally ---
Write-Host ""
Write-Host "Pushing commit and tags..." -ForegroundColor Cyan
& git push --follow-tags
if ($LASTEXITCODE -ne 0) {
    throw "git push --follow-tags failed. The extension is already published to the Marketplace - push manually to sync the repo."
}
