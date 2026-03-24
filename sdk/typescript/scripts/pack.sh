#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "📦 Packing @prismer/sdk..."

# Build first
./scripts/build.sh

# Create tarball
echo "📋 Creating package tarball..."
npm pack

# Show result
TARBALL=$(ls -t *.tgz | head -1)
echo ""
echo "✅ Package created: $TARBALL"
echo ""
echo "Contents:"
tar -tzf "$TARBALL" | head -20
echo ""
echo "To publish:"
echo "  npm publish $TARBALL"
echo ""
echo "To test locally:"
echo "  npm install ./$TARBALL"
