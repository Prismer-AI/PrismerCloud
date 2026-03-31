#!/usr/bin/env bash
#
# Install Prismer Evolution skills to the OpenCode skills directory.
#
# Usage:
#   bash install-skills.sh                    # Install to ~/.config/opencode/skills/
#   bash install-skills.sh --project          # Install to .opencode/skills/ (project-level)
#   bash install-skills.sh --claude           # Install to ~/.claude/skills/ (cross-tool)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="$SCRIPT_DIR/../skills"

# Parse destination
case "${1:-}" in
  --project)
    SKILLS_DEST=".opencode/skills"
    ;;
  --claude)
    SKILLS_DEST="$HOME/.claude/skills"
    ;;
  *)
    SKILLS_DEST="$HOME/.config/opencode/skills"
    ;;
esac

echo "[prismer] Installing skills to $SKILLS_DEST"

mkdir -p "$SKILLS_DEST"

for skill_dir in "$SKILLS_SRC"/*/; do
  skill_name=$(basename "$skill_dir")
  dest="$SKILLS_DEST/$skill_name"
  mkdir -p "$dest"
  cp "$skill_dir/SKILL.md" "$dest/SKILL.md"
  echo "  ✓ $skill_name"
done

echo "[prismer] Skills installed. Restart OpenCode to pick them up."
