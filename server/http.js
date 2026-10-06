// What the JSON APIs (the mjeshtër's and the team's) share: answers, same-site checks and capped body reading.

import { PHOTO, PHOTO_MESSAGES } from './photos.js';
import { MESSAGES } from './signin.js';

const MAX_BODY = 8192;

export function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers,
    },
  });
}

export const fail = (status, message, extra = {}) => json(status, { ok: false, message, ...extra });

export function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

// The whole origin, scheme included: a page on http://rregullo.net (say, on hostile Wi-Fi) is not this site.
export function crossSite(request) {
  const origin = request.headers.get('Origin');
  return Boolean(origin) && originOf(origin) !== new URL(request.url).origin;
}

export const mediaType = (request) => (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();

/**
 * Reads the body, but never more than max bytes: null when it is longer. A Content-Length over the cap is refused
 * before reading; without one (chunked, some HTTP/2 clients) the reading stops as soon as the cap is passed.
 */
export async function readCapped(request, max) {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return bytes;
}

/**
 * Same-site JSON only. A cross-site page can't send application/json without a CORS preflight, which this API
 * never answers, and a browser always sends Origin on a POST; so neither a form nor a script elsewhere can call it.
 */
export async function readJson(request) {
  if (crossSite(request)) return { error: fail(403, MESSAGES.generic) };
  if (mediaType(request) !== 'application/json') return { error: fail(415, MESSAGES.generic) };
  const bytes = await readCapped(request, MAX_BODY);
  if (!bytes) return { error: fail(413, MESSAGES.generic) };
  try {
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return { data };
  } catch {
    return { error: fail(400, MESSAGES.generic) };
  }
}

/** A photo upload: same-site, image/jpeg (which, like JSON, needs a preflight cross-site), at most PHOTO.maxBytes. */
export async function readJpeg(request) {
  if (crossSite(request)) return { error: fail(403, MESSAGES.generic) };
  if (mediaType(request) !== 'image/jpeg') {
    return { error: fail(415, PHOTO_MESSAGES.invalid) };
  }
  const bytes = await readCapped(request, PHOTO.maxBytes);
  if (!bytes) return { error: fail(413, PHOTO_MESSAGES.tooBig) };
  if (!bytes.byteLength) return { error: fail(400, PHOTO_MESSAGES.invalid) };
  return { bytes };
}

export const notAllowed = (allow) => () => new Response('Method Not Allowed', { status: 405, headers: { Allow: allow } });
