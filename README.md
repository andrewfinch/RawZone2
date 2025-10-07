# RAWZONE

Convert RAW photos to ACES and Log formats entirely in your browser. No uploads, works offline.

## What it does
- Batch converts camera RAW files locally using WebAssembly
- Output formats: 16‑bit TIFF, OpenEXR (DWAA, PIZ, ZIPS, Uncompressed)
- Color pipelines:
  - ACES2065‑1 (AP0 Linear)
  - ACEScct (AP1)
  - ARRI LogC4 (AWG4)

## Requirements
- A Chromium‑based browser (Chrome/Edge recommended). The tool uses Web Workers, WASM, and the File System Access API.
- Large files can be memory‑intensive; modern desktop browsers are recommended.

## Run locally
```
npm install
npm start
# open http://localhost:8081/
```

## Privacy & Terms
- Privacy: all processing happens on your device; nothing is uploaded. See `privacy.html`.
- Terms: provided AS IS, without warranties. See `terms.html`.

## Licenses
- Third‑party notices and licenses: `third-party-notices.html`
- LibRaw corresponding source and relinking info: `libraw-corresponding-source/`

## Contributing
Issues and pull requests are welcome.

