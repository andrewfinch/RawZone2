# RAWZONE

Convert RAW photos to ACES and Log formats locally in Chrome. No uploads.

## Run locally

```
npm install
npm start
# open http://localhost:8081/
```

## Build notes
- WASM modules load with URL-relative paths to support GitHub Pages.
- EXR encoder artifacts live under `exr test/` and are dynamically imported by `raw-worker.js`.
- If you rebuild the EXR encoder, run the build script inside `exr test/`.

## EXR encoder (optional, dev-only)

```
cd "exr test"
./build_openexr_wasm.sh
```

## Icons
- Favicons are in `favicon_io/` and wired in `index.html`.

