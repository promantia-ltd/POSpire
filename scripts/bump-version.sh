#!/usr/bin/env bash
#
# bump-version.sh — Create a release branch and bump __init__.py version
#
# Usage:
#   ./scripts/bump-version.sh <version>
#
# Example:
#   ./scripts/bump-version.sh 1.0.0
#   → Creates branch release/v1.0.0
#   → Updates pospire/__init__.py to __version__ = "1.0.0"
#   → Commits the change
#

set -euo pipefail

VERSION="${1:-}"

if [[ -z "$VERSION" ]]; then
    echo "Usage: $0 <version>"
    echo "Example: $0 1.0.0"
    exit 1
fi

# Validate semver format
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Error: Version must be in semver format (e.g., 1.0.0)"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
INIT_FILE="$APP_DIR/pospire/__init__.py"
BRANCH_NAME="release/v${VERSION}"

# Ensure we're in the app directory
cd "$APP_DIR"

# Ensure __init__.py exists
if [[ ! -f "$INIT_FILE" ]]; then
    echo "Error: $INIT_FILE not found"
    exit 1
fi

# Read current version
CURRENT_VERSION=$(python3 -c "
import re
with open('$INIT_FILE') as f:
    match = re.search(r'__version__\s*=\s*[\"'\''](.*?)[\"'\'']', f.read())
    print(match.group(1) if match else 'unknown')
")

echo "Current version: $CURRENT_VERSION"
echo "New version:     $VERSION"
echo "Branch:          $BRANCH_NAME"
echo ""

# Check for uncommitted changes
if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Error: You have uncommitted changes. Commit or stash them first."
    exit 1
fi

# Ensure we're on develop
CURRENT_BRANCH=$(git branch --show-current)
if [[ "$CURRENT_BRANCH" != "develop" ]]; then
    echo "Warning: You are on '$CURRENT_BRANCH', not 'develop'."
    read -rp "Continue anyway? (y/N): " CONFIRM
    if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
        echo "Aborted."
        exit 1
    fi
fi

# Check if branch already exists
if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
    echo "Error: Branch '$BRANCH_NAME' already exists."
    exit 1
fi

# Create release branch
echo "Creating branch '$BRANCH_NAME' from '$CURRENT_BRANCH'..."
git checkout -b "$BRANCH_NAME"

# Bump version in __init__.py
echo "__version__ = \"$VERSION\"" > "$INIT_FILE"

echo "Updated $INIT_FILE:"
cat "$INIT_FILE"
echo ""

# Commit the version bump
git add "$INIT_FILE"
git commit -m "chore(release): bump version to $VERSION"

echo ""
echo "Done! Next steps:"
echo "  1. Push the branch:  git push upstream $BRANCH_NAME"
echo "  2. Open a PR:        $BRANCH_NAME → main"
echo "  3. After merge, back-merge main to develop"
