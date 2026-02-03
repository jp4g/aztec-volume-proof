#!/bin/bash
set -e

echo "Copying macOS bb binaries from bun cache..."

# Find the most recent bb.js cache
BB_CACHE=$(find ~/.bun/install/cache/@aztec -name "bb.js@*" -type d 2>/dev/null | sort -r | head -1)

if [ -z "$BB_CACHE" ]; then
  echo "Error: Could not find bb.js in bun cache"
  exit 1
fi

echo "Found bb.js cache at: $BB_CACHE"

# Create target directory
TARGET_DIR="../aztec-packages/barretenberg/ts/build/arm64-macos"
mkdir -p "$TARGET_DIR"

# Copy arm64-macos binaries
if [ -d "$BB_CACHE/build/arm64-macos" ]; then
  cp "$BB_CACHE/build/arm64-macos/"* "$TARGET_DIR/"
  echo "✓ Copied arm64-macos binaries to $TARGET_DIR"
  ls -lh "$TARGET_DIR"

  # Also copy to node_modules if it exists
  NODE_MODULES_BB="node_modules/@aztec/bb.js/build/arm64-macos"
  if [ -d "node_modules/@aztec/bb.js" ]; then
    mkdir -p "$NODE_MODULES_BB"
    cp "$BB_CACHE/build/arm64-macos/"* "$NODE_MODULES_BB/"
    echo "✓ Copied arm64-macos binaries to $NODE_MODULES_BB"
  fi
else
  echo "Error: arm64-macos binaries not found in cache"
  exit 1
fi
