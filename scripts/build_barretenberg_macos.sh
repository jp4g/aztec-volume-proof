#!/bin/bash
set -e

echo "Building barretenberg for macOS (arm64)..."

cd ../aztec-packages/barretenberg/cpp

# Clean previous build
rm -rf build

# Build for macOS
./bootstrap.sh build_preset clang20 --target bb --target nodejs_module

echo "Copying native binaries..."
cd ../ts

# Copy to the expected location
./scripts/copy_native.sh

echo "✓ Barretenberg built successfully for macOS"
echo "Binaries location: ../aztec-packages/barretenberg/ts/build/arm64-macos/"
