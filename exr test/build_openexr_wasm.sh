#!/usr/bin/env bash

set -euo pipefail

# This script builds OpenEXR Core (C API) and a tiny encoder wrapper to WebAssembly
# Produces: exr-encoder.js + exr-encoder.wasm in the same directory

if ! command -v emcmake >/dev/null 2>&1; then
  echo "Emscripten not found. Install emsdk and 'source emsdk_env.sh' first." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK_DIR="$ROOT_DIR/_openexr_build"
OPENEXR_DIR="$WORK_DIR/openexr"
BUILD_DIR="$OPENEXR_DIR/build"

mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

if [ ! -d "$OPENEXR_DIR" ]; then
  git clone --depth=1 https://github.com/AcademySoftwareFoundation/openexr.git
fi

mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# Configure OpenEXR for static Core build (no tools/tests)
emcmake cmake .. \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DOPENEXR_BUILD_TOOLS=OFF \
  -DOPENEXR_BUILD_TESTS=OFF \
  -DOPENEXR_BUILD_EXAMPLES=OFF

emmake make -j$(/usr/sbin/sysctl -n hw.ncpu 2>/dev/null || getconf _NPROCESSORS_ONLN || echo 4)

# Build our wrapper to WASM
cd "$ROOT_DIR"

# Locate built static libraries (versioned names in OpenEXR 4)
CORE_LIB=$(find "$BUILD_DIR" -name 'libOpenEXRCore*.a' | head -n1)
IMATH_LIB=$(find "$BUILD_DIR" -name 'libImath*.a' | head -n1)
OPENJPH_LIB=$(find "$BUILD_DIR" -name 'libopenjph.a' | head -n1)
if [ -z "$CORE_LIB" ] || [ -z "$IMATH_LIB" ]; then
  echo "Could not locate libOpenEXRCore*.a or libImath*.a under $BUILD_DIR" >&2
  exit 2
fi
if [ -z "$OPENJPH_LIB" ]; then
  echo "Could not locate libopenjph.a under $BUILD_DIR (required for HTJ2K)" >&2
  exit 2
fi

INCLUDE_DIR_CORE=$(cd "$OPENEXR_DIR" && pwd)/src/lib/OpenEXRCore

emcc -O3 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s FILESYSTEM=0 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s USE_ZLIB=1 \
  -s EXPORTED_FUNCTIONS='["_encode_exr_dwaa_rgba_half","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","getValue","setValue","HEAPU8","HEAPU16","HEAPF32"]' \
  -I"$INCLUDE_DIR_CORE" \
  -I"$BUILD_DIR/cmake" \
  -I"$BUILD_DIR/_deps/imath-build/config" \
  "$ROOT_DIR/encode_exr_dwaa_rgba_half.c" \
  "$CORE_LIB" \
  "$IMATH_LIB" \
  "$OPENJPH_LIB" \
  -o "$ROOT_DIR/exr-encoder.js"

echo "Built $ROOT_DIR/exr-encoder.js and exr-encoder.wasm"


