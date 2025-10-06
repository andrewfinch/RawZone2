/* Web Worker that uses LibRaw-Wasm to produce a 16-bit linear XYZ TIFF */
import LibRawModule from './libraw.js';

let moduleRef = null;
let lib = null;

// One-time 16-bit LUT to decode Rec.709 transfer to linear
let bt709DecodeLUT = null;
function initBT709DecodeLUT() {
  if (bt709DecodeLUT) return bt709DecodeLUT;
  const lut = new Uint16Array(65536);
  for (let v = 0; v < 65536; v++) {
    const e = v / 65535;
    let l;
    if (e <= 0.081) {
      l = e / 4.5;
    } else {
      l = Math.pow((e + 0.099) / 1.099, 1 / 0.45);
    }
    if (l < 0) l = 0;
    else if (l > 1) l = 1;
    lut[v] = Math.round(l * 65535);
  }
  bt709DecodeLUT = lut;
  return lut;
}

function applyBT709DecodeInPlace(u16) {
  const lut = initBT709DecodeLUT();
  for (let i = 0; i < u16.length; i++) {
    u16[i] = lut[u16[i]];
  }
}

// Single-pass: Rec.709 decode -> AP0 to AP1 -> ACEScct encode (in-place)
function apply709ToACEScctInPlace(u16) {
  const lut = initBT709DecodeLUT();
  // AP0 -> AP1 (ACEScg) matrix
  const m00 = 1.4514393161, m01 = -0.2365107469, m02 = -0.2149285693;
  const m10 = -0.0765537733, m11 = 1.1762296998, m12 = -0.0996759265;
  const m20 = 0.0083161484, m21 = -0.0060324498, m22 = 0.9977163014;
  // ACEScct constants
  const cut = 0.0078125; // 2^-7
  const a = 10.5402377416545;
  const b = 0.0729055341958355;
  for (let i = 0; i < u16.length; i += 3) {
    // 709 decode to linear AP0
    let r = lut[u16[i]] / 65535;
    let g = lut[u16[i + 1]] / 65535;
    let bch = lut[u16[i + 2]] / 65535;
    // AP0 -> AP1
    const rr = m00 * r + m01 * g + m02 * bch;
    const gg = m10 * r + m11 * g + m12 * bch;
    const bb = m20 * r + m21 * g + m22 * bch;
    // Encode ACEScct per channel
    u16[i] = encodeCctToU16(rr);
    u16[i + 1] = encodeCctToU16(gg);
    u16[i + 2] = encodeCctToU16(bb);
  }
  function encodeCctToU16(x) {
    let y;
    if (x <= cut) y = a * x + b;
    else y = (Math.log2(Math.max(x, 1e-10)) + 9.72) / 17.52;
    if (y < 0) y = 0; else if (y > 1) y = 1;
    return Math.round(y * 65535);
  }
}

async function ensureLib() {
  if (lib) return lib;
  if (!moduleRef) {
    moduleRef = await LibRawModule({
      locateFile: p => (p.endsWith('.wasm') ? './libraw.wasm' : p)
    });
  }
  const LibRawClass = moduleRef.LibRaw;
  lib = new LibRawClass();
  return lib;
}

self.onmessage = async (e) => {
  try {
    const data = e.data || {};
    if (data.cmd !== 'process') return;
    const bytes = data.bytes; // ArrayBuffer
    const settings = data.settings || {};

    const instance = await ensureLib();
    // Force linear pipeline: gamma 1.0, preserve color behavior with noAutoScale=false
    const linearSettings = Object.assign({}, settings, {
      noAutoBright: true,
      noAutoScale: false,
      gamm: [1.0, 1.0],
      gamma: [1.0, 1.0]
    });
    await instance.open(new Uint8Array(bytes), linearSettings);

    // imageData is an interleaved 3-channel buffer in requested color space
    const img = await instance.imageData();

    // Dimensions: prefer imageData's own fields, then metadata as fallback
    let width = (img && (img.width || (img.sizes && img.sizes.width))) || 0;
    let height = (img && (img.height || (img.sizes && img.sizes.height))) || 0;
    if (!width || !height) {
      let meta = null;
      try {
        const maybe = instance.metadata?.(true);
        meta = (maybe && typeof maybe.then === 'function') ? await maybe : maybe;
      } catch (_) {
        meta = null;
      }
      width = (meta && (meta.width || (meta.sizes && meta.sizes.width))) || width;
      height = (meta && (meta.height || (meta.sizes && meta.sizes.height))) || height;
    }
    if (!width || !height) throw new Error('Missing dimensions');

    // Normalize pixel data view
    let pixelsView = null;
    if (img instanceof Uint8Array || img instanceof Uint16Array) {
      pixelsView = img;
    } else if (img && typeof img === 'object') {
      const dataBuf = img.data || img.buffer || img.bytes;
      if (dataBuf instanceof Uint8Array || dataBuf instanceof Uint16Array) {
        pixelsView = dataBuf;
      } else if (dataBuf instanceof ArrayBuffer) {
        pixelsView = new Uint8Array(dataBuf);
      }
    } else if (img instanceof ArrayBuffer) {
      pixelsView = new Uint8Array(img);
    }
    if (!pixelsView) throw new Error('Unexpected imageData type');

    // Enforce true 16-bit output (no 8→16 promotion). Expect width*height*3*2 bytes.
    let pixelsU16;
    if (pixelsView instanceof Uint16Array) {
      if (pixelsView.length !== width * height * 3) {
        throw new Error('Unexpected data length for 16-bit image');
      }
      pixelsU16 = pixelsView;
    } else {
      const u8 = pixelsView instanceof Uint8Array ? pixelsView : new Uint8Array(pixelsView.buffer, pixelsView.byteOffset, pixelsView.byteLength);
      const expected16ByteLen = width * height * 3 * 2;
      const expected8ByteLen = width * height * 3;
      if (u8.length === expected16ByteLen) {
        const n = u8.length >>> 1;
        pixelsU16 = new Uint16Array(n);
        for (let i = 0, j = 0; i < n; i++, j += 2) {
          pixelsU16[i] = u8[j] | (u8[j + 1] << 8);
        }
      } else if (u8.length === expected8ByteLen) {
        throw new Error('Decoder returned 8-bit data; 16-bit required');
      } else {
        throw new Error('Unexpected imageData byte length');
      }
    }

    // Select pipeline
    const pipeline = data.pipeline || 'ap0-linear';
    if (pipeline === 'acescct') {
      // 709->linear->AP1->ACEScct single-pass
      apply709ToACEScctInPlace(pixelsU16);
    } else {
      // AP0 Linear: just decode Rec.709 to linear
      applyBT709DecodeInPlace(pixelsU16);
    }

    // Encode baseline uncompressed TIFF, 3 samples, 16-bit unsigned, chunky
    const spp = 3;
    const bits = [16, 16, 16];
    const sampleFormat = [1, 1, 1];
    const tiffBytes = encodeTiff16le(width, height, spp, bits, sampleFormat, pixelsU16);

    self.postMessage({ out: tiffBytes }, [tiffBytes.buffer]);
  } catch (err) {
    self.postMessage({ error: err && err.message ? err.message : String(err) });
  }
};

// Minimal TIFF encoder (little-endian), one strip, 3x16-bit chunky
function encodeTiff16le(width, height, samplesPerPixel, bitsPerSampleArr, sampleFormatArr, pixelsU16) {
  const numPixels = width * height;
  const bytesPerSample = 2;
  const imageBytes = numPixels * samplesPerPixel * bytesPerSample;

  const headerBytes = 8; // TIFF header
  const bpsOffset = headerBytes + imageBytes; // SHORT[3]
  const sfOffset = bpsOffset + bitsPerSampleArr.length * 2; // SHORT[3]

  const ifdEntryCount = 12;
  const ifdBytes = 2 + ifdEntryCount * 12 + 4;
  const ifdOffset = sfOffset + sampleFormatArr.length * 2;

  const totalBytes = ifdOffset + ifdBytes;
  const buf = new ArrayBuffer(totalBytes);
  const dv = new DataView(buf);
  let off = 0;

  // Header: II 42 firstIFD
  dv.setUint8(off++, 0x49); dv.setUint8(off++, 0x49);
  dv.setUint16(off, 42, true); off += 2;
  dv.setUint32(off, ifdOffset, true); off += 4;

  // Pixel data (little-endian)
  let p = headerBytes;
  for (let i = 0; i < pixelsU16.length; i++) {
    dv.setUint16(p, pixelsU16[i], true);
    p += 2;
  }

  // BitsPerSample array
  for (let i = 0; i < bitsPerSampleArr.length; i++) {
    dv.setUint16(bpsOffset + i * 2, bitsPerSampleArr[i], true);
  }
  // SampleFormat array (1=unsigned)
  for (let i = 0; i < sampleFormatArr.length; i++) {
    dv.setUint16(sfOffset + i * 2, sampleFormatArr[i], true);
  }

  // IFD entries
  let io = ifdOffset;
  dv.setUint16(io, ifdEntryCount, true); io += 2;

  function entry(tag, type, count, valueOrOffset) {
    dv.setUint16(io, tag, true); io += 2;
    dv.setUint16(io, type, true); io += 2;
    dv.setUint32(io, count, true); io += 4;
    dv.setUint32(io, valueOrOffset, true); io += 4;
  }

  const TYPE_SHORT = 3;
  const TYPE_LONG = 4;

  const stripOffset = headerBytes;
  const stripByteCount = imageBytes;

  entry(256, TYPE_LONG, 1, width);               // ImageWidth
  entry(257, TYPE_LONG, 1, height);              // ImageLength
  entry(258, TYPE_SHORT, bitsPerSampleArr.length, bpsOffset); // BitsPerSample
  entry(259, TYPE_SHORT, 1, 1);                  // Compression = None
  entry(262, TYPE_SHORT, 1, 2);                  // Photometric = RGB (we store XYZ as 3 samples)
  entry(273, TYPE_LONG, 1, stripOffset);         // StripOffsets
  entry(277, TYPE_SHORT, 1, samplesPerPixel);    // SamplesPerPixel
  entry(278, TYPE_LONG, 1, height);              // RowsPerStrip
  entry(279, TYPE_LONG, 1, stripByteCount);      // StripByteCounts
  entry(284, TYPE_SHORT, 1, 1);                  // PlanarConfiguration = Chunky
  entry(339, TYPE_SHORT, sampleFormatArr.length, sfOffset); // SampleFormat
  entry(274, TYPE_SHORT, 1, 1);                  // Orientation = Top-left

  // next IFD = 0
  dv.setUint32(io, 0, true); io += 4;

  return new Uint8Array(buf);
}


