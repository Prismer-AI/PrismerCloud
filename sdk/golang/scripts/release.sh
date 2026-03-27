#!/bin/bash
set -e

cd "$(dirname "$0")/.."

VERSION=${1:-"v0.1.0"}

echo "📦 Preparing prismer Go SDK release $VERSION..."

# Build first
./scripts/build.sh

echo ""
echo "✅ Package ready for release!"
echo ""
echo "Go modules are distributed via git tags."
echo ""
echo "To release $VERSION:"
echo ""
echo "1. Commit all changes:"
echo "   git add -A && git commit -m 'Release sdk/golang/$VERSION'"
echo ""
echo "2. Tag the release (monorepo subdirectory tag format):"
echo "   git tag sdk/golang/$VERSION"
echo ""
echo "3. Push to GitHub:"
echo "   git push origin main --tags"
echo ""
echo "4. Users can then install:"
echo "   go get github.com/Prismer-AI/Prismer/sdk/golang@sdk/golang/$VERSION"
echo ""
echo "Note: Make sure the GitHub repo is public and the module path"
echo "in go.mod matches: github.com/Prismer-AI/Prismer/sdk/golang"
