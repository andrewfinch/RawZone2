# EXR build assets (dev)

This folder is for development-only OpenEXR build scripts and sources.

Runtime encoder artifacts live in `exr/` alongside the site so the worker can import `exr-encoder.js` and fetch `exr-encoder.wasm`.

The provided `build_openexr_wasm.sh` is a placeholder: add your build steps to produce `exr-encoder.js` and `exr-encoder.wasm` and place them in the top-level `exr/` directory.


