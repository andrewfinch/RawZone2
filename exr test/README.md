# EXR DWAA (OpenEXR Core WASM) test

This folder contains build scripts and test harnesses for the EXR encoder used by the main app. The main UI in `index.html` drives EXR encoding; this folder is for development only.

Prereqs
- Emscripten SDK installed and active in your shell (`emcmake`, `emcc`)
- macOS or Linux recommended

Build

```
cd "exr test"
./build_openexr_wasm.sh
```

Outputs `exr-encoder.js` and `exr-encoder.wasm` in this folder.

Usage in app
- The main app dynamically imports the encoder from `exr-test/exr-encoder.js` or `exr%20test/exr-encoder.js` (fallback), and resolves the `.wasm` relative to that module path.
- You do not need to open this page to use EXR; just run the main `index.html`.

Local dev server
```
npm start
# open http://localhost:8081/
```

Notes
- Uses OpenEXR Core C API, DWAA compression, scanline, RGBA HALF channels
- Each encode runs in its own Worker with its own WASM instance
- DWA level ~45 targets ≈4:1; tweak as desired


