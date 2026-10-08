// Where photos live. R2 (binding PHOTOS) is the real home, but R2 can only be turned on with a payment card. Until it
// is, photos go to Workers KV (binding PHOTOS_KV), which needs no card. Both look the same to the rest of the code:
// put, get (with an If-None-Match onlyIf), head and delete, the subset of the R2 API that photos.js and ads.js use.
// When both bindings are there, new photos go to R2 and photos saved in KV earlier are still found and deleted.

const toBuffer = (bytes) => (bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

async function etagOf(buffer) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  return [...hash.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function matches(onlyIf, etag) {
  const inm = onlyIf && onlyIf.get('If-None-Match');
  if (!inm) return false;
  return inm.trim() === '*' || inm.split(',').some((tag) => tag.trim().replace(/^W\//, '') === `"${etag}"`);
}

/** Workers KV dressed as the bits of an R2 bucket that photos use. Each value keeps its size, etag and time as metadata. */
export function kvBucket(kv) {
  const object = (meta, body) => {
    const obj = { httpEtag: `"${meta.etag}"`, uploaded: new Date(meta.uploaded), size: meta.size };
    if (body !== undefined) obj.body = body;
    return obj;
  };
  return {
    async put(key, bytes, options = {}) {
      const buffer = toBuffer(bytes);
      const meta = { etag: await etagOf(buffer), uploaded: Date.now(), size: buffer.byteLength, ...(options.customMetadata || {}) };
      await kv.put(key, buffer, { metadata: meta });
    },
    async get(key, options = {}) {
      const { value, metadata } = await kv.getWithMetadata(key, 'stream');
      if (value === null || !metadata) return null;
      if (matches(options.onlyIf, metadata.etag)) {
        await value.cancel();
        return object(metadata);
      }
      return object(metadata, value);
    },
    async head(key) {
      const { value, metadata } = await kv.getWithMetadata(key, 'stream');
      if (value === null || !metadata) return null;
      await value.cancel();
      return object(metadata);
    },
    async delete(keys) {
      await Promise.all((Array.isArray(keys) ? keys : [keys]).map((key) => kv.delete(key)));
    },
  };
}

/** R2 first; photos saved in KV before R2 was turned on are still read and deleted there. */
function both(r2, kv) {
  return {
    put: (key, bytes, options) => r2.put(key, bytes, options),
    async get(key, options) { return (await r2.get(key, options)) || kv.get(key, options); },
    async head(key) { return (await r2.head(key)) || kv.head(key); },
    async delete(keys) { await Promise.all([r2.delete(keys), kv.delete(keys)]); },
  };
}

/** The photo store for this Worker, or null when it has neither binding (Worker previews). */
export function photoStore(env) {
  const kv = env.PHOTOS_KV ? kvBucket(env.PHOTOS_KV) : null;
  if (env.PHOTOS) return kv ? both(env.PHOTOS, kv) : env.PHOTOS;
  return kv;
}
