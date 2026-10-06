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

function asBytes(bytes) {
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return null;
}

// bytes: Uint8Array (an ArrayBuffer or any other ArrayBufferView is accepted too).
// Returns { width, height } from the first SOFn segment, or null if the data is not a well-formed JPEG header.
export function jpegInfo(bytes) {
  try {
    const b = asBytes(bytes);
    if (!b) return null;
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

// APP1 (Exif and XMP: GPS position, camera, time taken), APP13 (IPTC) and COM segments can carry personal data.
// A photo shrunk on the phone has none of them; one sent some other way has them removed before it is stored.
const PRIVATE_MARKERS = new Set([0xE1, 0xED, 0xFE]);

// Returns the JPEG without those segments (the same array when it has none), or null if the header can't be
// walked up to the image data. Like jpegInfo, it never throws and never reads past the end.
export function stripMetadata(bytes) {
  try {
    const b = asBytes(bytes);
    if (!b) return null;
    const n = b.length;
    if (n < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;

    const keep = [[0, 2]];                                  // [start, end) ranges copied to the output
    let dropped = false;
    let i = 2;
    for (let segments = 0; segments < MAX_SEGMENTS; segments++) {
      if (i >= n || b[i] !== 0xFF) return null;
      const start = i;
      while (i < n && b[i] === 0xFF) i++;
      if (i >= n) return null;
      const marker = b[i++];

      if (marker === 0x00 || marker === 0xD9) return null;
      if (isStandalone(marker)) { keep.push([start, i]); continue; }
      if (marker === 0xDA) {                                // start of scan: the rest is image data, kept as is
        if (!dropped) return b;
        keep.push([start, n]);
        const out = new Uint8Array(keep.reduce((sum, [s, e]) => sum + e - s, 0));
        let at = 0;
        for (const [s, e] of keep) { out.set(b.subarray(s, e), at); at += e - s; }
        return out;
      }

      if (i + 2 > n) return null;
      const length = (b[i] << 8) | b[i + 1];
      if (length < 2 || i + length > n) return null;
      if (PRIVATE_MARKERS.has(marker)) dropped = true;
      else keep.push([start, i + length]);
      i += length;
    }
    return null;
  } catch {
    return null;
  }
}
