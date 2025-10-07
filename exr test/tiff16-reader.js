// Minimal uncompressed little-endian TIFF reader to extract RGBA16 pixels
// Supports baseline TIFF with 16-bit per channel RGBA, PlanarConfiguration=Contig

export async function readTIFFRGBA16(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  // Endianness detection
  const byteOrder = String.fromCharCode(dv.getUint8(0)) + String.fromCharCode(dv.getUint8(1));
  const le = (byteOrder === 'II');
  const magic = le ? dv.getUint16(2, true) : dv.getUint16(2, false);
  if (magic !== 42) throw new Error('Not a TIFF file');
  const ifdOffset = le ? dv.getUint32(4, true) : dv.getUint32(4, false);
  const numDir = le ? dv.getUint16(ifdOffset, true) : dv.getUint16(ifdOffset, false);
  let width = 0, height = 0, bitsPerSample = 0, samplesPerPixel = 0, photometric = 0, compression = 1, planar = 1;
  let stripOffsets = null, rowsPerStrip = 0, stripByteCounts = null;
  for (let i = 0; i < numDir; i++) {
    const off = ifdOffset + 2 + i * 12;
    const tag = le ? dv.getUint16(off, true) : dv.getUint16(off, false);
    const type = le ? dv.getUint16(off + 2, true) : dv.getUint16(off + 2, false);
    const count = le ? dv.getUint32(off + 4, true) : dv.getUint32(off + 4, false);
    const valOff = off + 8;
    const read32 = (p) => (le ? dv.getUint32(p, true) : dv.getUint32(p, false));
    const read16 = (p) => (le ? dv.getUint16(p, true) : dv.getUint16(p, false));
    switch (tag) {
      case 256: // ImageWidth
        width = (type === 3) ? read16(valOff) : read32(valOff);
        break;
      case 257: // ImageLength
        height = (type === 3) ? read16(valOff) : read32(valOff);
        break;
      case 258: // BitsPerSample (assume all same)
        if (count === 1) {
          bitsPerSample = (type === 3) ? read16(valOff) : read32(valOff);
        } else {
          // Value is an offset to SHORT[count]
          const arrOff = read32(valOff);
          let ok = true;
          for (let k = 0; k < count; k++) {
            const bps = le ? dv.getUint16(arrOff + 2 * k, true) : dv.getUint16(arrOff + 2 * k, false);
            if (k === 0) bitsPerSample = bps;
            else if (bps !== bitsPerSample) ok = false;
          }
          if (!ok) throw new Error('Mixed BitsPerSample not supported');
        }
        break;
      case 262: // PhotometricInterpretation
        photometric = (type === 3) ? read16(valOff) : read32(valOff);
        break;
      case 259: // Compression
        compression = (type === 3) ? read16(valOff) : read32(valOff);
        break;
      case 277: // SamplesPerPixel
        samplesPerPixel = (type === 3) ? read16(valOff) : read32(valOff);
        break;
      case 284: // PlanarConfiguration (1 = contiguous)
        planar = (type === 3) ? read16(valOff) : read32(valOff);
        break;
      case 273: // StripOffsets
        if (count === 1) {
          stripOffsets = [ read32(valOff) ];
        } else {
          const arrOff = read32(valOff);
          stripOffsets = new Array(count);
          for (let k = 0; k < count; k++) stripOffsets[k] = le ? dv.getUint32(arrOff + 4 * k, true) : dv.getUint32(arrOff + 4 * k, false);
        }
        break;
      case 278: // RowsPerStrip
        rowsPerStrip = (type === 3) ? read16(valOff) : read32(valOff);
        break;
      case 279: // StripByteCounts
        if (count === 1) {
          stripByteCounts = [ read32(valOff) ];
        } else {
          const arrOff = read32(valOff);
          stripByteCounts = new Array(count);
          for (let k = 0; k < count; k++) stripByteCounts[k] = le ? dv.getUint32(arrOff + 4 * k, true) : dv.getUint32(arrOff + 4 * k, false);
        }
        break;
      default:
        break;
    }
  }
  if (compression !== 1) throw new Error('Only uncompressed TIFF supported');
  if (planar !== 1) throw new Error('Only contiguous planar TIFF supported');
  if (bitsPerSample !== 16) throw new Error('Only 16-bit Samples supported');
  if (samplesPerPixel !== 4 && samplesPerPixel !== 3) throw new Error('Expected RGB or RGBA');

  const numPixels = width * height;
  const out = new Uint16Array(numPixels * 4);
  // Concatenate strips
  const offsets = stripOffsets || [];
  const counts = stripByteCounts || [];
  let writePos = 0;
  for (let s = 0; s < offsets.length; s++) {
    const off = offsets[s];
    const bytes = counts[s];
    const src = new Uint16Array(arrayBuffer, off, bytes >>> 1);
    out.set(src, writePos);
    writePos += src.length;
  }
  if (samplesPerPixel === 3) {
    // Expand RGB to RGBA = 4 channels
    const rgb = out.slice(0, numPixels * 3);
    for (let i = numPixels - 1; i >= 0; i--) {
      const r = rgb[i * 3 + 0];
      const g = rgb[i * 3 + 1];
      const b = rgb[i * 3 + 2];
      const k = i * 4;
      out[k + 3] = 65535;
      out[k + 2] = b;
      out[k + 1] = g;
      out[k + 0] = r;
    }
  }
  return { width, height, rgba16: out };
}


