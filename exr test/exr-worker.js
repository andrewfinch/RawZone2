// Web Worker that loads exr-encoder.js (WASM) and encodes RGBA HALF to EXR DWAA

let modulePromise = null;

function initModule() {
  if (!modulePromise) {
    modulePromise = import('./exr-encoder.js').then(mod => mod.default ? mod.default() : mod());
  }
  return modulePromise;
}

// Convert Uint16 RGBA to Float32 linear [0..1] for EXR encoder (which converts to HALF)
async function encodeRGBA16ToEXR(pixelsU16, width, height, dwaLevel, includeAlpha, compression) {
  const Module = await initModule();

  const numElems = pixelsU16.length;
  const f32 = new Float32Array(numElems);
  for (let i = 0; i < numElems; i++) {
    f32[i] = pixelsU16[i] / 65535;
  }
  const pPixels = Module._malloc(f32.byteLength);
  Module.HEAPF32.set(f32, pPixels >>> 2);

  const pSize = Module._malloc(4); // wasm32 size_t = 4 bytes

  const ptr = Module._encode_exr_dwaa_rgba_half(pPixels, width, height, dwaLevel, includeAlpha ? 1 : 0, compression|0, pSize);

  const size = Module.getValue(pSize, 'i32') >>> 0;

  let out;
  if (ptr && size > 0) {
    const view = new Uint8Array(Module.HEAPU8.buffer, ptr, size);
    // Copy to a new ArrayBuffer we can transfer
    out = new Uint8Array(size);
    out.set(view);
  } else {
    out = null;
  }

  Module._free(pPixels);
  Module._free(pSize);
  if (ptr) Module._free(ptr);

  if (!out) throw new Error('EXR encode failed');
  return out.buffer;
}

self.onmessage = async (e) => {
  const { cmd } = e.data || {};
  if (cmd === 'encode') {
    const { rgba16, width, height, dwaLevel = 45, compression = 8 } = e.data;
    try {
      const buffer = await encodeRGBA16ToEXR(new Uint16Array(rgba16), width, height, dwaLevel, false, compression);
      self.postMessage({ type: 'result', buffer }, [buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', error: (err && err.message) || String(err) });
    }
  }
};


