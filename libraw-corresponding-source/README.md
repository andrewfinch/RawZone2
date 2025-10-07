# LibRaw Corresponding Source and Relinking Info

This site uses a WebAssembly build of LibRaw. To comply with LGPL-2.1/CDDL, you may obtain, modify, and relink the library.

What this folder contains
- Pointers to the exact sources or archives used, or instructions to request them.
- Relinking instructions.

Sources
- Upstream LibRaw: https://www.libraw.org/
- WASM wrapper used: https://www.npmjs.com/package/libraw-wasm
- If you need the exact source bundle (LibRaw version and wrapper scripts) matching this deployment, contact the maintainer via the repository. We will provide it or add it here.

Relinking
1. Build LibRaw for WebAssembly using Emscripten (or use libraw-wasm build scripts).
2. Produce compatible `libraw.wasm` and `libraw.js` (or equivalent glue module with the same exported API used by this app).
3. Replace the deployed artifacts in this site (e.g., `libraw.wasm` and `libraw.js`) with your rebuilt versions. Ensure paths and module names remain the same.
4. Reload the page; your modified library will be used.

Notes
- This app does not require server-side processing.
- If you distribute a modified build, ensure you comply with all applicable licenses and include updated notices.


