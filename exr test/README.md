EXR DWAA (OpenEXR Core WASM) minimal test

This folder builds OpenEXR Core (C API) to WebAssembly and encodes uncompressed 16-bit RGBA TIFF into OpenEXR with DWAA compression, entirely in Chrome.

Prereqs
- Emscripten SDK installed and active in your shell (`emcmake`, `emcc` available)
- macOS or Linux recommended

Build

```
cd "exr test"
./build_openexr_wasm.sh
```

Outputs `exr-encoder.js` and `exr-encoder.wasm` in this folder.

Run

Use the existing local server from the project root (it sets COOP/COEP headers):

```
npm start
# then open http://localhost:8081/exr%20test/index.html
```

Choose an uncompressed 16-bit RGBA TIFF (8K), set DWA level (default 45), click Convert.

Result downloads as `output_dwaa.exr`.

Notes
- Uses OpenEXR Core C API, DWAA compression, scanline, RGBA HALF channels
- Each encode runs in its own Worker with its own WASM instance
- DWA level ~45 targets ≈4:1; tweak as desired
- The bundled TIFF reader is minimal: only uncompressed little-endian contiguous RGBA/RGB 16-bit


