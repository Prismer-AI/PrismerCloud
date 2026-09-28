#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "📦 Building @prismer/sdk..."

# Clean
rm -rf dist

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "📥 Installing dependencies..."
    npm install
fi

# Build with tsup
echo "🔨 Compiling TypeScript..."
npx tsup src/index.ts --format cjs,esm --dts --clean

# Verify output
if [ -f "dist/index.js" ] && [ -f "dist/index.mjs" ] && [ -f "dist/index.d.ts" ]; then
    echo "✅ Build successful!"
    echo ""
    echo "Output files:"
    ls -la dist/
    echo ""
    echo "Package size:"
    du -sh dist/
else
    echo "❌ Build failed - missing output files"
    exit 1
fi
