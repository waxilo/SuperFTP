#!/usr/bin/env bash
# 一键：递增版本 → 提交 → 同步远端 → 推送 → 打 tag → 触发 Release
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

TAURI_CONF="src-tauri/tauri.conf.json"
PACKAGE_JSON="package.json"
CARGO_TOML="src-tauri/Cargo.toml"
CARGO_LOCK="src-tauri/Cargo.lock"
CRATE_NAME="superftp"   # [package].name in src-tauri/Cargo.toml
REMOTE="${REMOTE:-origin}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# 本次发布说明：优先取命令行参数或 RELEASE_NOTES 环境变量；
# 为空则尝试用本地 claude CLI 自动总结，否则只用一行 release 标题。
MANUAL_NOTES="${RELEASE_NOTES:-${1:-}}"
NOTES_MODEL="${RELEASE_NOTES_MODEL:-haiku}"

sync_remote_branch() {
    echo "Syncing ${REMOTE}/${BRANCH}..."
    git fetch "$REMOTE"
    git pull --rebase "$REMOTE" "$BRANCH"
}

read_version() {
    grep -o '"version": "[^"]*"' "$TAURI_CONF" | head -1 | cut -d'"' -f4
}

write_version() {
    local ver="$1"
    # BSD sed on macOS: `-i ''` for in-place edits without a backup file.
    sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"${ver}\"/" "$TAURI_CONF" "$PACKAGE_JSON"
    sed -i '' "s/^version = \"[^\"]*\"/version = \"${ver}\"/" "$CARGO_TOML"
    # Keep Cargo.lock in sync so the next `cargo build` doesn't dirty the
    # tree and break rebases. The `/^name = .../,/^version = /` range
    # limits the replacement to the right [[package]] block.
    if [ -f "$CARGO_LOCK" ]; then
        sed -i '' "/^name = \"${CRATE_NAME}\"$/,/^version = / s/^version = \"[^\"]*\"/version = \"${ver}\"/" "$CARGO_LOCK"
    fi
}

bump_patch() {
    echo "$1" | awk -F. '{ $NF = $NF + 1; print $1"."$2"."$3 }'
}

tag_exists_on_remote() {
    git ls-remote --tags "$REMOTE" "refs/tags/$1" | grep -q .
}

# Build the body for this commit / annotated tag.
# Order of preference: explicit notes → AI summary (if `claude` is installed)
# → empty (caller falls back to the subject line only).
generate_release_notes() {
    if [ -n "$MANUAL_NOTES" ]; then
        printf '%s' "$MANUAL_NOTES"
        return 0
    fi

    if ! command -v claude >/dev/null 2>&1; then
        echo "claude CLI not found, skipping AI release notes (use the first arg or RELEASE_NOTES to set manually)" >&2
        return 0
    fi

    # Exclude version-bump-only files so the model summarizes real changes.
    local diff
    diff="$(git diff --cached \
        -- ':(exclude)package.json' \
           ':(exclude)src-tauri/tauri.conf.json' \
           ':(exclude)src-tauri/Cargo.toml' \
           ':(exclude)src-tauri/Cargo.lock' \
        2>/dev/null)"

    if [ -z "$diff" ]; then
        echo "Only version-bump changes detected, skipping AI release notes" >&2
        return 0
    fi

    echo "Asking AI (${NOTES_MODEL}) to summarize this release..." >&2
    local notes
    notes="$(printf '%s' "$diff" | head -c 60000 | claude -p --model "$NOTES_MODEL" \
        '你是发布日志助手。根据输入的 git diff，用简体中文总结本次发布的主要改动。要求：输出 3-6 条要点，每条以「- 」开头；聚焦用户可感知的功能、修复与体验改进；不要描述代码实现细节；不要输出标题或多余说明文字。' \
        2>/dev/null || true)"
    printf '%s' "$notes" | sed -e 's/[[:space:]]*$//'
}

# Pre-fetch for the remote-tag-existence check below.
git fetch "$REMOTE"

CURRENT="$(read_version)"
NEW="$(bump_patch "$CURRENT")"

while tag_exists_on_remote "v${NEW}"; do
    echo "Tag v${NEW} already exists on ${REMOTE}, bumping..."
    NEW="$(bump_patch "$NEW")"
done

echo "Version: ${CURRENT} -> ${NEW}"
write_version "$NEW"

DATETIME="$(date '+%Y-%m-%d %H:%M:%S')"
SUBJECT="release: v${NEW} (${DATETIME})"

git add .
if git diff --cached --quiet; then
    echo "No changes to commit."
    exit 1
fi

# Build release notes (manual or AI), then fold them into both the commit
# message and the annotated tag so the Release workflow can surface them.
NOTES="$(generate_release_notes)"
if [ -n "$NOTES" ]; then
    echo "Release notes:"
    printf '%s\n' "$NOTES" | sed 's/^/  /'
    COMMIT_MSG="$(printf '%s\n\n%s\n' "$SUBJECT" "$NOTES")"
else
    COMMIT_MSG="$SUBJECT"
fi

git commit -m "$COMMIT_MSG"

# Sweep any post-commit hook fallout into this release commit.
if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Warning: unstaged changes remain, amending into this commit..."
    git add -A
    git commit --amend --no-edit
fi

sync_remote_branch

echo "Pushing to ${REMOTE}/${BRANCH}..."
git push "$REMOTE" "$BRANCH"

TAG="v${NEW}"
if git rev-parse "$TAG" >/dev/null 2>&1; then
    echo "Local tag ${TAG} already exists, recreating..."
    git tag -d "$TAG"
fi

# Annotated tag so the Release workflow can read the body via
# `git tag -l --format='%(contents:body)'`.
if [ -n "$NOTES" ]; then
    git tag -a "$TAG" -m "$SUBJECT" -m "$NOTES"
else
    git tag -a "$TAG" -m "$SUBJECT"
fi
echo "Pushing tag ${TAG}..."
git push "$REMOTE" "$TAG"

echo ""
echo "Done:"
echo "  - Code pushed to ${REMOTE}/${BRANCH}"
echo "  - Tag: ${TAG}"
echo "  - Release workflow will build macOS / Windows and publish to GitHub Releases"

if command -v gh >/dev/null 2>&1; then
    REPO_URL="$(gh repo view --json url -q .url 2>/dev/null || true)"
    if [ -n "$REPO_URL" ]; then
        echo "  - Actions:  ${REPO_URL}/actions/workflows/release.yml"
        echo "  - Releases: ${REPO_URL}/releases/tag/${TAG}"
    fi
fi
