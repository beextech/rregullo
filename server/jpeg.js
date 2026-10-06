// Reads the width and height of a JPEG from its header, without decoding it.
// Runs unchanged in Cloudflare Workers and Node; no dependencies. Built for untrusted uploads:
// it never throws, never reads past the end, and stops after a fixed number of segments.

const MAX_SEGMENTS = 1000;

// SOFn markers carry the frame size. C4 (DHT), C8 (JPG, reserved) and CC (DAC) share the range but are not frames.
function isStartOfFrame(m) {
  return m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC;
}

// Markers that stand alone, with no length field: TEM (01), RST0-RST7 (D0-D7) and SOI (D8).
function isStandalone(m) {
  return m === 0x01 || (m >= 0xD0 && m <= 0xD8);
}

// bytes: Uint8Array (an ArrayBuffer or any other ArrayBufferView is accepted too).
// Returns { width, height } from the first SOFn segment, or null if the data is not a well-formed JPEG header.
export function jpegInfo(bytes) {
  try {
    let b;
    if (bytes instanceof ArrayBuffer) b = new Uint8Array(bytes);
    else if (ArrayBuffer.isView(bytes)) b = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    else return null;

    const n = b.length;
    if (n < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;   // must start with SOI

    let i = 2;
    for (let segments = 0; segments < MAX_SEGMENTS; segments++) {
      if (i >= n || b[i] !== 0xFF) return null;            // every segment starts with FF; anything else is junk
      while (i < n && b[i] === 0xFF) i++;                   // FF fill bytes may pad before a marker
      if (i >= n) return null;
      const marker = b[i++];

      if (marker === 0x00) return null;                     // FF 00 is byte stuffing, only valid inside scan data
      if (isStandalone(marker)) continue;
      if (marker === 0xD9 || marker === 0xDA) return null;  // EOI or SOS before any frame header

      if (i + 2 > n) return null;
      const length = (b[i] << 8) | b[i + 1];                // counts its own two bytes
      if (length < 2 || i + length > n) return null;

      if (isStartOfFrame(marker)) {
        // length(2) precision(1) height(2) width(2) components(1), then 3 bytes per component
        if (length < 8) return null;
        const height = (b[i + 3] << 8) | b[i + 4];
        const width = (b[i + 5] << 8) | b[i + 6];
        const components = b[i + 7];
        if (components === 0 || length !== 8 + 3 * components) return null;
        if (width === 0 || height === 0) return null;
        return { width, height };
      }
      i += length;
    }
    return null;                                            // too many segments: treat as hostile
  } catch {
    return null;
  }
}
