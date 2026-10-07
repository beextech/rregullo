// The public directory's script: counts profile views and taps on Thirre, WhatsApp and Viber (POST /api/numero),
// keeps "Thirrjet e mia" (the mjeshtër a client contacted, only in this browser), and runs the /thirrjet page,
// where "Si shkoi?" lets the client review a mjeshtër 12 hours to 60 days after the tap (POST /api/vleresim).
// The pages work without it: the links still call and open WhatsApp and Viber.

import '/reklama.js';

const KEY = 'rr_thirrjet';
const TOWN_KEY = 'rr_komuna';
const MAX = 30;
const KINDS = { thirrje: 'Thirrje', whatsapp: 'WhatsApp', viber: 'Viber' };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// A tap's signed receipt from the server: handle.time(base 36).random.signature. The review needs it.
const RECEIPT = /^([a-z0-9]{6,16})\.([0-9a-z]{1,12})\.[A-Za-z0-9_-]{16}\.[0-9a-f]{32}$/;
const REVIEW_FROM = 12 * HOUR;
const REVIEW_UNTIL = 60 * DAY;
const COMMENT_MAX = 600;
const AUTHOR_MAX = 40;

const preview = () => Boolean(document.querySelector('main[data-preview]'));

// ---------- the browser's own list ----------

function valid(c) {
  return c && typeof c === 'object'
    && typeof c.m === 'string' && /^[a-z0-9]{6,16}$/.test(c.m)
    && typeof c.path === 'string' && /^\/m\/[a-z0-9-]{1,80}$/.test(c.path)
    && typeof c.phone === 'string' && /^\+3834\d{7}$/.test(c.phone)
    && typeof c.name === 'string' && c.name.length <= 80
    && typeof c.trades === 'string' && c.trades.length <= 300
    && Object.hasOwn(KINDS, c.kind) && Number.isFinite(c.at)
    && (c.receipt === undefined || (typeof c.receipt === 'string' && RECEIPT.test(c.receipt) && c.receipt.startsWith(`${c.m}.`)))
    && (c.reviewed === undefined || Number.isFinite(c.reviewed));
}

/** When the receipt's tap happened (from the receipt itself), or NaN. */
function tappedAt(receipt) {
  const r = typeof receipt === 'string' && RECEIPT.exec(receipt);
  return r ? parseInt(r[2], 36) : NaN;
}

/** A receipt that can still lead to a review: not reviewed with yet, and not past 60 days. */
const usable = (c) => Boolean(c.receipt) && !c.reviewed && Date.now() - tappedAt(c.receipt) <= REVIEW_UNTIL;

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
  // Calling again keeps the receipt that is still usable (it is older, so "Si shkoi?" comes sooner).
  const old = readCalls().find((c) => c.m === entry.m);
  if (old && usable(old)) entry.receipt = old.receipt;
  writeCalls([entry, ...readCalls().filter((c) => c.m !== entry.m)]);
}

/** Changes one mjeshtër's entry in the list, if it is still there. */
function update(m, change) {
  const list = readCalls();
  const c = list.find((x) => x.m === m);
  if (!c) return;
  change(c);
  writeCalls(list.filter(valid));
  if (document.getElementById('calls-list')) renderCalls();
}

/** Keeps a tap's receipt, unless the entry already holds one that is still usable. */
function keepReceipt(m, receipt) {
  if (typeof receipt !== 'string' || !RECEIPT.test(receipt) || !receipt.startsWith(`${m}.`)) return;
  update(m, (c) => {
    if (usable(c)) return;
    c.receipt = receipt;
    delete c.reviewed;
  });
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
    })
      // A tap answers with a receipt, which "Si shkoi?" needs later. A view answers with nothing.
      .then((res) => (res.status === 200 ? res.json() : null))
      .then((data) => { if (data && data.receipt) keepReceipt(m, data.receipt); })
      .catch(() => {});
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

// ---------- "Si shkoi?": the review ----------

let rating = '';          // the mjeshtër whose review form is open (only one at a time)
const drafts = new Map(); // what was typed in a form, kept while the list redraws: m -> { stars, comment, author, email }

function laterText(at) {
  const d = new Date(at);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(at).setHours(0, 0, 0, 0) - today.getTime()) / DAY);
  return days <= 0 ? `sot pas orës ${time}` : days === 1 ? `nesër pas orës ${time}` : `më ${whenText(at)}`;
}

function rateBox(c) {
  if (!c.receipt) return null;
  const at = tappedAt(c.receipt);
  const age = Date.now() - at;
  const box = el('div', 'rate');
  if (c.reviewed) {
    box.append(el('p', 'rate-done', 'Faleminderit! Hape emailin dhe kliko lidhjen që vlerësimi të publikohet.'));
    return box;
  }
  if (age > REVIEW_UNTIL) return null;
  if (age < REVIEW_FROM) {
    box.append(el('p', 'rate-wait', `Si shkoi? Mund ta vlerësosh mjeshtrin ${laterText(at + REVIEW_FROM)}, pasi të keni folur.`));
    return box;
  }
  if (rating !== c.m) {
    box.append(el('p', 'rate-title', 'Si shkoi?'));
    box.append(el('p', 'rate-hint', 'Vlerësimi yt i ndihmon të tjerët ta gjejnë mjeshtrin e duhur.'));
    const open = el('button', 'btn dir-ghost rate-send', 'Vlerëso mjeshtrin');
    open.type = 'button';
    open.setAttribute('aria-label', `Vlerëso ${c.name}`);
    open.addEventListener('click', () => {
      rating = c.m;
      renderCalls();
      const first = document.querySelector(`#rate-${c.m} input[name="stars"]`);
      if (first) first.focus();
    });
    box.append(open);
    return box;
  }
  box.append(rateForm(c));
  return box;
}

function field(id, label, control, hint) {
  const wrap = el('div', 'rate-field');
  const l = el('label', '', label);
  l.htmlFor = id;
  control.id = id;
  wrap.append(l, control);
  if (hint) wrap.append(hint);
  return wrap;
}

function rateForm(c) {
  const d = drafts.get(c.m) || {};
  const form = el('form', 'rate-form');
  form.id = `rate-${c.m}`;
  form.noValidate = true;
  form.append(el('p', 'rate-title', `Si shkoi me ${c.name}?`));

  const stars = el('fieldset', 'rate-stars');
  stars.append(el('legend', '', 'Sa yje i jep? (1 = keq, 5 = shumë mirë)'));
  const labels = [];
  for (let n = 1; n <= 5; n += 1) {
    const label = el('label', 'rate-star');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'stars';
    input.value = String(n);
    input.checked = d.stars === n;
    input.setAttribute('aria-label', n === 1 ? '1 yll' : `${n} yje`);
    const star = el('span', '', '★');
    star.setAttribute('aria-hidden', 'true');
    label.append(input, star);
    labels.push(label);
    stars.append(label);
  }
  const light = () => {
    const chosen = Number((form.querySelector('input[name="stars"]:checked') || {}).value || 0);
    labels.forEach((l, i) => l.classList.toggle('is-lit', i < chosen));
  };
  stars.addEventListener('change', light);
  form.append(stars);

  const comment = el('textarea', 'rate-text');
  comment.name = 'comment';
  comment.maxLength = COMMENT_MAX;
  comment.rows = 4;
  comment.value = d.comment || '';
  form.append(field(`rate-comment-${c.m}`, 'Koment (opsional)', comment));

  const author = el('input', 'rate-input');
  author.type = 'text';
  author.name = 'author';
  author.maxLength = AUTHOR_MAX;
  author.autocomplete = 'given-name';
  author.value = d.author || '';
  form.append(field(`rate-author-${c.m}`, 'Emri që shfaqet (opsional)', author, el('p', 'rate-hint', 'P.sh. vetëm emri. Pa emër shfaqet «Klient».')));

  const email = el('input', 'rate-input');
  email.type = 'email';
  email.name = 'email';
  email.autocomplete = 'email';
  email.inputMode = 'email';
  email.required = true;
  email.value = d.email || '';
  form.append(field(`rate-email-${c.m}`, 'Emaili yt', email, el('p', 'rate-hint', 'Të dërgojmë një lidhje për ta konfirmuar. Emaili nuk shfaqet askund.')));

  const hp = el('div', 'hp');
  hp.setAttribute('aria-hidden', 'true');
  const trap = el('input');
  trap.type = 'text';
  trap.name = 'company_site';
  trap.tabIndex = -1;
  trap.autocomplete = 'off';
  hp.append(trap);
  form.append(hp);

  const error = el('p', 'form-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const note = el('p', 'rate-note', 'Vlerësimi, emri që zgjodhe dhe data shfaqen në profilin e mjeshtrit, dhe mjeshtri mund të përgjigjet. ');
  const more = el('a', '', 'Si i ruajmë të dhënat');
  more.href = '/privatesia#vleresimet';
  note.append(more);
  const send = el('button', 'btn btn-primary rate-send', 'Dërgo vlerësimin');
  send.type = 'submit';
  const cancel = el('button', 'calls-remove', 'Anulo');
  cancel.type = 'button';
  cancel.addEventListener('click', () => { rating = ''; drafts.delete(c.m); renderCalls(); });
  form.append(error, note, send, cancel);
  light();

  const keep = () => drafts.set(c.m, {
    stars: Number((form.querySelector('input[name="stars"]:checked') || {}).value || 0) || undefined,
    comment: comment.value, author: author.value, email: email.value,
  });
  form.addEventListener('input', keep);
  form.addEventListener('change', keep);

  const fail = (message, control) => {
    error.textContent = message;
    error.hidden = false;
    for (const x of [comment, author, email]) x.removeAttribute('aria-invalid');
    if (control && control !== stars) control.setAttribute('aria-invalid', 'true');
    if (control) (control === stars ? form.querySelector('input[name="stars"]') : control).focus();
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (send.getAttribute('aria-busy') === 'true') return;
    const chosen = Number((form.querySelector('input[name="stars"]:checked') || {}).value || 0);
    if (!chosen) { fail('Zgjidh nga 1 deri në 5 yje.', stars); return; }
    const address = email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) { fail('Shkruaje emailin, që ta konfirmosh vlerësimin.', email); return; }
    error.hidden = true;
    send.setAttribute('aria-busy', 'true');
    send.classList.add('is-busy');
    let res = null;
    let data = {};
    try {
      res = await fetch('/api/vleresim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          receipt: c.receipt, stars: chosen, comment: comment.value.trim(), author: author.value.trim(),
          email: address, company_site: trap.value,
        }),
      });
      data = await res.json().catch(() => ({}));
    } catch { /* offline */ }
    send.removeAttribute('aria-busy');
    send.classList.remove('is-busy');
    if (res && res.ok && data.ok) {
      rating = '';
      drafts.delete(c.m);
      update(c.m, (x) => { x.reviewed = Date.now(); });
      document.getElementById('calls-title').focus();
      return;
    }
    const message = data.message || (res ? 'Diçka shkoi keq. Provo përsëri pas pak.' : 'S’ka lidhje me internetin. Provo përsëri.');
    // This receipt can no longer lead to a review: say why, and let the list forget it.
    if (['used', 'late', 'invalid', 'gone'].includes(data.reason)) {
      rating = '';
      drafts.delete(c.m);
      update(c.m, (x) => { if (data.reason === 'used') x.reviewed = Date.now(); else delete x.receipt; });
      alert(message);
      return;
    }
    fail(message, { comment, author, email }[data.field] || (data.field === 'stars' ? stars : null));
  });
  return form;
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
    const rate = rateBox(c);
    if (rate) li.append(rate);
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
