# ──────────────────────────────────────────────────────────────────────
# fast_push_win.ps1
# 一键：递增版本 → 提交 → 同步远端 → 推送 → 打 tag → 触发 Release
# ──────────────────────────────────────────────────────────────────────

$ErrorActionPreference = 'Continue'

# 切换到脚本所在目录（项目根目录）
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $ROOT

$TAURI_CONF   = 'src-tauri/tauri.conf.json'
$PACKAGE_JSON = 'package.json'
$CARGO_TOML   = 'src-tauri/Cargo.toml'
$CARGO_LOCK   = 'src-tauri/Cargo.lock'
$CRATE_NAME   = 'superftp'  # [package].name in src-tauri/Cargo.toml
$REMOTE       = if ($env:REMOTE) { $env:REMOTE } else { 'origin' }
$BRANCH       = (git rev-parse --abbrev-ref HEAD 2>&1).Trim()

# ── helpers ─────────────────────────────────────────────────────────────
function Assert-GitOK {
    param([string]$action)
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Error: ${action} failed (exit code $LASTEXITCODE)" -ForegroundColor Red
        Pop-Location
        Read-Host 'Press Enter to exit...'
        exit 1
    }
}

function Sync-RemoteBranch {
    Write-Host "Syncing ${REMOTE}/${BRANCH}..."
    git fetch $REMOTE
    git pull --rebase $REMOTE $BRANCH
}

function Read-Version {
    $content = Get-Content $TAURI_CONF -Raw
    if ($content -match '"version"\s*:\s*"([^"]*)"') {
        return $Matches[1]
    }
    throw "Cannot read version from $TAURI_CONF"
}

function Bump-Patch {
    param([string]$ver)
    $parts = $ver.Split('.')
    $parts[2] = ([int]$parts[2] + 1).ToString()
    return ($parts -join '.')
}

function Write-Version {
    param([string]$ver)

    # tauri.conf.json — first "version" field
    $c = Get-Content $TAURI_CONF -Raw
    $c = $c -replace '("version"\s*:\s*)"[^"]*"', "`$1`"$ver`""
    [System.IO.File]::WriteAllText((Resolve-Path $TAURI_CONF), $c)

    # package.json — first "version" field
    $c = Get-Content $PACKAGE_JSON -Raw
    $c = $c -replace '("version"\s*:\s*)"[^"]*"', "`$1`"$ver`""
    [System.IO.File]::WriteAllText((Resolve-Path $PACKAGE_JSON), $c)

    # Cargo.toml — top-level `version = "..."`
    $c = Get-Content $CARGO_TOML -Raw
    $c = $c -replace '(?m)^(version\s*=\s*)"[^"]*"', "`$1`"$ver`""
    [System.IO.File]::WriteAllText((Resolve-Path $CARGO_TOML), $c)

    # Cargo.lock — version under `name = "<crate>"`. Without this the
    # lockfile drifts on commit and the next `cargo build` rewrites it,
    # which breaks rebase-friendly CI builds.
    if (Test-Path $CARGO_LOCK) {
        $lines = Get-Content $CARGO_LOCK
        $inTarget = $false
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match "^name\s*=\s*`"$CRATE_NAME`"") {
                $inTarget = $true
            } elseif ($inTarget -and $lines[$i] -match '^version\s*=\s*"') {
                $lines[$i] = $lines[$i] -replace '(version\s*=\s*)"[^"]*"', "`$1`"$ver`""
                $inTarget = $false
            }
        }
        [System.IO.File]::WriteAllLines((Resolve-Path $CARGO_LOCK), $lines)
    }
}

function Test-RemoteTag {
    param([string]$tag)
    $result = git ls-remote --tags $REMOTE "refs/tags/$tag" 2>$null
    return ($LASTEXITCODE -eq 0 -and $result -and $result.ToString().Trim().Length -gt 0)
}

# ── main ────────────────────────────────────────────────────────────────

# Pre-fetch so the remote-tag check below sees the latest server state.
git fetch $REMOTE

$CURRENT = Read-Version
$NEW = Bump-Patch $CURRENT

while (Test-RemoteTag "v$NEW") {
    Write-Host "Tag v${NEW} already exists on ${REMOTE}, bumping..."
    $NEW = Bump-Patch $NEW
}

Write-Host "Version: ${CURRENT} -> ${NEW}"
Write-Version $NEW

$DATETIME = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$COMMIT_MSG = "release: v${NEW} (${DATETIME})"

git add .

# Bail out if there's literally nothing to commit (no code change + no
# version diff — shouldn't happen because we just bumped, but defensive).
$null = git diff --cached --quiet 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host 'No changes to commit.'
    Pop-Location
    Read-Host 'Press Enter to exit...'
    exit 1
}

git commit -m $COMMIT_MSG
Assert-GitOK "git commit"

# Sometimes a pre-commit hook or formatter rewrites files; sweep those
# into the same commit so the release is self-contained.
$null = git diff --quiet 2>&1;          $d1 = $LASTEXITCODE
$null = git diff --cached --quiet 2>&1; $d2 = $LASTEXITCODE
if ($d1 -ne 0 -or $d2 -ne 0) {
    Write-Host 'Warning: unstaged changes remain, amending into this commit...'
    git add -A
    git commit --amend --no-edit
}

# Rebase on top of the remote — working tree is clean now.
Sync-RemoteBranch

Write-Host "Pushing to ${REMOTE}/${BRANCH}..."
git push $REMOTE $BRANCH
Assert-GitOK "git push"

# Create and push the tag. If a stale local tag exists with the same
# name (e.g. from a previous failed run), drop it first.
$TAG = "v${NEW}"
$null = git rev-parse $TAG 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Local tag ${TAG} already exists, recreating..."
    git tag -d $TAG
}

git tag $TAG
Write-Host "Pushing tag ${TAG}..."
git push $REMOTE $TAG
Assert-GitOK "git push tag"

# ── summary ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host 'Done:'
Write-Host "  - Code pushed to ${REMOTE}/${BRANCH}"
Write-Host "  - Tag: ${TAG}"
Write-Host "  - Release workflow will build & publish to GitHub Releases"

$gh = Get-Command gh -ErrorAction SilentlyContinue
if ($gh) {
    $repoUrl = (gh repo view --json url -q .url 2>$null)
    if ($repoUrl) {
        Write-Host "  - Actions:  ${repoUrl}/actions/workflows/release.yml"
        Write-Host "  - Releases: ${repoUrl}/releases/tag/${TAG}"
    }
}

Pop-Location
Read-Host 'Press Enter to exit...'
