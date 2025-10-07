#!/usr/bin/env bash
set -euo pipefail
# Dev script moved here. Outputs encoder to ../../exr/
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SITE_DIR="$ROOT_DIR/../.."
OUT_DIR="$SITE_DIR/exr"
mkdir -p "$OUT_DIR"
echo "This is a dev placeholder. Provide your OpenEXR build steps here to output exr-encoder.js and exr-encoder.wasm into: $OUT_DIR" >&2
exit 1

