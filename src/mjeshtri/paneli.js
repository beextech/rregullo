// The mjeshtër dashboard: Ballina, Profili, Foto and Llogaria, one section per #hash so the back button works.
// The server answers every change with the whole dashboard state, and the page redraws from that.
// User-written text only ever goes into the page through textContent.

import { GENERIC, api, uploadJpeg } from './api.js';
import { LIMITS, TOWNS, TRADES, labelOf } from './catalog.js';
import { shrinkPhoto } from './photo.js';

const $ = (sel, root = document) => root.querySelector(sel);
const TABS = ['ballina', 'profili', 'foto', 'llogaria'];
const TAB_NAMES = { ballina: 'Ballina', profili: 'Profili', foto: 'Foto', llogaria: 'Llogaria' };
const PAGE_TITLE = 'Paneli i mjeshtrit | Rregullo';

let dash = null;          // the last dashboard state from the server
let isOpen = false;
let current = '';
let saved = '';           // the profile form as last loaded or saved (JSON), to spot unsaved changes
const pending = [];       // work photos on their way up: { id, url, label, progress }

// ---------- small helpers ----------

function setError(el, message) {
  el.textContent = message || '';
  el.hidden = !message;
}

function busy(btn, on) {
  btn.disabled = on;
  btn.classList.toggle('is-busy', on);
}

let toastTimer = 0;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('is-on'); el.textContent = ''; }, 6000);
}

const fold = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function initials(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.slice(0, 2).map((w) => [...w][0]).join('') || '?').toUpperCase();
}

function yearsText(n) {
  if (n === 0) return 'Më pak se një vit përvojë';
  return n === 1 ? '1 vit përvojë' : `${n} vjet përvojë`;
}

function photoInto(box, photo, fallbackInitials) {
  const img = box.querySelector('img');
  const letters = box.querySelector('.pp-initials');
  if (photo) {
    if (!img) {
      const el = document.createElement('img');
      el.alt = '';
      el.decoding = 'async';
      box.prepend(el);
    }
    const el = box.querySelector('img');
    if (el.getAttribute('src') !== photo.url) el.src = photo.url;
    letters.hidden = true;
  } else {
    if (img) img.remove();
    letters.hidden = false;
    letters.textContent = fallbackInitials;
  }
}

// ---------- routing ----------

const tabFromHash = () => (TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'ballina');

function showTab(tab, focus) {
  current = tab;
  document.title = `${TAB_NAMES[tab]} · ${PAGE_TITLE}`;
  for (const s of document.querySelectorAll('[data-section]')) s.hidden = s.dataset.section !== tab;
  for (const a of document.querySelectorAll('[data-tab]')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (focus) {
    window.scrollTo(0, 0);
    $(`[data-section="${tab}"] .pro-title`).focus();
  }
}

// Changing tab loses nothing (the sections are only hidden), so unsaved profile changes just mark the Profili tab.
window.addEventListener('hashchange', () => {
  if (!isOpen) return;
  showTab(tabFromHash(), true);
  if (focusAfterRoute) { focusField(focusAfterRoute); focusAfterRoute = ''; }
});

window.addEventListener('beforeunload', (e) => {
  if (isOpen && (dirty() || pending.length)) { e.preventDefault(); e.returnValue = ''; }
});

// The skip link jumps past the tab bar to the open section's heading. It must not change the #hash, which picks the tab.
document.querySelector('.skip').addEventListener('click', (e) => {
  if (!isOpen) return;
  e.preventDefault();
  $(`[data-section="${current}"] .pro-title`).focus();
});

let focusAfterRoute = '';
function focusField(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const target = el.matches('fieldset') ? el.querySelector('input:not([disabled])') : el;
  if (target) { target.focus(); target.scrollIntoView({ block: 'center' }); }
}

// ---------- opening and closing ----------

export function openDashboard(state, { fresh }) {
  isOpen = true;
  apply(state, { refill: true });
  showTab(tabFromHash(), fresh);
}

export function closeDashboard() {
  isOpen = false;
  dash = null;
  saved = '';
  pending.length = 0;
  profileForm.reset();
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  document.title = PAGE_TITLE;
  if (location.hash) history.replaceState(null, '', location.pathname);
}

/** Redraws everything from a dashboard state. The profile form is only refilled when it holds no unsaved changes. */
function apply(state, { refill = false } = {}) {
  dash = state;
  for (const el of document.querySelectorAll('[data-phone]')) el.textContent = state.phone;
  if (refill || !dirty()) fillForm(state.profile);
  renderBallina();
  renderPhotos();
  renderPreview();
  const locked = state.status === 'suspended';
  for (const el of profileForm.querySelectorAll('input, textarea, button')) el.disabled = locked;
  if (!locked) updateLimits();
  renderSaveState();
}

// ---------- Ballina ----------

const STATES = {
  draft: ['Profili yt nuk është dërguar ende', 'Plotësoji pikat më poshtë dhe dërgoje për shqyrtim. Klientët e shohin profilin pasi ta aprovojë ekipi i Rregullos.'],
  pending: ['Profili yt po shqyrtohet', 'Ekipi i Rregullos po e kontrollon. Ndërkohë mund ta ndryshosh profilin dhe fotot.'],
  approved: ['Profili yt është aprovuar', 'Klientët do të të gjejnë sapo të hapet kërkimi në Rregullo.'],
  rejected: ['Profili yt ka nevojë për ndryshime', 'Rregulloje sipas arsyes më poshtë dhe dërgoje prapë.'],
  suspended: ['Llogaria jote është pezulluar', 'Profili yt nuk shfaqet te klientët dhe nuk mund të ndryshohet tani.'],
};

const ITEMS = {
  name: ['Emri', '#profili', 'f-name'],
  trades: ['Të paktën një zanat', '#profili', 'f-trades'],
  towns: ['Të paktën një komunë', '#profili', 'f-towns'],
  photo: ['Foto e profilit', '#foto', 'avatar-input'],
  about: ['Disa fjali për punën tënde', '#profili', 'f-about'],
  work: ['Të paktën 3 foto të punëve', '#foto', 'work-input'],
  years: ['Vitet e përvojës', '#profili', 'f-years'],
};

function checkItem(item) {
  const [label, href, field] = ITEMS[item.key];
  const li = document.createElement('li');
  li.className = 'check-item';
  li.dataset.done = item.done ? 'true' : 'false';
  const mark = document.createElement('span');
  mark.className = 'check-mark';
  mark.setAttribute('aria-hidden', 'true');
  li.append(mark);
  if (item.done) {
    const text = document.createElement('span');
    text.textContent = label;
    const sr = document.createElement('span');
    sr.className = 'visually-hidden';
    sr.textContent = ', gati';
    li.append(text, sr);
  } else {
    const a = document.createElement('a');
    a.href = href;
    const text = document.createElement('span');
    text.textContent = label;
    a.append(text);
    a.addEventListener('click', () => { focusAfterRoute = field; });
    const sr = document.createElement('span');
    sr.className = 'visually-hidden';
    sr.textContent = ', mungon';
    a.append(sr);
    li.append(a);
  }
  return li;
}

function renderBallina() {
  const [title, text] = STATES[dash.status] || STATES.draft;
  $('#state-card').dataset.state = dash.status;
  $('#state-title').textContent = title;
  $('#state-text').textContent = text;
  const note = (dash.status === 'rejected' || dash.status === 'suspended') && dash.statusNote;
  $('#state-note').hidden = !note;
  $('#state-note-text').textContent = note || '';

  const sw = $('#available');
  sw.setAttribute('aria-checked', String(dash.available));
  sw.disabled = dash.status === 'suspended';
  $('#available-hint').textContent = dash.available
    ? 'Klientët shohin që merr punë të reja.'
    : 'Klientët shohin që tani për tani nuk merr punë të reja.';

  const { items, percent } = dash.checklist;
  $('#checklist-percent').textContent = String(percent);
  $('#checklist-meter').style.width = `${percent}%`;
  $('#checklist-required').replaceChildren(...items.filter((i) => i.required).map(checkItem));
  $('#checklist-recommended').replaceChildren(...items.filter((i) => !i.required).map(checkItem));
  $('#submit-box').hidden = !(dash.status === 'draft' || dash.status === 'rejected');

  const s = dash.stats;
  const num = (n) => n.toLocaleString('sq-AL');
  $('#stat-calls').textContent = num(s.calls);
  $('#stat-whatsapp').textContent = num(s.whatsapp);
  $('#stat-viber').textContent = num(s.viber);
  $('#stat-views').textContent = num(s.views);
  $('#stat-rating').textContent = s.rating === null ? '–' : s.rating.toLocaleString('sq-AL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  $('#stat-reviews').textContent = num(s.newReviews);
  $('#stats-note').hidden = s.calls + s.whatsapp + s.viber + s.views + s.reviews > 0;
}

$('#available').addEventListener('click', async (e) => {
  const sw = e.currentTarget;
  const next = !dash.available;
  sw.setAttribute('aria-checked', String(next));
  sw.disabled = true;
  const { data } = await api('/api/mjeshtri/disponueshem', { available: next });
  sw.disabled = false;
  if (!data.ok) {
    sw.setAttribute('aria-checked', String(dash.available));
    toast(data.message || GENERIC);
    return;
  }
  apply(data.dashboard);
  toast(next ? 'Tani klientët shohin që merr punë.' : 'Tani klientët shohin që nuk merr punë.');
});

$('#submit').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  setError($('#submit-error'), '');
  busy(btn, true);
  // The checklist shows what is saved, so unsaved profile changes are saved first.
  if (dirty() && !(await saveForm())) {
    busy(btn, false);
    setError($('#submit-error'), 'Ndryshimet në profil nuk u ruajtën. Shiko te Profili çfarë duhet rregulluar.');
    return;
  }
  if (!dash.checklist.ready) {
    busy(btn, false);
    const missing = dash.checklist.items.filter((i) => i.required && !i.done).map((i) => ITEMS[i.key][0].toLowerCase());
    setError($('#submit-error'), `Para se ta dërgosh, plotësoji: ${missing.join(', ')}.`);
    return;
  }
  const { data } = await api('/api/mjeshtri/dergo', {});
  busy(btn, false);
  if (!data.ok) { setError($('#submit-error'), data.message || GENERIC); return; }
  apply(data.dashboard);
  toast(data.message);
  $('#ballina-title').focus();
});

// ---------- Profili ----------

const profileForm = $('#profile-form');
const tradeBoxes = [];
const townBoxes = [];
let townOrder = [];       // selected towns in the order they were picked, for the chips

function chip(name, item, cls) {
  const label = document.createElement('label');
  label.className = cls;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.name = name;
  input.value = item.slug;
  input.className = `${cls}-box`;
  const span = document.createElement('span');
  span.textContent = item.label;
  label.append(input, span);
  return { label, input };
}

for (const t of TRADES) {
  const { label, input } = chip('trades', t, 'chip');
  tradeBoxes.push(input);
  $('#f-trades-list').append(label);
}
for (const t of TOWNS) {
  const { label, input } = chip('towns', t, 'town');
  label.dataset.search = fold(t.label);
  townBoxes.push(input);
  $('#f-towns-list').append(label);
}

function readForm() {
  const v = (id) => document.getElementById(id).value;
  return {
    name: v('f-name').trim(),
    about: v('f-about').trim(),
    trades: tradeBoxes.filter((b) => b.checked).map((b) => b.value),
    towns: townOrder.slice(),
    years: v('f-years').trim(),
    priceNote: v('f-price').trim(),
    whatsapp: $('#f-whatsapp').checked,
    viber: $('#f-viber').checked,
  };
}

function fillForm(p) {
  $('#f-name').value = p.name;
  $('#f-about').value = p.about;
  for (const b of tradeBoxes) b.checked = p.trades.includes(b.value);
  townOrder = p.towns.filter((t) => townBoxes.some((b) => b.value === t));
  for (const b of townBoxes) b.checked = townOrder.includes(b.value);
  $('#f-years').value = p.years === null ? '' : String(p.years);
  $('#f-price').value = p.priceNote;
  $('#f-whatsapp').checked = p.whatsapp;
  $('#f-viber').checked = p.viber;
  saved = JSON.stringify(readForm());
  clearFieldErrors();
  renderTownChips();
}

const dirty = () => Boolean(saved) && JSON.stringify(readForm()) !== saved;

function updateLimits() {
  const nTrades = tradeBoxes.filter((b) => b.checked).length;
  for (const b of tradeBoxes) b.disabled = !b.checked && nTrades >= LIMITS.maxTrades;
  $('#f-trades-count').textContent = `${nTrades} nga ${LIMITS.maxTrades}`;
  const nTowns = townOrder.length;
  for (const b of townBoxes) b.disabled = !b.checked && nTowns >= LIMITS.maxTowns;
  $('#f-towns-count').textContent = `${nTowns} nga ${LIMITS.maxTowns}`;
  $('#f-about-count').textContent = `${$('#f-about').value.length}/${LIMITS.about}`;
}

function renderTownChips() {
  const box = $('#f-towns-selected');
  box.replaceChildren(...townOrder.map((slug) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip-on';
    b.dataset.town = slug;
    b.disabled = dash ? dash.status === 'suspended' : false;
    const label = labelOf(TOWNS, slug);
    b.setAttribute('aria-label', `Hiqe ${label}`);
    const text = document.createElement('span');
    text.textContent = label;
    const x = document.createElement('span');
    x.className = 'chip-x';
    x.setAttribute('aria-hidden', 'true');
    x.textContent = '×';
    b.append(text, x);
    return b;
  }));
  box.hidden = townOrder.length === 0;
}

$('#f-towns-selected').addEventListener('click', (e) => {
  const b = e.target.closest('[data-town]');
  if (!b) return;
  const slug = b.dataset.town;
  const next = b.nextElementSibling || b.previousElementSibling;
  townOrder = townOrder.filter((t) => t !== slug);
  const box = townBoxes.find((x) => x.value === slug);
  if (box) box.checked = false;
  renderTownChips();
  onFormChange();
  const again = next && $(`#f-towns-selected [data-town="${next.dataset.town}"]`);
  (again || $('#f-towns-filter')).focus();
});

$('#f-towns-list').addEventListener('change', (e) => {
  const box = e.target;
  if (box.checked && !townOrder.includes(box.value)) townOrder.push(box.value);
  if (!box.checked) townOrder = townOrder.filter((t) => t !== box.value);
  renderTownChips();
});

$('#f-towns-filter').addEventListener('input', (e) => {
  const q = fold(e.target.value.trim());
  let shown = 0;
  for (const label of $('#f-towns-list').children) {
    const match = !q || label.dataset.search.includes(q);
    label.hidden = !match;
    if (match) shown++;
  }
  $('#f-towns-empty').hidden = shown > 0;
});
// Enter in the town search ticks the only match instead of submitting the form.
$('#f-towns-filter').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const visible = [...$('#f-towns-list').children].filter((l) => !l.hidden);
  if (visible.length === 1) visible[0].querySelector('input').click();
});

$('#f-years').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 2); });

function renderSaveState() {
  const isDirty = dirty();
  $('#save').disabled = !isDirty || (dash && dash.status === 'suspended');
  const text = isDirty ? 'Ndryshime të paruajtura' : 'Gjithçka është ruajtur';
  if ($('#save-state').textContent !== text) $('#save-state').textContent = text;
  $('#save-bar').classList.toggle('is-dirty', isDirty);
  $('#profili-dot').hidden = !isDirty;
  $('#profili-unsaved').hidden = !isDirty;
}

function onFormChange() {
  updateLimits();
  renderPreview();
  renderSaveState();
}
profileForm.addEventListener('input', onFormChange);
profileForm.addEventListener('change', onFormChange);

const FIELD_ERRORS = { name: 'f-name', about: 'f-about', trades: 'f-trades', towns: 'f-towns', years: 'f-years', priceNote: 'f-price' };

function clearFieldErrors() {
  for (const id of Object.values(FIELD_ERRORS)) {
    setError(document.getElementById(`${id}-error`), '');
    document.getElementById(id).removeAttribute('aria-invalid');
  }
  setError($('#profile-error'), '');
}

// Saves the profile form. On errors they are shown by their fields, and the first one gets focus (on Profili,
// switching there if needed). Resolves true when saved.
async function saveForm() {
  clearFieldErrors();
  const body = readForm();
  const showOnProfili = (id) => {
    if (current === 'profili') focusField(id);
    else { focusAfterRoute = id; location.hash = '#profili'; }
  };
  if (body.years && Number(body.years) > LIMITS.maxYears) {
    setError($('#f-years-error'), `Shkruaji vitet nga 0 deri në ${LIMITS.maxYears}.`);
    $('#f-years').setAttribute('aria-invalid', 'true');
    showOnProfili('f-years');
    return false;
  }
  const btn = $('#save');
  busy(btn, true);
  const { data } = await api('/api/mjeshtri/profili', body);
  btn.classList.remove('is-busy');
  if (!data.ok) {
    btn.disabled = false;
    if (data.errors) {
      let first = null;
      for (const [field, message] of Object.entries(data.errors)) {
        const id = FIELD_ERRORS[field];
        if (!id) continue;
        setError(document.getElementById(`${id}-error`), message);
        document.getElementById(id).setAttribute('aria-invalid', 'true');
        first = first || id;
      }
      setError($('#profile-error'), data.message);
      if (first) showOnProfili(first);
    } else {
      setError($('#profile-error'), data.message || GENERIC);
    }
    return false;
  }
  apply(data.dashboard, { refill: true });
  toast(data.message || 'U ruajt.');
  return true;
}

profileForm.addEventListener('submit', (e) => {
  e.preventDefault();
  saveForm();
});

// ---------- the preview ----------

function renderPreview() {
  if (!dash) return;
  const p = readForm();
  photoInto($('#pp-photo'), dash.photos.profile, initials(p.name));
  $('#pp-name').textContent = p.name || 'Emri yt';
  $('#pp-trades').textContent = p.trades.length ? p.trades.map((t) => labelOf(TRADES, t)).join(' · ') : 'Zanati yt';
  const av = $('#pp-available');
  av.textContent = dash.available ? 'Merr punë tani' : 'Tani për tani nuk merr punë';
  av.classList.toggle('is-off', !dash.available);
  const towns = p.towns.map((t) => labelOf(TOWNS, t));
  $('#pp-towns').textContent = towns.length
    ? `Punon në ${towns.length > 3 ? `${towns.slice(0, 3).join(', ')} dhe ${towns.length - 3} komuna të tjera` : towns.join(', ')}`
    : 'Komunat ku punon';
  const years = p.years === '' ? null : Number(p.years);
  $('#pp-years').hidden = years === null || Number.isNaN(years);
  $('#pp-years').textContent = years === null ? '' : yearsText(years);
  $('#pp-price').hidden = !p.priceNote;
  $('#pp-price').textContent = p.priceNote;
  $('#pp-about').hidden = !p.about;
  $('#pp-about').textContent = p.about;
  $('#pp-whatsapp').hidden = !p.whatsapp;
  $('#pp-viber').hidden = !p.viber;
}

// ---------- Foto ----------

const PHOTO_ERRORS = {
  unreadable: 'Kjo foto nuk u hap. Zgjidh një foto JPG ose PNG.',
  too_small: 'Kjo foto është shumë e vogël. Zgjidh një foto më të madhe.',
  too_big: 'Kjo foto është shumë e madhe. Zgjidh një foto tjetër.',
};

function renderPhotos() {
  const off = !dash.photosEnabled;
  const locked = off || dash.status === 'suspended';
  $('#photos-off').hidden = !off;
  photoInto($('#avatar'), dash.photos.profile, initials(dash.profile.name));
  $('#avatar-pick').textContent = dash.photos.profile ? 'Ndrysho foton' : 'Zgjidh foton';
  $('#avatar-input').disabled = locked;
  $('#avatar-pick').classList.toggle('is-disabled', locked);

  const work = dash.photos.work;
  const grid = $('#work-grid');
  const tiles = work.map((photo, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'work-tile';
    b.dataset.index = String(i);
    b.disabled = dash.status === 'suspended';
    const img = document.createElement('img');
    img.src = photo.url;
    img.alt = `Foto e punës ${i + 1}`;
    img.loading = 'lazy';
    img.decoding = 'async';
    b.append(img);
    li.append(b);
    return li;
  });
  for (const p of pending) {
    const li = document.createElement('li');
    li.className = 'work-tile is-pending';
    if (p.url) {
      const img = document.createElement('img');
      img.src = p.url;
      img.alt = '';
      li.append(img);
    }
    const label = document.createElement('span');
    label.className = 'work-progress';
    label.textContent = p.label;
    li.append(label);
    tiles.push(li);
  }
  grid.replaceChildren(...tiles);
  grid.hidden = tiles.length === 0;
  $('#work-count').textContent = String(work.length);
  const full = work.length + pending.length >= 12;
  $('#work-input').disabled = locked || full;
  $('#work-pick').hidden = full;
  $('#work-pick').classList.toggle('is-disabled', locked);
}

function photoMessage(err) {
  return PHOTO_ERRORS[err && err.code] || PHOTO_ERRORS.unreadable;
}

$('#avatar-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  // The status line is announced; the percentage beside it is only shown, so a screen reader isn't flooded.
  const status = $('#avatar-status');
  const progress = $('#avatar-progress');
  status.textContent = 'Po përgatitet fotoja…';
  let blob;
  try {
    ({ blob } = await shrinkPhoto(file, { square: true, squareSize: 800, minEdge: 200 }));
  } catch (err) {
    status.textContent = photoMessage(err);
    return;
  }
  status.textContent = 'Po ngarkohet…';
  const { data } = await uploadJpeg('/api/mjeshtri/foto?lloji=profili', blob, (f) => {
    progress.textContent = `${Math.round(f * 100)}%`;
  });
  progress.textContent = '';
  if (!data.ok) { status.textContent = data.message || GENERIC; return; }
  status.textContent = '';
  apply(data.dashboard);
  toast('Foto e profilit u ruajt.');
});

$('#work-input').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
  const status = $('#work-status');
  const room = 12 - dash.photos.work.length - pending.length;
  const take = files.slice(0, Math.max(0, room));
  status.textContent = files.length > take.length ? `U zgjodhën vetëm ${take.length} nga ${files.length}: ka vend për 12 foto.` : '';
  const jobs = take.map((file, i) => ({ id: `${Date.now()}-${i}`, file, url: '', label: 'Në pritje…' }));
  pending.push(...jobs);
  renderPhotos();
  let failed = 0;
  let lastError = '';
  for (const job of jobs) {
    job.label = 'Po përgatitet…';
    renderPhotos();
    let blob = null;
    try {
      ({ blob } = await shrinkPhoto(job.file, { maxEdge: 1600, minEdge: 300 }));
    } catch (err) {
      lastError = photoMessage(err);
    }
    if (blob) {
      job.url = URL.createObjectURL(blob);
      const { data } = await uploadJpeg('/api/mjeshtri/foto?lloji=pune', blob, (f) => {
        job.label = `${Math.round(f * 100)}%`;
        const tile = $('#work-grid .is-pending .work-progress');
        if (tile && pending[0] === job) tile.textContent = job.label;
      });
      URL.revokeObjectURL(job.url);
      pending.splice(pending.indexOf(job), 1);
      if (data.ok) { apply(data.dashboard); continue; }
      lastError = data.message || GENERIC;
      if (data.signedOut) break;
    } else {
      pending.splice(pending.indexOf(job), 1);
    }
    failed++;
    renderPhotos();
  }
  pending.length = 0;
  if (dash) renderPhotos();
  const ok = take.length - failed;
  if (failed) status.textContent = `${ok ? `U shtuan ${ok} foto. ` : ''}${failed === 1 ? 'Një foto nuk u shtua' : `${failed} foto nuk u shtuan`}: ${lastError}`;
  else if (ok) toast(ok === 1 ? 'Fotoja u shtua.' : `U shtuan ${ok} foto.`);
});

// One work photo, in a dialog: move it or delete it.
const sheet = $('#photo-sheet');
let sheetIndex = -1;
let sheetOpener = null;

function openSheet(i) {
  sheetIndex = i;
  const work = dash.photos.work;
  $('#photo-sheet-img').src = work[i].url;
  $('#photo-sheet-img').alt = `Foto e punës ${i + 1}`;
  $('#photo-sheet-n').textContent = String(i + 1);
  $('#photo-sheet-total').textContent = String(work.length);
  sheet.querySelector('[data-photo="first"]').disabled = i === 0;
  sheet.querySelector('[data-photo="left"]').disabled = i === 0;
  sheet.querySelector('[data-photo="right"]').disabled = i === work.length - 1;
  askDelete(false);
  setError($('#photo-sheet-error'), '');
  if (!sheet.open) {
    if (typeof sheet.showModal === 'function') sheet.showModal(); else sheet.setAttribute('open', '');
  }
}

// "Fshije foton" asks inside the sheet ("Po, fshije" / "Jo, mbaje") instead of the browser's own confirm box.
function askDelete(on) {
  $('#photo-sheet-confirm').hidden = !on;
  sheet.querySelector('.sheet-actions').hidden = on;
  if (on) sheet.querySelector('[data-photo="keep"]').focus();
}

function closeSheet() {
  if (typeof sheet.close === 'function') sheet.close(); else sheet.removeAttribute('open');
}

$('#work-grid').addEventListener('click', (e) => {
  const tile = e.target.closest('button.work-tile');
  if (!tile) return;
  sheetOpener = tile;
  openSheet(Number(tile.dataset.index));
});

sheet.addEventListener('close', () => {
  const tile = sheetOpener && document.querySelector(`button.work-tile[data-index="${sheetOpener.dataset.index}"]`);
  (tile || $('#work-pick')).focus();
  sheetOpener = null;
});

sheet.addEventListener('click', async (e) => {
  const action = e.target.closest('[data-photo]')?.dataset.photo;
  if (!action) return;
  if (action === 'close') { closeSheet(); return; }
  if (action === 'delete') { askDelete(true); return; }
  if (action === 'keep') { askDelete(false); sheet.querySelector('[data-photo="delete"]').focus(); return; }
  const ids = dash.photos.work.map((p) => p.id);
  const i = sheetIndex;
  let to = i;
  if (action === 'delete-yes') {
    const { data } = await api('/api/mjeshtri/foto/fshi', { id: ids[i] });
    if (!data.ok) { setError($('#photo-sheet-error'), data.message || GENERIC); return; }
    apply(data.dashboard);
    sheetOpener = null;
    closeSheet();
    toast('Fotoja u fshi.');
    return;
  }
  if (action === 'first') to = 0;
  if (action === 'left') to = i - 1;
  if (action === 'right') to = i + 1;
  if (to < 0 || to >= ids.length || to === i) return;
  const [moved] = ids.splice(i, 1);
  ids.splice(to, 0, moved);
  const { data } = await api('/api/mjeshtri/foto/renditja', { ids });
  if (!data.ok) { setError($('#photo-sheet-error'), data.message || GENERIC); return; }
  apply(data.dashboard);
  sheetOpener = { dataset: { index: String(to) } };
  openSheet(to);
  toast(to === 0 ? 'Tani është fotoja e parë.' : `Tani është fotoja ${to + 1}.`);
});

// ---------- Llogaria ----------

async function signOut() {
  const { data } = await api('/api/mjeshtri/dil', {});
  if (!data.ok) { setError($('#signout-error'), data.message || GENERIC); return; }
  window.dispatchEvent(new CustomEvent('rr:left', { detail: { message: '' } }));
}

document.querySelector('[data-action="signout"]').addEventListener('click', () => signOut());

const outSheet = $('#signout-sheet');
document.querySelector('[data-action="signout-all"]').addEventListener('click', () => {
  setError($('#signout-sheet-error'), '');
  if (typeof outSheet.showModal === 'function') outSheet.showModal(); else outSheet.setAttribute('open', '');
});
document.querySelector('[data-action="signout-all-cancel"]').addEventListener('click', () => outSheet.close());
outSheet.addEventListener('close', () => {
  if (isOpen) document.querySelector('[data-action="signout-all"]').focus();
});
$('#signout-all-go').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  busy(btn, true);
  const { data } = await api('/api/mjeshtri/dil', { all: true });
  busy(btn, false);
  if (!data.ok) { setError($('#signout-sheet-error'), data.message || GENERIC); return; }
  isOpen = false;
  outSheet.close();
  window.dispatchEvent(new CustomEvent('rr:left', { detail: { message: 'Dole nga të gjitha pajisjet.' } }));
});

const delSheet = $('#delete-sheet');
const delConfirm = $('#delete-confirm');
const delGo = $('#delete-go');

document.querySelector('[data-action="delete-open"]').addEventListener('click', () => {
  delConfirm.checked = false;
  delGo.disabled = true;
  setError($('#delete-error'), '');
  if (typeof delSheet.showModal === 'function') delSheet.showModal(); else delSheet.setAttribute('open', '');
});
document.querySelector('[data-action="delete-cancel"]').addEventListener('click', () => delSheet.close());
delSheet.addEventListener('close', () => {
  if (isOpen) document.querySelector('[data-action="delete-open"]').focus();
});
delConfirm.addEventListener('change', () => { delGo.disabled = !delConfirm.checked; });
delGo.addEventListener('click', async () => {
  busy(delGo, true);
  const { data } = await api('/api/mjeshtri/fshi', { confirm: 'FSHIJE' });
  busy(delGo, false);
  if (!data.ok) { delGo.disabled = !delConfirm.checked; setError($('#delete-error'), data.message || GENERIC); return; }
  isOpen = false;
  delSheet.close();
  window.dispatchEvent(new CustomEvent('rr:left', { detail: { message: 'Llogaria jote u fshi bashkë me profilin dhe fotot.' } }));
});
