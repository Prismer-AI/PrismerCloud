#!/bin/bash
# Entropy Audit — Report oversized files, circular deps, and code health
# Usage: bash scripts/audit-entropy.sh

set -euo pipefail

echo "=== Prismer Cloud — Entropy Audit ==="
echo ""

# ── 1. Oversized files (>500 lines) ──────────────────────────
echo "--- Oversized Files (>500 lines) ---"
echo ""
printf "%-8s  %s\n" "LINES" "FILE"
printf "%-8s  %s\n" "-----" "----"

find src/ -name '*.ts' -o -name '*.tsx' | while read f; do
  lines=$(wc -l < "$f")
  if [ "$lines" -gt 500 ]; then
    printf "%-8d  %s\n" "$lines" "$f"
  fi
done | sort -rn

echo ""

# ── 2. Circular dependencies ─────────────────────────────────
echo "--- Circular Dependency Check ---"
npx madge --circular --extensions ts,tsx src/ 2>&1 | tail -3
echo ""

# ── 3. File count per directory ──────────────────────────────
echo "--- File Count by Directory ---"
echo ""
for dir in src/app src/im src/lib src/components src/contexts src/types; do
  if [ -d "$dir" ]; then
    count=$(find "$dir" -name '*.ts' -o -name '*.tsx' | wc -l | tr -d ' ')
    printf "%-30s  %s files\n" "$dir" "$count"
  fi
done
echo ""

echo "=== Audit Complete ==="
