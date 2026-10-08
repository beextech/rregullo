// Talking to /api/mjeshtri/*. The session lives in an HttpOnly cookie the script never sees. When the server says
// nobody is signed in any more (session expired, or ended on another phone), a 'rr:signedout' event goes out.

export const GENERIC = 'Diçka nuk shkoi si duhet. Provo përsëri pas pak.';
export const OFFLINE = 'S’ka lidhje me internet. Kontrolloje dhe provo prapë.';

function signedOut(status, data) {
  if (status === 401 && data && data.signedOut) window.dispatchEvent(new CustomEvent('rr:signedout'));
}

/** GET when body is undefined, otherwise POST as JSON. Resolves { status, data }; never rejects. */
export async function api(path, body) {
  const init = body === undefined
    ? { headers: { Accept: 'application/json' } }
    : { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) };
  let res;
  try { res = await fetch(path, { ...init, credentials: 'same-origin' }); } catch { return { status: 0, data: { ok: false, message: OFFLINE } }; }
  const data = await res.json().catch(() => ({ ok: false, message: GENERIC }));
  signedOut(res.status, data);
  return { status: res.status, data };
}

/** Uploads a JPEG with progress (fetch can't report upload progress). onProgress gets 0..1. */
export function uploadJpeg(path, blob, onProgress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.setRequestHeader('Content-Type', 'image/jpeg');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.responseType = 'text';
    xhr.timeout = 120000;
    if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data;
      try { data = JSON.parse(xhr.responseText); } catch { data = { ok: false, message: GENERIC }; }
      signedOut(xhr.status, data);
      resolve({ status: xhr.status, data });
    };
    xhr.onerror = () => resolve({ status: 0, data: { ok: false, message: OFFLINE } });
    xhr.ontimeout = () => resolve({ status: 0, data: { ok: false, message: 'Ngarkimi zgjati shumë. Provo prapë kur interneti të jetë më i mirë.' } });
    xhr.send(blob);
  });
}
