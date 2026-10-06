// The public directory's script: counts profile views and taps on Thirre, WhatsApp and Viber (POST /api/numero),
// keeps "Thirrjet e mia" (the mjeshtër a client contacted, only in this browser), and runs the /thirrjet page.
// The pages work without it: the links still call and open WhatsApp and Viber.

const KEY = 'rr_thirrjet';
const TOWN_KEY = 'rr_komuna';
const MAX = 30;
const KINDS = { thirrje: 'Thirrje', whatsapp: 'WhatsApp', viber: 'Viber' };
const DAY = 24 * 60 * 60 * 1000;

const preview = () => Boolean(document.querySelector('main[data-preview]'));

// ---------- the browser's own list ----------

function valid(c) {
  return c && typeof c === 'object'
    && typeof c.m === 'string' && /^[a-z0-9]{6,16}$/.test(c.m)
    && typeof c.path === 'string' && /^\/m\/[a-z0-9-]{1,80}$/.test(c.path)
    && typeof c.phone === 'string' && /^\+3834\d{7}$/.test(c.phone)
    && typeof c.name === 'string' && c.name.length <= 80
    && typeof c.trades === 'string' && c.trades.length <= 300
    && Object.hasOwn(KINDS, c.kind) && Number.isFinite(c.at);
}

export function readCalls() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list.filter(valid) : [];
  } catch {
    return [];
  }
}

function writeCalls(list) {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
    else localStorage.removeItem(KEY);
  } catch { /* private mode or storage full: the list just isn't kept */ }
}

function remember(entry) {
  if (!valid(entry)) return;
  writeCalls([entry, ...readCalls().filter((c) => c.m !== entry.m)]);
}

// ---------- counting ----------

function count(m, lloji) {
  if (preview()) return;
  try {
    fetch('/api/numero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ m, lloji }),
      keepalive: true,           // the tap opens the dialer or another app; the count still goes out
      credentials: 'same-origin',
    }).catch(() => {});
  } catch { /* counting never gets in the way of calling */ }
}

document.addEventListener('click', (e) => {
  const link = e.target.closest('a[data-tap]');
  const box = link && link.closest('[data-m]');
  if (!box) return;
  const { m, name, path, phone, trades } = box.dataset;
  const kind = link.dataset.tap;
  count(m, kind);
  remember({ m, name, path, phone, trades, kind, at: Date.now() });
  if (document.getElementById('calls-list')) renderCalls();
});

const viewed = document.querySelector('[data-view][data-m]');
if (viewed) count(viewed.dataset.m, 'shikim');

// ---------- the search box ----------

for (const form of document.querySelectorAll('form[data-find]')) {
  const trade = form.elements.zanati;
  const town = form.elements.komuna;
  // The homepage remembers the last municipality searched, so a client picks only the trade next time.
  if (form.closest('[data-home-find]') && !town.value) {
    try {
      const last = localStorage.getItem(TOWN_KEY);
      if (last && [...town.options].some((o) => o.value === last)) town.value = last;
    } catch { /* no storage */ }
  }
  // With both chosen, the results come right away: pick a trade, pick a town, and tap Thirre.
  form.addEventListener('change', (e) => {
    if (e.target === town || e.target === trade) {
      if (trade.value && town.value) form.requestSubmit ? form.requestSubmit() : form.submit();
    }
  });
  form.addEventListener('submit', () => {
    try {
      if (town.value) localStorage.setItem(TOWN_KEY, town.value);
    } catch { /* no storage */ }
  });
}

// The page's own link in the header.
for (const a of document.querySelectorAll('.dir-nav a')) {
  if (a.getAttribute('href') === (location.pathname.replace(/\/+$/, '') || '/')) a.setAttribute('aria-current', 'page');
}

// ---------- /thirrjet ----------

function whenText(at) {
  const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((startOfDay(Date.now()) - startOfDay(at)) / DAY);
  if (days <= 0) return 'Sot';
  if (days === 1) return 'Dje';
  if (days < 7) return `Para ${days} ditësh`;
  const d = new Date(at);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function callLinks(c) {
  const box = el('div', 'dir-actions');
  const call = el('a', 'btn btn-primary dir-act dir-call', 'Thirre përsëri');
  call.href = `tel:${c.phone}`;
  call.dataset.tap = 'thirrje';
  box.append(call);
  if (c.kind === 'whatsapp' || c.kind === 'viber') {
    const other = el('a', 'btn dir-act dir-ghost', c.kind === 'whatsapp' ? 'WhatsApp' : 'Viber');
    other.href = c.kind === 'whatsapp' ? `https://wa.me/${c.phone.slice(1)}` : `viber://chat?number=%2B${c.phone.slice(1)}`;
    other.dataset.tap = c.kind;
    if (c.kind === 'whatsapp') other.rel = 'noopener';
    box.append(other);
  }
  return box;
}

function renderCalls() {
  const list = document.getElementById('calls-list');
  const empty = document.getElementById('calls-empty');
  const clear = document.getElementById('calls-clear');
  const calls = readCalls();
  list.replaceChildren(...calls.map((c) => {
    const li = el('li', 'calls-item');
    Object.assign(li.dataset, { m: c.m, name: c.name, path: c.path, phone: c.phone, trades: c.trades });
    const head = el('div', 'calls-head');
    const name = el('a', 'calls-name', c.name);
    name.href = c.path;
    head.append(name, el('span', 'calls-when', `${whenText(c.at)} · ${KINDS[c.kind]}`));
    li.append(head);
    if (c.trades) li.append(el('p', 'dir-trades', c.trades));
    li.append(callLinks(c));
    const remove = el('button', 'calls-remove', 'Hiqe nga lista');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Hiqe ${c.name} nga lista`);
    remove.addEventListener('click', () => {
      writeCalls(readCalls().filter((x) => x.m !== c.m));
      renderCalls();
      document.getElementById('calls-title').focus();
    });
    li.append(remove);
    return li;
  }));
  list.hidden = !calls.length;
  empty.hidden = calls.length > 0;
  clear.hidden = !calls.length;
}

if (document.getElementById('calls-list')) {
  document.getElementById('calls-clear').addEventListener('click', () => {
    if (!confirm('Ta fshijmë tërë listën nga ky telefon?')) return;
    writeCalls([]);
    renderCalls();
    document.getElementById('calls-title').focus();
  });
  renderCalls();
  // Another tab added a call: show it here too.
  window.addEventListener('storage', (e) => { if (e.key === KEY || e.key === null) renderCalls(); });
}
