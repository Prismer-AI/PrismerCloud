#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "📦 Packing prismer Python SDK..."

# Build first
./scripts/build.sh

source .venv/bin/activate

# Verify package
echo ""
echo "🔍 Checking package..."
twine check dist/*

echo ""
echo "✅ Package ready!"
echo ""
echo "Output files:"
ls -la dist/
echo ""
echo "To publish to PyPI:"
echo "  twine upload dist/*"
echo ""
echo "To publish to TestPyPI first:"
echo "  twine upload --repository testpypi dist/*"
echo ""
echo "To test locally:"
echo "  pip install dist/*.whl"

deactivate
