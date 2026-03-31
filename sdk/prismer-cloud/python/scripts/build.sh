#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "📦 Building prismer Python SDK..."

# Clean
rm -rf dist build *.egg-info

# Create virtual env if needed
if [ ! -d ".venv" ]; then
    echo "📥 Creating virtual environment..."
    python3 -m venv .venv
fi

# Activate and install build tools
source .venv/bin/activate
pip install --quiet build twine

# Build
echo "🔨 Building package..."
python -m build

# Verify
if [ -f "dist/"*.whl ] && [ -f "dist/"*.tar.gz ]; then
    echo "✅ Build successful!"
    echo ""
    echo "Output files:"
    ls -la dist/
    echo ""
    echo "Package contents (wheel):"
    unzip -l dist/*.whl | head -20
else
    echo "❌ Build failed - missing output files"
    exit 1
fi

deactivate
