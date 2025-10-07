#!/usr/bin/env bash
set -euo pipefail
# Dev script moved here. Outputs encoder to ../../exr\ test/
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SITE_DIR="$ROOT_DIR/../.."
OUT_DIR="$SITE_DIR/exr test"
mkdir -p "$OUT_DIR"
"$SITE_DIR/exr test/build_openexr_wasm.sh"

