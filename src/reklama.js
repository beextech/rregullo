// Ads (step 6) in the browser: counts an ad's view once it is half on screen (POST /api/reklama), and draws the ad of
// pages that are not rendered on the server: <div data-ad-slot="loja|paneli" data-zanati="a,b" data-komuna="c">.
// Ads are always marked "Sponsorizuar". Nothing about the visitor is sent, and nothing is stored in the browser.

const seen = new Set();

function count(el) {
  const key = `${el.dataset.ad}|${el.dataset.adVendi}`;
  if (seen.has(key) || document.querySelector('main[data-preview]')) return;
  seen.add(key);
  try {
    fetch('/api/reklama', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: el.dataset.ad, vendi: el.dataset.adVendi }),
      keepalive: true,
      credentials: 'same-origin',
    }).catch(() => {});
  } catch { /* counting never gets in the way */ }
}

const observer = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { count(e.target); observer.unobserve(e.target); }
    }
  }, { threshold: 0.5 })
  : null;

export function watch(el) {
  if (observer) observer.observe(el); else count(el);
}

function node(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** The same markup as server/directory-pages.js adBlock(), built without innerHTML. */
export function adElement(ad) {
  const box = node('aside', 'ad');
  box.dataset.ad = ad.id;
  box.dataset.adVendi = ad.slot;
  box.setAttribute('aria-label', 'Reklamë');
  box.append(node('p', 'ad-label', `Sponsorizuar · ${ad.advertiser}`));
  const a = node('a', 'ad-link');
  a.href = ad.href;
  a.rel = 'sponsored noopener';
  a.target = '_blank';
  if (ad.image) {
    const img = node('img', 'ad-img');
    img.src = ad.image;
    img.alt = '';
    img.loading = 'lazy';
    a.append(img);
  }
  const cta = node('span', 'ad-cta', 'Shiko ofertën ');
  const arrow = node('span', '', '↗');
  arrow.setAttribute('aria-hidden', 'true');
  cta.append(arrow);
  a.append(node('span', 'ad-title', ad.title), cta);
  box.append(a);
  return box;
}

const safe = (ad) => ad && typeof ad.id === 'string' && typeof ad.title === 'string' && typeof ad.advertiser === 'string'
  && typeof ad.href === 'string' && ad.href.startsWith('/r/') && (ad.image === null || (typeof ad.image === 'string' && ad.image.startsWith('/foto/')));

/** Fills a slot with the ad the server picks for it, if any. */
export async function fill(slot) {
  const q = new URLSearchParams({ vendi: slot.dataset.adSlot });
  if (slot.dataset.zanati) q.set('zanati', slot.dataset.zanati);
  if (slot.dataset.komuna) q.set('komuna', slot.dataset.komuna);
  try {
    const res = await fetch(`/api/reklama?${q}`, { credentials: 'same-origin' });
    const data = res.status === 200 ? await res.json() : null;
    if (!data || !safe(data.ad)) { slot.replaceChildren(); slot.hidden = true; return; }
    const el = adElement(data.ad);
    slot.replaceChildren(el);
    slot.hidden = false;
    watch(el);
  } catch {
    slot.hidden = true;
  }
}

for (const el of document.querySelectorAll('[data-ad]')) watch(el);
// A slot marked data-ad-manual is filled by its page once it knows what the slot is about (the mjeshtër's Ballina).
for (const slot of document.querySelectorAll('[data-ad-slot]:not([data-ad-manual])')) fill(slot);
