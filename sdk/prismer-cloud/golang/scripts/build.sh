#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "📦 Building prismer-sdk-go..."

# Tidy modules
echo "🔨 Running go mod tidy..."
go mod tidy

# Vet
echo "🔍 Running go vet..."
go vet ./...

# Build (just verify it compiles)
echo "🔨 Verifying build..."
go build ./...

# Run tests if any
if ls *_test.go 1> /dev/null 2>&1; then
    echo "🧪 Running tests..."
    go test -v ./...
fi

echo ""
echo "✅ Build successful!"
echo ""
echo "Package files:"
ls -la *.go go.mod go.sum 2>/dev/null || true
