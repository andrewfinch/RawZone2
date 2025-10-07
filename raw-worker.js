/* Web Worker that uses LibRaw-Wasm to produce a 16-bit linear XYZ TIFF */
import LibRawModule from './libraw.js';

let moduleRef = null;

// Lazy EXR encoder module (OpenEXR WASM) loaded on-demand
let exrModulePromise = null;
async function ensureExrModule() {
  if (!exrModulePromise) {
    const tryLoad = async (relPath) => {
      const href = new URL(relPath, import.meta.url).href;
      const mod = await import(href);
      if (mod && typeof mod.default === 'function') {
        return mod.default({ locateFile: (path, base) => new URL(path, base || href).href });
      }
      return mod || {};
    };
    exrModulePromise = tryLoad('./exr/exr-encoder.js');
  }
  return exrModulePromise;
}

function mapExrCompressionToEnum(name) {
  switch ((name || 'DWAA').toUpperCase()) {
    case 'NONE': return 0;
    case 'RLE': return 1;
    case 'ZIPS': return 2;
    case 'ZIP': return 3;
    case 'PIZ': return 4;
    case 'PXR24': return 5;
    case 'B44': return 6;
    case 'B44A': return 7;
    case 'DWAB': return 9;
    case 'DWAA':
    default: return 8;
  }
}

async function encodeEXRFromRGB16(pixelsU16RGB, width, height, exrOptions, pipeline) {
  const Module = await ensureExrModule();
  const includeAlpha = false;
  const dwaLevel = (exrOptions && typeof exrOptions.dwaLevel === 'number') ? exrOptions.dwaLevel : 45;
  const compression = mapExrCompressionToEnum(exrOptions && exrOptions.compression);
  // Color space flags for forward/backward compatibility (ignored by older WASM)
  let use_ap0 = 0, use_ap1 = 0, use_awg4 = 0;
  switch ((pipeline || 'ap0-linear')) {
    case 'acescct': use_ap1 = 1; break;
    case 'arri-logc4': use_awg4 = 1; break;
    default: use_ap0 = 1; break;
  }
  const numPixels = width * height;
  // Expand RGB -> RGBA16 with opaque alpha
  const rgba16 = new Uint16Array(numPixels * 4);
  for (let i = 0, j = 0; i < numPixels; i++, j += 3) {
    const k = i * 4;
    rgba16[k] = pixelsU16RGB[j];
    rgba16[k + 1] = pixelsU16RGB[j + 1];
    rgba16[k + 2] = pixelsU16RGB[j + 2];
    rgba16[k + 3] = 65535;
  }
  // Convert to Float32 [0..1]
  const f32 = new Float32Array(rgba16.length);
  for (let i = 0; i < rgba16.length; i++) {
    f32[i] = rgba16[i] / 65535;
  }
  const pPixels = Module._malloc(f32.byteLength);
  Module.HEAPF32.set(f32, pPixels >>> 2);
  const pSize = Module._malloc(4);
  const ptr = Module._encode_exr_dwaa_rgba_half(
    pPixels,
    width,
    height,
    dwaLevel|0,
    includeAlpha ? 1 : 0,
    compression|0,
    pSize,
    use_ap0|0,
    use_ap1|0,
    use_awg4|0
  );
  const size = Module.getValue(pSize, 'i32') >>> 0;
  let out;
  if (ptr && size > 0) {
    const view = new Uint8Array(Module.HEAPU8.buffer, ptr, size);
    out = new Uint8Array(size);
    out.set(view);
  } else {
    out = null;
  }
  Module._free(pPixels);
  Module._free(pSize);
  if (ptr) Module._free(ptr);
  if (!out) throw new Error('EXR encode failed');
  return out;
}

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

// Math helpers for matrices
function mat3MultiplyVec3(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
  ];
}
function mat3Multiply(a, b) {
  return [
    a[0]*b[0] + a[1]*b[3] + a[2]*b[6], a[0]*b[1] + a[1]*b[4] + a[2]*b[7], a[0]*b[2] + a[1]*b[5] + a[2]*b[8],
    a[3]*b[0] + a[4]*b[3] + a[5]*b[6], a[3]*b[1] + a[4]*b[4] + a[5]*b[7], a[3]*b[2] + a[4]*b[5] + a[5]*b[8],
    a[6]*b[0] + a[7]*b[3] + a[8]*b[6], a[6]*b[1] + a[7]*b[4] + a[8]*b[7], a[6]*b[2] + a[7]*b[5] + a[8]*b[8]
  ];
}
function mat3Inverse(m) {
  const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
  const A = e*i - f*h;
  const B = -(d*i - f*g);
  const C = d*h - e*g;
  const D = -(b*i - c*h);
  const E = a*i - c*g;
  const F = -(a*h - b*g);
  const G = b*f - c*e;
  const H = -(a*f - c*d);
  const I = a*e - b*d;
  const det = a*A + b*B + c*C;
  const invDet = 1 / det;
  return [A*invDet, D*invDet, G*invDet, B*invDet, E*invDet, H*invDet, C*invDet, F*invDet, I*invDet];
}
function xyToXYZ(x, y) {
  const X = x / y;
  const Y = 1;
  const Z = (1 - x - y) / y;
  return [X, Y, Z];
}
function primariesToRgbToXyz(xy, wp) {
  const [xr, yr] = xy.r, [xg, yg] = xy.g, [xb, yb] = xy.b;
  const Pr = xyToXYZ(xr, yr);
  const Pg = xyToXYZ(xg, yg);
  const Pb = xyToXYZ(xb, yb);
  const P = [Pr[0], Pg[0], Pb[0], Pr[1], Pg[1], Pb[1], Pr[2], Pg[2], Pb[2]];
  const Pinv = mat3Inverse(P);
  const W = xyToXYZ(wp[0], wp[1]);
  const S = mat3MultiplyVec3(Pinv, W);
  const M = [
    P[0]*S[0], P[1]*S[1], P[2]*S[2],
    P[3]*S[0], P[4]*S[1], P[5]*S[2],
    P[6]*S[0], P[7]*S[1], P[8]*S[2]
  ];
  return M; // RGB->XYZ
}
function bradfordAdaptMatrix(srcWP, dstWP) {
  const MB = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
  const MBinv = mat3Inverse(MB);
  const XYZs = xyToXYZ(srcWP[0], srcWP[1]);
  const XYZd = xyToXYZ(dstWP[0], dstWP[1]);
  const LMSs = mat3MultiplyVec3(MB, XYZs);
  const LMSd = mat3MultiplyVec3(MB, XYZd);
  const D = [LMSd[0]/LMSs[0], 0, 0, 0, LMSd[1]/LMSs[1], 0, 0, 0, LMSd[2]/LMSs[2]];
  return mat3Multiply(MBinv, mat3Multiply(D, MB));
}

let ap0ToAwg4Matrix = null;
function ensureAp0ToAwg4Matrix() {
  if (ap0ToAwg4Matrix) return ap0ToAwg4Matrix;
  // AP0 primaries and D60 white
  const AP0 = {
    r: [0.7347, 0.2653],
    g: [0.0000, 1.0000],
    b: [0.0001, -0.0770]
  };
  const D60 = [0.32168, 0.33767];
  // AWG4 primaries (provided) and D65 white
  const AWG4 = {
    r: [0.7347, 0.2653],
    g: [0.1424, 0.8576],
    b: [0.0991, -0.0308]
  };
  const D65 = [0.3127, 0.3290];
  const M_ap0_rgb2xyz_d60 = primariesToRgbToXyz(AP0, D60);
  const adapt_d60_to_d65 = bradfordAdaptMatrix(D60, D65);
  const M_awg4_rgb2xyz_d65 = primariesToRgbToXyz(AWG4, D65);
  const M_xyz_to_awg4 = mat3Inverse(M_awg4_rgb2xyz_d65);
  const T = mat3Multiply(M_xyz_to_awg4, mat3Multiply(adapt_d60_to_d65, M_ap0_rgb2xyz_d60));
  ap0ToAwg4Matrix = T;
  return T;
}

let logc4Consts = null;
function ensureLogC4Consts() {
  if (logc4Consts) return logc4Consts;
  const b = (1023 - 95) / 1023;
  const c = 95 / 1023;
  const a = (Math.pow(2, 18) - 16) / 117.45;
  const s = (7 * Math.log(2) * Math.pow(2, (7 - 14 * (c / b)))) / (a * b);
  const t = (Math.pow(2, (14 * (-c / b) + 6)) - 64) / a;
  logc4Consts = { a, b, c, s, t };
  return logc4Consts;
}

// Single-pass: Rec.709 decode -> AP0 to AWG4 -> LogC4 encode (in-place)
function apply709ToAWG4LogC4InPlace(u16) {
  const lut = initBT709DecodeLUT();
  const M = ensureAp0ToAwg4Matrix();
  const inv65535 = 1 / 65535;
  const { a, b, c, s, t } = ensureLogC4Consts();
  for (let i = 0; i < u16.length; i += 3) {
    // 709 decode to linear AP0
    const r = lut[u16[i]] * inv65535;
    const g = lut[u16[i + 1]] * inv65535;
    const bl = lut[u16[i + 2]] * inv65535;
    // AP0 -> AWG4
    const v = mat3MultiplyVec3(M, [r, g, bl]);
    // LogC4 encode per channel
    u16[i] = encodeLogC4ToU16(v[0], a, b, c, s, t);
    u16[i + 1] = encodeLogC4ToU16(v[1], a, b, c, s, t);
    u16[i + 2] = encodeLogC4ToU16(v[2], a, b, c, s, t);
  }
}
function encodeLogC4ToU16(E, a, b, c, s, t) {
  const x = E;
  let y;
  if (x >= t) {
    y = ((Math.log2(a * x + 64) - 6) / 14) * b + c;
  } else {
    y = (x - t) / s;
  }
  if (y < 0) y = 0; else if (y > 1) y = 1;
  return Math.round(y * 65535);
}

async function ensureModule() {
  if (!moduleRef) {
    moduleRef = await LibRawModule({
      locateFile: p => new URL(p, import.meta.url).href
    });
  }
  return moduleRef;
}

self.onmessage = async (e) => {
  try {
    const data = e.data || {};
    if (data.cmd !== 'process') return;
    const bytes = data.bytes; // ArrayBuffer
    const settings = data.settings || {};
    const jobId = data.jobId;

    function progress(stage) {
      try {
        self.postMessage({ jobId, type: 'progress', stage });
      } catch (_) {}
    }

    const mod = await ensureModule();
    const LibRawClass = mod.LibRaw;
    const instance = new LibRawClass();
    // Force linear pipeline: gamma 1.0, preserve color behavior with noAutoScale=false
    const linearSettings = Object.assign({}, settings, {
      noAutoBright: true,
      noAutoScale: false,
      gamm: [1.0, 1.0],
      gamma: [1.0, 1.0]
    });
    progress('opening');
    await instance.open(new Uint8Array(bytes), linearSettings);

    // imageData is an interleaved 3-channel buffer in requested color space
    progress('decoding');
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
    progress('dimensions');

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
      // Copy off the WASM heap to avoid aliasing across jobs
      pixelsU16 = new Uint16Array(pixelsView);
    } else {
      const u8 = pixelsView instanceof Uint8Array ? pixelsView : new Uint8Array(pixelsView.buffer, pixelsView.byteOffset, pixelsView.byteLength);
      const expected16ByteLen = width * height * 3 * 2;
      const expected8ByteLen = width * height * 3;
      if (u8.length === expected16ByteLen) {
        const n = u8.length >>> 1;
        const tmp = new Uint16Array(n);
        for (let i = 0, j = 0; i < n; i++, j += 2) {
          tmp[i] = u8[j] | (u8[j + 1] << 8);
        }
        pixelsU16 = tmp;
      } else if (u8.length === expected8ByteLen) {
        throw new Error('Decoder returned 8-bit data; 16-bit required');
      } else {
        throw new Error('Unexpected imageData byte length');
      }
    }
    progress('pixels-prepared');

    // Select pipeline
    const pipeline = data.pipeline || 'ap0-linear';
    if (pipeline === 'acescct') {
      // 709->linear->AP1->ACEScct single-pass
      apply709ToACEScctInPlace(pixelsU16);
    } else if (pipeline === 'arri-logc4') {
      // 709->linear->AWG4->LogC4 single-pass
      apply709ToAWG4LogC4InPlace(pixelsU16);
    } else {
      // AP0 Linear: just decode Rec.709 to linear
      applyBT709DecodeInPlace(pixelsU16);
    }
    progress('transformed');
    // Encode based on requested format
    const format = (data && data.format) || 'tiff';
    let outBytes;
    if (format === 'exr') {
      const exrOptions = (data && data.exrOptions) || {};
      const exrBytes = await encodeEXRFromRGB16(pixelsU16, width, height, exrOptions, pipeline);
      outBytes = exrBytes;
      progress('encoded');
    } else {
      const spp = 3;
      const bits = [16, 16, 16];
      const sampleFormat = [1, 1, 1];
      // Colorimetry tags
      const colorInfo = getColorimetryForPipeline(pipeline);
      const imageDesc = colorInfo.description;
      const tiffBytes = encodeTiff16leWithColorimetry(width, height, spp, bits, sampleFormat, pixelsU16, colorInfo.whitePoint, colorInfo.primaries, imageDesc);
      outBytes = tiffBytes;
      progress('encoded');
    }

    // Best-effort cleanup of native resources
    try { instance.close && instance.close(); } catch (_) {}
    try { instance.recycle && instance.recycle(); } catch (_) {}
    try { instance.delete && instance.delete(); } catch (_) {}

    if (outBytes instanceof Uint8Array) {
      self.postMessage({ jobId, type: 'result', out: outBytes }, [outBytes.buffer]);
    } else {
      self.postMessage({ jobId, type: 'result', out: outBytes });
    }
  } catch (err) {
    try {
      const jobId = (e && e.data && e.data.jobId) || undefined;
      self.postMessage({ jobId, type: 'error', error: err && err.message ? err.message : String(err) });
    } catch (_) {
      self.postMessage({ type: 'error', error: err && err.message ? err.message : String(err) });
    }
  }
};

// (encodeTiff16le removed as unused; keep encodeTiff16leWithColorimetry only)

// Extended TIFF encoder adding WhitePoint (318), PrimaryChromaticities (319) and ImageDescription (270)
function encodeTiff16leWithColorimetry(width, height, samplesPerPixel, bitsPerSampleArr, sampleFormatArr, pixelsU16, whitePoint, primaries, imageDescription) {
  const numPixels = width * height;
  const bytesPerSample = 2;
  const imageBytes = numPixels * samplesPerPixel * bytesPerSample;

  const headerBytes = 8; // TIFF header
  const pixelDataOffset = headerBytes;

  // We'll place BitsPerSample (SHORT[3]) and SampleFormat (SHORT[3]) arrays, then
  // RATIONAL arrays for WhitePoint (2) and PrimaryChromaticities (6), and finally the ASCII description.
  const bpsOffset = pixelDataOffset + imageBytes; // SHORT[3]
  const sfOffset = bpsOffset + bitsPerSampleArr.length * 2; // SHORT[3]

  const TYPE_SHORT = 3;
  const TYPE_LONG = 4;
  const TYPE_RATIONAL = 5;
  const TYPE_ASCII = 2;

  // RATIONAL arrays are pairs of 32-bit numerators/denominators
  const whitePointCount = 2; // Wx, Wy
  const primariesCount = 6; // Rx,Ry,Gx,Gy,Bx,By
  const rationalBytes = 8; // 2x uint32 per rational

  const wpOffset = sfOffset + sampleFormatArr.length * 2; // after SHORT arrays
  const pcOffset = wpOffset + whitePointCount * rationalBytes;

  const descStr = (imageDescription || '').toString();
  const descByteLen = descStr.length + 1; // include NUL terminator
  const descOffset = pcOffset + primariesCount * rationalBytes;

  // IFD entries
  const extraEntries = 3; // WhitePoint, PrimaryChromaticities, ImageDescription
  const ifdEntryCount = 12 + extraEntries;
  const ifdBytes = 2 + ifdEntryCount * 12 + 4;
  const ifdOffset = descOffset + descByteLen;

  const totalBytes = ifdOffset + ifdBytes;
  const buf = new ArrayBuffer(totalBytes);
  const dv = new DataView(buf);

  // Header: II 42 firstIFD
  let off = 0;
  dv.setUint8(off++, 0x49); dv.setUint8(off++, 0x49);
  dv.setUint16(off, 42, true); off += 2;
  dv.setUint32(off, ifdOffset, true); off += 4;

  // Pixel data
  let p = pixelDataOffset;
  for (let i = 0; i < pixelsU16.length; i++) {
    dv.setUint16(p, pixelsU16[i], true);
    p += 2;
  }

  // BitsPerSample array
  for (let i = 0; i < bitsPerSampleArr.length; i++) dv.setUint16(bpsOffset + i * 2, bitsPerSampleArr[i], true);
  // SampleFormat array (1=unsigned)
  for (let i = 0; i < sampleFormatArr.length; i++) dv.setUint16(sfOffset + i * 2, sampleFormatArr[i], true);

  // Helper to write RATIONAL at offset
  function writeRationalPair(baseOffset, index, num, den) {
    const o = baseOffset + index * rationalBytes;
    dv.setUint32(o, num >>> 0, true);
    dv.setUint32(o + 4, den >>> 0, true);
  }
  function toRational(x) {
    const den = 1000000;
    const num = Math.round((x || 0) * den);
    return [num, den];
  }
  // WhitePoint Wx, Wy
  if (whitePoint && whitePoint.length === 2) {
    const [wxn, wxd] = toRational(whitePoint[0]);
    const [wyn, wyd] = toRational(whitePoint[1]);
    writeRationalPair(wpOffset, 0, wxn, wxd);
    writeRationalPair(wpOffset, 1, wyn, wyd);
  } else {
    writeRationalPair(wpOffset, 0, 312700, 1000000); // D65 default
    writeRationalPair(wpOffset, 1, 329000, 1000000);
  }
  // PrimaryChromaticities Rx,Ry,Gx,Gy,Bx,By
  const pr = (primaries && primaries.r) || [0.64, 0.33];
  const pg = (primaries && primaries.g) || [0.3, 0.6];
  const pb = (primaries && primaries.b) || [0.15, 0.06];
  const vals = [pr[0], pr[1], pg[0], pg[1], pb[0], pb[1]];
  for (let i = 0; i < 6; i++) {
    const [n, d] = toRational(vals[i]);
    writeRationalPair(pcOffset, i, n, d);
  }

  // ImageDescription ASCII + NUL
  for (let i = 0; i < descStr.length; i++) dv.setUint8(descOffset + i, descStr.charCodeAt(i) & 0xff);
  dv.setUint8(descOffset + descStr.length, 0);

  // IFD entries
  let io = ifdOffset;
  dv.setUint16(io, ifdEntryCount, true); io += 2;
  function entry(tag, type, count, valueOrOffset) {
    dv.setUint16(io, tag, true); io += 2;
    dv.setUint16(io, type, true); io += 2;
    dv.setUint32(io, count >>> 0, true); io += 4;
    dv.setUint32(io, valueOrOffset >>> 0, true); io += 4;
  }

  const stripOffset = pixelDataOffset;
  const stripByteCount = imageBytes;

  entry(256, TYPE_LONG, 1, width);                // ImageWidth
  entry(257, TYPE_LONG, 1, height);               // ImageLength
  entry(258, TYPE_SHORT, bitsPerSampleArr.length, bpsOffset); // BitsPerSample
  entry(259, TYPE_SHORT, 1, 1);                   // Compression = None
  entry(262, TYPE_SHORT, 1, 2);                   // Photometric = RGB
  entry(273, TYPE_LONG, 1, stripOffset);          // StripOffsets
  entry(277, TYPE_SHORT, 1, samplesPerPixel);     // SamplesPerPixel
  entry(278, TYPE_LONG, 1, height);               // RowsPerStrip
  entry(279, TYPE_LONG, 1, stripByteCount);       // StripByteCounts
  entry(284, TYPE_SHORT, 1, 1);                   // PlanarConfiguration = Chunky
  entry(339, TYPE_SHORT, sampleFormatArr.length, sfOffset); // SampleFormat
  entry(274, TYPE_SHORT, 1, 1);                   // Orientation = Top-left
  entry(318, TYPE_RATIONAL, 2, wpOffset);         // WhitePoint
  entry(319, TYPE_RATIONAL, 6, pcOffset);         // PrimaryChromaticities
  entry(270, TYPE_ASCII, descByteLen, descOffset);// ImageDescription

  // next IFD = 0
  dv.setUint32(io, 0, true); io += 4;

  return new Uint8Array(buf);
}

function getColorimetryForPipeline(pipeline) {
  const p = (pipeline || 'ap0-linear');
  if (p === 'acescct') {
    // ACES AP1 primaries, D60 white
    return {
      whitePoint: [0.32168, 0.33767],
      primaries: { r: [0.713, 0.293], g: [0.165, 0.830], b: [0.128, 0.044] },
      description: 'ACEScct (AP1)'
    };
  } else if (p === 'arri-logc4') {
    // ARRI Wide Gamut 4 primaries, D65 white
    return {
      whitePoint: [0.3127, 0.3290],
      primaries: { r: [0.7347, 0.2653], g: [0.1424, 0.8576], b: [0.0991, -0.0308] },
      description: 'ARRI LogC4 (AWG4)'
    };
  }
  // Default: ACES AP0, D60 white
  return {
    whitePoint: [0.32168, 0.33767],
    primaries: { r: [0.7347, 0.2653], g: [0.0000, 1.0000], b: [0.0001, -0.0770] },
    description: 'ACES2065-1 (AP0 Linear)'
  };
}


