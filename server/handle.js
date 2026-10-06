// A mjeshtër's public address, /m/<name>-<handle>. The handle is given at the first approval and never changes, so
// links keep working when the name does; the name part is only for people and Google.

export const HANDLE = /^[a-z0-9]{6,16}$/;

/** A new public id: 10 characters, lowercase letters and digits. */
export function newHandle() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  return [...crypto.getRandomValues(new Uint8Array(10))].map((b) => abc[b % abc.length]).join('');
}

/** "Arbën Krasniqi" → "arben-krasniqi": the readable part of a profile's address. */
export function nameSlug(name) {
  return String(name).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
}

export const profilePath = (name, handle) => {
  const slug = nameSlug(name);
  return `/m/${slug ? `${slug}-` : ''}${handle}`;
};

/** The handle in a /m/ address (its last part), or null. */
export function handleFromSlug(slug) {
  const handle = String(slug).split('-').pop();
  return HANDLE.test(handle) ? handle : null;
}
