// The team admin: sign in with an email link or the code in that email, then the list of mjeshtër, one mjeshtër
// (detail.js) and adding one. Talks only to /api/admin/*; the session lives in an HttpOnly cookie the script never sees.
// The link's token arrives in the #fragment (never in server logs) and is only sent when the button is pressed,
// so a mail scanner that opens the link doesn't use it up.

import { GENERIC, api } from '/mjeshtri/api.js';
import { TOWNS, TRADES, labelOf } from '/mjeshtri/catalog.js';
import { closeDetail, leaveDetail, openDetail, setMe, unsaved } from './detail.js';
import {
  $, STATUS, announce, busy, countText, initials, isBusy, setError, since, toast,
} from './util.js';

const PAGE_TITLE = 'Paneli i ekipit | Rregullo';
const FILTERS = ['pending', 'changed', 'approved', 'rejected', 'suspended', 'draft', 'reported', 'all'];
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LIST_CAP = 200;
const SEARCH_DELAY = 300;

const views = document.querySelectorAll('main > [data-view]');
const pages = document.querySelectorAll('[data-page]');
let me = null;            // { email, smsEnabled, photosEnabled } while signed in
let emailTyped = '';
let linkToken = '';
let page = '';
let filter = 'pending';   // the list filter last shown, for the way back from a mjeshtër
let lastOpened = '';      // the mjeshtër last opened, so focus goes back to its row on the way back

function show(name, focus = true) {
  for (const v of views) v.hidden = v.dataset.view !== name;
  $('#signout').hidden = name !== 'app';
  const title = document.querySelector(`[data-view="${name}"] .pro-title`);
  if (focus && title && name !== 'app') title.focus();
}

// ---------- the link from the email ----------

/** Takes the sign-in token out of the address (and out of the history); null when there is none. */
function takeToken() {
  if (!location.hash.startsWith('#hyr=')) return null;
  const token = location.hash.slice(5);
  history.replaceState(null, '', location.pathname + location.search);
  return token;
}

function showLink(token) {
  linkToken = TOKEN.test(token) ? token : '';
  setError($('#link-error'), linkToken ? '' : 'Kjo lidhje nuk vlen më. Kërko një të re.');
  $('#link-text').hidden = !linkToken;
  $('#link-go').hidden = !linkToken;
  show('link');
}

$('#link-go').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (isBusy(btn) || !linkToken) return;
  setError($('#link-error'), '');
  busy(btn, true);
  const { data } = await api('/api/admin/hyr', { token: linkToken });
  if (!data.ok) {
    busy(btn, false);
    setError($('#link-error'), data.message || GENERIC);
    if (data.expired) {
      // Used up or too old: the button would only fail again. Focus moves to asking for a new one.
      linkToken = '';
      $('#link-text').hidden = true;
      btn.hidden = true;
      document.querySelector('[data-action="new-link"]').focus();
    }
    return;
  }
  linkToken = '';
  const opened = await signedIn();
  busy(btn, false);
  if (!opened) setError($('#link-error'), GENERIC);
});

document.querySelector('[data-action="new-link"]').addEventListener('click', () => {
  linkToken = '';
  setError($('#signed-out-note'), '');
  show('email');
});

// ---------- step 1: the email ----------

const emailForm = $('#email-form');
const emailInput = $('#email');
emailForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = emailForm.querySelector('button[type="submit"]');
  if (isBusy(btn)) return;
  setError($('#email-error'), '');
  setError($('#email-form-error'), '');
  emailInput.removeAttribute('aria-invalid');
  const email = emailInput.value.trim();
  if (!EMAIL.test(email) || email.length > 254) {
    setError($('#email-error'), email ? 'Kjo nuk duket si adresë emaili.' : 'Shkruaje emailin.');
    emailInput.setAttribute('aria-invalid', 'true');
    emailInput.focus();
    return;
  }
  busy(btn, true);
  const { data } = await api('/api/admin/lidhja', { email });
  busy(btn, false);
  if (!data.ok) {
    if (data.field === 'email') {
      setError($('#email-error'), data.message);
      emailInput.setAttribute('aria-invalid', 'true');
      emailInput.focus();
    } else {
      setError($('#email-form-error'), data.message || GENERIC);
    }
    return;
  }
  emailTyped = email;
  setError($('#signed-out-note'), '');
  $('#code-sent').textContent = data.message || 'Nëse kjo adresë ka qasje, të dërguam një email me lidhje dhe kod. Vlejnë 15 minuta.';
  $('#code-form').reset();
  setError($('#code-error'), '');
  setError($('#code-form-error'), '');
  $('#code').removeAttribute('aria-invalid');
  show('code');
});

// ---------- step 2: the code from the email ----------

const codeForm = $('#code-form');
const codeInput = $('#code');
codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
  if (codeInput.value.length === 6) codeForm.requestSubmit();
});
codeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = codeForm.querySelector('button[type="submit"]');
  if (isBusy(btn)) return;
  setError($('#code-error'), '');
  setError($('#code-form-error'), '');
  codeInput.removeAttribute('aria-invalid');
  const code = codeInput.value.trim();
  if (!/^\d{6}$/.test(code)) {
    setError($('#code-error'), 'Kodi ka 6 shifra.');
    codeInput.setAttribute('aria-invalid', 'true');
    codeInput.focus();
    return;
  }
  busy(btn, true);
  const { data } = await api('/api/admin/hyr', { email: emailTyped, code });
  if (!data.ok) {
    busy(btn, false);
    if (data.field === 'code') {
      setError($('#code-error'), data.message);
      codeInput.setAttribute('aria-invalid', 'true');
      codeInput.select();
    } else {
      setError($('#code-form-error'), data.message || GENERIC);
    }
    return;
  }
  const opened = await signedIn();
  busy(btn, false);
  if (!opened) setError($('#code-form-error'), GENERIC);
});

document.querySelector('[data-action="change-email"]').addEventListener('click', () => {
  show('email');
  emailInput.focus();
});
document.querySelector('[data-action="resend"]').addEventListener('click', () => {
  emailInput.value = emailTyped;
  setError($('#email-form-error'), '');
  show('email');
  emailForm.querySelector('button[type="submit"]').focus();
});

// ---------- signed in ----------

async function loadMe() {
  const { status, data } = await api('/api/admin/une');
  if (status === 200 && data.ok) {
    me = { email: data.email, smsEnabled: Boolean(data.smsEnabled), photosEnabled: Boolean(data.photosEnabled) };
    return true;
  }
  return false;
}

async function signedIn() {
  if (!(await loadMe())) return false;
  openApp(true);
  return true;
}

function openApp(focus) {
  setMe(me);
  $('#me-email').textContent = me.email;
  emailForm.reset();
  codeForm.reset();
  show('app', false);
  route(focus);
}

function signedOut(message) {
  me = null;
  page = '';
  closeDetail();
  clearTimeout(searchTimer);
  listSeq++;
  $('#rows').replaceChildren();
  $('#q').value = '';
  document.title = PAGE_TITLE;
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  setError($('#signed-out-note'), message || '');
  show('email');
}

$('#signout').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (isBusy(btn)) return;
  if (unsaved() && !window.confirm('Ke ndryshime të paruajtura ose foto që po ngarkohen. Të dalësh gjithsesi?')) return;
  busy(btn, true);
  const { data } = await api('/api/admin/dil', {});
  busy(btn, false);
  if (!data.ok && !data.signedOut) { toast(data.message || GENERIC); return; }
  signedOut('Dole nga paneli i ekipit.');
});

// The session ended (expired, or this address no longer has access). Before the app is open a 401 is just
// "not signed in yet".
window.addEventListener('rr:signedout', () => {
  if (me) signedOut('Nuk je më i kyçur. Hyr prapë me emailin e ekipit.');
});

// ---------- routing: #lista[/filter], #m/<id>, #shto ----------

function parseRoute() {
  const h = location.hash.slice(1);
  if (h === 'shto') return { name: 'add' };
  const m = /^m\/([A-Za-z0-9-]{1,64})$/.exec(h);
  if (m) return { name: 'detail', id: m[1] };
  const l = /^lista\/(\w+)$/.exec(h);
  return { name: 'list', filter: l && FILTERS.includes(l[1]) ? l[1] : '' };
}

function showPage(name) {
  page = name;
  for (const p of pages) p.hidden = p.dataset.page !== name;
}

function route(focus) {
  const r = parseRoute();
  if (r.name !== 'detail') leaveDetail();
  if (r.name === 'detail') {
    lastOpened = r.id;
    showPage('detail');
    document.title = `Mjeshtri · ${PAGE_TITLE}`;
    openDetail(r.id, { focus, back: `#lista/${filter}` });
  } else if (r.name === 'add') {
    showPage('add');
    $('#add-back').href = `#lista/${filter}`;
    document.title = `Shto mjeshtër · ${PAGE_TITLE}`;
    if (focus) { window.scrollTo(0, 0); $('#add-title').focus(); }
  } else {
    const wasList = page === 'list';
    const from = page === 'detail' ? lastOpened : '';
    showPage('list');
    document.title = `Mjeshtrit · ${PAGE_TITLE}`;
    if (focus && !wasList) { window.scrollTo(0, 0); $('#list-title').focus(); }
    loadList(r.filter, { say: wasList, focusRow: focus ? from : '' });
  }
}

window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#hyr=')) {
    const token = takeToken();
    // Already signed in: the link isn't needed (and stays unused).
    if (me) { route(false); return; }
    showLink(token);
    return;
  }
  if (me) route(true);
});

// The skip link jumps to the open view's heading. It must not change the #hash, which picks the view.
document.querySelector('.skip').addEventListener('click', (e) => {
  const title = me
    ? document.querySelector(`[data-page="${page}"] .pro-title`)
    : document.querySelector('main > [data-view]:not([hidden]) .pro-title');
  if (!title) return;
  e.preventDefault();
  title.focus();
});

// ---------- the list ----------

let listSeq = 0;          // only the newest answer may draw
let searchTimer = 0;
const qInput = $('#q');

// A POST, so a searched name or phone number never ends up in a URL (and so in request logs).
const listQuery = (status) => ({ status, q: qInput.value.trim() });

/** Loads and draws the list. No filter in the address: "Në pritje" when someone is waiting, otherwise everyone. */
async function loadList(wanted, { say = false, focusRow = '' } = {}) {
  const seq = ++listSeq;
  setError($('#list-error'), '');
  $('#rows').setAttribute('aria-busy', 'true');
  let status = wanted || 'pending';
  let { data } = await api('/api/admin/mjeshtrit', listQuery(status));
  if (seq !== listSeq || page !== 'list') return;
  if (!wanted && data.ok && !(data.counts && data.counts.pending > 0)) {
    status = 'all';
    ({ data } = await api('/api/admin/mjeshtrit', listQuery(status)));
    if (seq !== listSeq || page !== 'list') return;
  }
  $('#rows').removeAttribute('aria-busy');
  if (!wanted) history.replaceState(null, '', `#lista/${status}`);
  filter = status;
  for (const a of document.querySelectorAll('[data-filter]')) {
    if (a.dataset.filter === status) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
  }
  if (!data.ok) {
    setError($('#list-error'), data.message || GENERIC);
    return;
  }
  renderList(data, status);
  if (say) announce(countText(data.items.length));
  // Back from a mjeshtër: focus its row, so working through the queue doesn't start from the top every time.
  const back = focusRow && document.activeElement === $('#list-title') && $(`#rows a[href="#m/${CSS.escape(encodeURIComponent(focusRow))}"]`);
  if (back) back.focus();
}

function renderList(data, status) {
  const counts = data.counts || {};
  for (const el of document.querySelectorAll('[data-count]')) {
    const n = counts[el.dataset.count];
    el.textContent = typeof n === 'number' ? String(n) : '';
  }
  const items = Array.isArray(data.items) ? data.items : [];
  const now = Date.now();
  $('#rows').replaceChildren(...items.map((item, i) => row(item, i, now)));
  $('#rows').hidden = items.length === 0;

  const empty = $('#list-empty');
  const q = qInput.value.trim();
  empty.replaceChildren();
  if (!items.length) {
    if (q) {
      empty.append(status === 'all' ? 'Asnjë mjeshtër me këtë emër ose numër.' : 'Asnjë mjeshtër me këtë emër ose numër këtu. ');
      if (status !== 'all') {
        const a = document.createElement('a');
        a.href = '#lista/all';
        a.textContent = 'Kërko te të gjithë';
        empty.append(a);
      }
    } else {
      empty.append({ pending: 'Askush nuk pret shqyrtim tani.', reported: 'Asnjë vlerësim i raportuar tani.' }[status] || 'Asnjë mjeshtër këtu.');
    }
  }
  empty.hidden = items.length > 0;
  $('#list-cap').hidden = typeof data.truncated === 'boolean' ? !data.truncated : items.length < LIST_CAP;
}

function photoUrl(photo) {
  const url = typeof photo === 'string' ? photo : photo && photo.url;
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '';
}

function towns(list) {
  const names = list.map((t) => labelOf(TOWNS, t));
  return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// One row is one link. Its name is the mjeshtër and the state; the rest (phone, trades, towns, waiting time)
// is its description, so a screen reader hears the important part first.
function row(item, i, now) {
  const name = item.name || 'Pa emër';
  const state = STATUS[item.status] || item.status;
  const li = document.createElement('li');
  const a = el('a', 'row');
  a.href = `#m/${encodeURIComponent(item.id)}`;
  const flags = [state];
  if (item.verified) flags.push('Verifikuar');
  if (item.changedSinceApproval) flags.push('Ndryshuar pas aprovimit');
  a.setAttribute('aria-label', `${name}, ${flags.join(', ')}`);
  a.setAttribute('aria-describedby', `row-${i}-meta`);

  const photo = el('span', 'row-photo');
  photo.setAttribute('aria-hidden', 'true');
  const url = photoUrl(item.photo);
  if (url) {
    const img = el('img');
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    photo.append(img);
  } else {
    photo.textContent = item.name ? initials(item.name) : '?';
  }

  const body = el('span', 'row-body');
  const top = el('span', 'row-top');
  top.append(el('span', item.name ? 'row-name' : 'row-name is-unnamed', name));
  const chips = el('span', 'row-chips');
  const chip = el('span', 'status-chip', state);
  chip.dataset.state = item.status;
  chips.append(chip);
  if (item.changedSinceApproval) chips.append(el('span', 'status-chip is-changed', 'Ndryshuar'));
  if (item.verified) chips.append(el('span', 'status-chip is-verified', 'Verifikuar'));
  top.append(chips);

  const meta = el('span', 'row-meta');
  meta.id = `row-${i}-meta`;
  const parts = [item.phone];
  const trades = Array.isArray(item.trades) ? item.trades : [];
  const where = Array.isArray(item.towns) ? item.towns : [];
  if (trades.length) parts.push(trades.map((t) => labelOf(TRADES, t)).join(', '));
  if (where.length) parts.push(towns(where));
  meta.append(el('span', 'row-line', parts.filter(Boolean).join(' · ')));
  if (item.status === 'pending' && item.submittedAt) {
    meta.append(el('span', 'row-wait', `në pritje prej ${since(item.submittedAt, now)}`));
  }
  body.append(top, meta);
  const arrow = el('span', 'row-arrow', '›');
  arrow.setAttribute('aria-hidden', 'true');
  a.append(photo, body, arrow);
  li.append(a);
  return li;
}

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(searchTimer);
  loadList(filter, { say: true });
});
qInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadList(filter, { say: true }), SEARCH_DELAY);
});

// ---------- adding a mjeshtër ----------

const addForm = $('#add-form');
const addPhone = $('#add-phone');
const addConsent = $('#add-consent');

function addFieldError(input, errorEl, message) {
  setError(errorEl, message);
  if (message) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
}

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = addForm.querySelector('button[type="submit"]');
  if (isBusy(btn)) return;
  addFieldError(addPhone, $('#add-phone-error'), '');
  addFieldError(addConsent, $('#add-consent-error'), '');
  setError($('#add-form-error'), '');
  const phone = addPhone.value.trim();
  if (!phone) {
    addFieldError(addPhone, $('#add-phone-error'), 'Shkruaje numrin e telefonit të mjeshtrit.');
    addPhone.focus();
    return;
  }
  if (!addConsent.checked) {
    addFieldError(addConsent, $('#add-consent-error'), 'Shtoje vetëm kur mjeshtri ka pranuar.');
    addConsent.focus();
    return;
  }
  busy(btn, true);
  const { status, data } = await api('/api/admin/shto', { phone, consent: true });
  busy(btn, false);
  if (data.ok && data.id) {
    addForm.reset();
    toast('Mjeshtri u shtua. Plotësoje profilin dhe fotot.');
    location.hash = `#m/${encodeURIComponent(data.id)}`;
    return;
  }
  if (status === 409 && data.id) {
    // The number is already here: offer to open that mjeshtër instead.
    const box = $('#add-form-error');
    const a = el('a', '', 'Hape profilin e tij');
    a.href = `#m/${encodeURIComponent(data.id)}`;
    box.replaceChildren(`${data.message || 'Ky numër është tashmë në Rregullo.'} `, a);
    box.hidden = false;
    return;
  }
  if (data.field === 'phone') {
    addFieldError(addPhone, $('#add-phone-error'), data.message);
    addPhone.focus();
  } else if (data.field === 'consent') {
    addFieldError(addConsent, $('#add-consent-error'), data.message);
    addConsent.focus();
  } else {
    setError($('#add-form-error'), data.message || GENERIC);
  }
});

// ---------- start ----------

const token = takeToken();
if (await loadMe()) openApp(false);
else if (token !== null) showLink(token);
else show('email', false);
