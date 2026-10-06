// Shrinks a photo on the phone before upload: decodes it the right way up (EXIF orientation),
// scales it down to at most maxEdge on the long edge (or centre-crops a square), paints it on white,
// and re-encodes it as a JPEG. The canvas re-encode drops all metadata (EXIF, GPS, camera model).
// Browser ES module, no dependencies. Needs img-src blob: in the page's CSP.
// Shrink one photo at a time: each call can briefly hold a fully decoded photo in memory.

export class PhotoError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'PhotoError';
    this.code = code;   // 'too_big' | 'unreadable' | 'too_small'
  }
}

export const MAX_INPUT_BYTES = 30 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 120_000_000;   // 108 MP phone photos (12000x9000) pass; past this it is a 200 MP mode or a decompression bomb
const MAX_CANVAS_PIXELS = 16_000_000;    // iOS Safari will not draw a canvas above 16,777,216 pixels
const MAX_CANVAS_EDGE = 16_384;

export async function shrinkPhoto(file, { maxEdge = 1600, square = false, squareSize = 800, quality = 0.82, minEdge = 300 } = {}) {
  if (!(maxEdge >= 1 && squareSize >= 1 && minEdge >= 0)) throw new TypeError('shrinkPhoto: bad options');
  if (!(file instanceof Blob)) throw new PhotoError('unreadable', 'Not a file.');
  if (file.size > MAX_INPUT_BYTES) throw new PhotoError('too_big', 'The file is larger than 30 MB.');
  if (file.size === 0) throw new PhotoError('unreadable', 'The file is empty.');

  const url = URL.createObjectURL(file);
  let bitmap = null;
  const canvases = [];
  try {
    // An <img> reads the size (already turned the right way up) without decoding every pixel.
    const img = await loadImage(url);
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    if (!W || !H) throw new PhotoError('unreadable', 'The image has no size.');
    if (Math.min(W, H) < minEdge) throw new PhotoError('too_small', `The shorter side is ${Math.min(W, H)} px; at least ${minEdge} px is needed.`);
    if (W * H > MAX_SOURCE_PIXELS) throw new PhotoError('too_big', 'The image has too many pixels.');

    // scale: output size / oriented source size. Never above 1.
    let scale, outW, outH;
    if (square) {
      const side = Math.min(W, H);
      outW = outH = Math.max(1, Math.min(Math.round(squareSize), side));
      scale = outW / side;
    } else {
      scale = Math.min(1, maxEdge / Math.max(W, H));
      outW = Math.max(1, Math.round(W * scale));
      outH = Math.max(1, Math.round(H * scale));
    }
    const fit = canvasFit(outW, outH);
    if (fit < 1) {
      scale *= fit;
      outW = Math.max(1, Math.floor(outW * fit));
      outH = Math.max(1, Math.floor(outH * fit));
    }

    // Best case: the browser decodes straight to (about) the output size. Otherwise draw the <img> itself.
    let src = img, srcW = W, srcH = H, srcScale = 1;
    bitmap = await decodeResized(file, W, H, scale, square);
    if (bitmap) {
      src = bitmap; srcW = bitmap.width; srcH = bitmap.height; srcScale = srcW / W;
      // The browser may round the derived edge differently (Chrome: 12000x9000 -> 1600x1201). Drawn 1:1 below;
      // a spare row or column is cropped, a missing one shrinks the output by 1 px. Never resampled again.
      if (!square) { outW = Math.min(outW, srcW); outH = Math.min(outH, srcH); }
    }
    // Without a bitmap, drawImage decodes the <img> itself. (Not img.decode() first: in Chromium that adds a
    // second, full-size decode and made the fallback path 1.5-2x slower in tests.)

    // Halve in steps while more than 2x too big: one big jump in a single drawImage looks jagged.
    const maxScale = canvasFit(W, H);
    while (srcScale / scale > 2) {
      const next = Math.min(Math.max(scale, srcScale / 2), maxScale);
      if (next <= scale) break;
      const w = Math.max(1, Math.round(W * next));
      const h = Math.max(1, Math.round(H * next));
      const c = paint(src, w, h, 0, 0, w, h);
      canvases.push(c);
      if (src !== img && src !== bitmap) release(src);
      src = c; srcW = w; srcH = h; srcScale = next;
    }

    // Final draw. A square crop is the whole image drawn larger than the canvas, centred, so the canvas clips it.
    let dw = outW, dh = outH;
    if (square) {
      const k = outW / Math.min(srcW, srcH);
      dw = srcW * k;
      dh = srcH * k;
    } else if (src === bitmap) {
      dw = srcW;
      dh = srcH;
    }
    const out = paint(src, outW, outH, Math.round((outW - dw) / 2), Math.round((outH - dh) / 2), dw, dh);
    canvases.push(out);
    if (bitmap) { bitmap.close(); bitmap = null; }
    if (isBlank(out)) throw new PhotoError('unreadable', 'The photo came out empty.');

    const blob = await toJpeg(out, Math.min(1, Math.max(0, quality)));
    if (!blob || blob.size === 0 || blob.type !== 'image/jpeg') throw new PhotoError('unreadable', 'The phone could not save the photo.');
    return { blob, width: outW, height: outH };
  } finally {
    if (bitmap) bitmap.close();
    for (const c of canvases) release(c);
    URL.revokeObjectURL(url);
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { img.onload = img.onerror = null; resolve(img); };
    img.onerror = () => {
      img.onload = img.onerror = null;
      reject(new PhotoError('unreadable', 'This file is not a photo the browser can open.'));
    };
    img.src = url;
  });
}

// Largest factor (at most 1) that keeps a w x h canvas inside the browser's limits.
function canvasFit(w, h) {
  return Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (w * h)), MAX_CANVAS_EDGE / Math.max(w, h));
}

// Decodes and resizes in one step, off the main thread. The bitmap handed back is output-sized, so no
// full-size bitmap or canvas is kept (the browser may still decode at full size internally while it works).
// Only one of resizeWidth/resizeHeight is passed, so the browser derives the other from its own idea of
// the image's shape; if that disagrees with the <img> size, the EXIF rotation was mishandled and we fall back.
// Returns null when unsupported (imageOrientation 'from-image' needs Chrome 112, Safari 16, Firefox 111;
// older browsers throw a TypeError on the unknown value) or when the result does not check out.
async function decodeResized(file, W, H, scale, square) {
  if (typeof createImageBitmap !== 'function') return null;
  const expectW = W * scale;
  const expectH = H * scale;
  if (expectW * expectH > MAX_CANVAS_PIXELS || Math.max(expectW, expectH) > MAX_CANVAS_EDGE) return null;

  const options = { imageOrientation: 'from-image' };
  if (scale < 1) {
    // Fit: the long edge must be exact. Square: the short edge must be exact.
    const byWidth = square ? W <= H : W >= H;
    if (byWidth) options.resizeWidth = Math.round(expectW);
    else options.resizeHeight = Math.round(expectH);
    options.resizeQuality = 'high';
  }

  let bmp;
  try { bmp = await createImageBitmap(file, options); } catch { return null; }
  const tolerance = scale < 1 ? 1 : 0;
  const okW = options.resizeWidth ? bmp.width === options.resizeWidth : Math.abs(bmp.width - expectW) <= tolerance;
  const okH = options.resizeHeight ? bmp.height === options.resizeHeight : Math.abs(bmp.height - expectH) <= tolerance;
  if (!okW || !okH) { bmp.close(); return null; }
  return bmp;
}

function paint(src, w, h, dx, dy, dw, dh) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { alpha: false });
  if (!ctx) { release(c); throw new PhotoError('unreadable', 'The phone could not prepare the photo.'); }
  ctx.fillStyle = '#fff';                 // transparent PNGs land on white, not black
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, dx, dy, dw, dh);
  return c;
}

// A decode that silently failed, or a draw dropped for lack of memory, leaves only our white paint.
// (So does a fully transparent or pure white image; neither is a usable photo.)
function isBlank(canvas) {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  try {
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(canvas, 0, 0, 16, 16);
    const d = ctx.getImageData(0, 0, 16, 16).data;
    for (let i = 0; i < d.length; i += 4) if (d[i] !== 255 || d[i + 1] !== 255 || d[i + 2] !== 255) return false;
    return true;
  } catch {
    return false;
  } finally {
    release(c);
  }
}

// iOS Safari frees a canvas's memory late (on garbage collection) and caps the total; 0x0 frees it now.
function release(c) {
  c.width = 0;
  c.height = 0;
}

function toJpeg(canvas, quality) {
  return new Promise((resolve) => {
    try { canvas.toBlob(resolve, 'image/jpeg', quality); } catch { resolve(null); }
  });
}
