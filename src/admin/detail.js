// The team's view of one mjeshtër (#m/<id>): the state and the decisions that apply to it, the profile form,
// the photos and the history. The server answers every change with the whole mjeshtër, and the view redraws from that.
// Mjeshtër-written text only ever goes into the page through textContent or attribute setters.

import { GENERIC, api, uploadJpeg } from '/mjeshtri/api.js';
import { LIMITS, TOWNS, TRADES, labelOf } from '/mjeshtri/catalog.js';
import { shrinkPhoto } from '/mjeshtri/photo.js';
import {
  $, MISSING, busy, closeSheet, dateTime, fold, initials, isBusy, openSheet, setError, since, toast,
} from './util.js';

const MAX_WORK = 12;
const NOTE_MIN = 3;
const NOTE_MAX = 300;
const E164 = /^\+[1-9]\d{6,14}$/;

let me = { smsEnabled: false, photosEnabled: false };
let pro = null;           // the last state of the open mjeshtër from the server
let openId = '';          // the mjeshtër in view, also while it loads
let isOpen = false;
let loadSeq = 0;          // only the newest load may draw
let backHref = '#lista';
let saved = '';           // the profile form as last loaded or saved (JSON), to spot unsaved changes
let saving = false;
const drafts = new Map(); // unsaved profile changes left behind in this tab, by mjeshtër id
const queue = [];         // work photos waiting or on their way up, oldest first: { proId, file, url, label }
let pumping = false;

const view = $('[data-page="detail"]');
const title = $('#d-title');

export function setMe(value) { me = value; }

/** Anything the team would lose by closing the tab. */
export const unsaved = () => (isOpen && dirty()) || drafts.size > 0 || queue.length > 0;

window.addEventListener('beforeunload', (e) => {
  if (unsaved()) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- opening and leaving ----------

export async function openDetail(id, { focus, back }) {
  backHref = back || '#lista';
  $('#d-back').href = backHref;
  if (isOpen && openId === id && pro) {
    if (focus) title.focus();
    return;
  }
  leaveDetail();
  isOpen = true;
  openId = id;
  title.textContent = 'Po hapet…';
  $('#d-meta').hidden = true;
  $('#d-body').hidden = true;
  setError($('#d-load-error'), '');
  if (focus) { window.scrollTo(0, 0); title.focus(); }

  const seq = ++loadSeq;
  const { status, data } = await api(`/api/admin/mjeshtri?id=${encodeURIComponent(id)}`);
  if (seq !== loadSeq || !isOpen || openId !== id) return;
  if (!data.ok || !data.pro) {
    title.textContent = status === 404 ? 'Ky mjeshtër nuk u gjet' : 'Mjeshtri nuk u hap';
    setError($('#d-load-error'), status === 404 ? 'Mund të jetë fshirë ndërkohë. Kthehu te lista.' : data.message || GENERIC);
    if (focus) refocus();
    return;
  }
  apply(data.pro, { refill: true });
  const draft = drafts.get(id);
  drafts.delete(id);
  if (draft) {
    setForm(draft);
    renderTownChips();
    onFormChange();
  }
  $('#d-meta').hidden = false;
  $('#d-body').hidden = false;
  if (focus) refocus();
}

// The heading had focus while it said "Po hapet…"; focusing it again makes screen readers read the name.
function refocus() {
  if (document.activeElement === title) title.blur();
  if (!document.activeElement || document.activeElement === document.body) title.focus();
}

/** Called before another view opens: unsaved profile changes are kept for when this mjeshtër is opened again. */
export function leaveDetail() {
  if (!isOpen) return;
  if (pro && dirty()) drafts.set(pro.id, readForm());
  isOpen = false;
  openId = '';
  pro = null;
  saved = '';
  for (const d of document.querySelectorAll('dialog[open]')) closeSheet(d);
  for (const id of ['d-avatar-status', 'd-avatar-progress', 'd-work-status']) document.getElementById(id).textContent = '';
  for (const id of ['d-decide-error', 'a-error', 'd-load-error']) setError(document.getElementById(id), '');
  form.reset();
  townOrder = [];
  for (const label of $('#a-towns-list').children) label.hidden = false;
  $('#a-towns-empty').hidden = true;
  clearFieldErrors();
}

/** On sign-out: nothing of the session is kept. */
export function closeDetail() {
  leaveDetail();
  drafts.clear();
  for (const job of queue) if (job.url) URL.revokeObjectURL(job.url);
  queue.length = 0;
}

/** Redraws the view from a mjeshtër state. The profile form is only refilled when it holds no unsaved changes. */
function apply(state, { refill = false } = {}) {
  pro = state;
  title.textContent = state.profile.name || 'Pa emër';
  const phone = $('#d-phone');
  phone.textContent = state.phone;
  if (E164.test(state.phoneE164 || '')) phone.href = `tel:${state.phoneE164}`; else phone.removeAttribute('href');
  $('#d-login').textContent = state.lastLoginAt ? `Hyri së fundi më ${dateTime(state.lastLoginAt)}` : 'Nuk ka hyrë ende';
  if (refill || !dirty()) fillForm(state.profile);
  $('#d-percent').textContent = String(state.checklist.percent);
  renderStatus();
  renderPhotos();
  renderReviews();
  renderHistory();
  updateLimits();
  renderSaveState();
}

// ---------- the state and the decisions ----------

const STATE_TITLES = {
  draft: 'Pa dërguar për shqyrtim',
  pending: 'Në pritje të shqyrtimit',
  approved: 'Aprovuar',
  rejected: 'Kthyer për ndryshime',
  suspended: 'Pezulluar',
};

function stateText(p) {
  switch (p.status) {
    case 'pending': return p.submittedAt ? `Dërguar më ${dateTime(p.submittedAt)}, në pritje prej ${since(p.submittedAt)}.` : 'Pret shqyrtimin e ekipit.';
    case 'approved': return p.approvedAt ? `Aprovuar më ${dateTime(p.approvedAt)}.` : '';
    case 'rejected': return 'Mjeshtri e sheh arsyen në panelin e tij dhe mund ta dërgojë prapë.';
    case 'suspended': return 'Profili nuk shfaqet te klientët dhe mjeshtri nuk mund ta ndryshojë.';
    default: return p.lastLoginAt
      ? 'Mjeshtri nuk e ka dërguar ende. Kur profili të jetë gati, mund ta aprovosh edhe pa pritur.'
      : 'U shtua nga ekipi. Plotësoje profilin dhe fotot, pastaj aprovoje.';
  }
}

const can = {
  approve: (p) => ['draft', 'pending', 'rejected'].includes(p.status),
  seen: (p) => p.status === 'approved' && Boolean(p.changedSinceApproval),
  reject: (p) => p.status === 'pending' || p.status === 'approved',
  suspend: (p) => p.status !== 'suspended',
  unsuspend: (p) => p.status === 'suspended',
};

function missingItems(p) {
  return p.checklist.items.filter((i) => i.required && !i.done).map((i) => MISSING[i.key] || i.key);
}

// Why Aprovo (or "Shënoje si të kontrolluar") can't be pressed right now, or ''.
function approveBlock(action) {
  if (dirty()) return 'Ruaji ndryshimet para se ta aprovosh.';
  if (action === 'approve' && !pro.checklist.ready) return 'Plotësoji pikat që mungojnë para se ta aprovosh.';
  return '';
}

function renderStatus() {
  const p = pro;
  // Chrome drops focus as soon as the focused button is hidden, so note where it was before anything changes.
  const before = document.activeElement;
  $('#d-state').dataset.state = p.status;
  $('#d-state-title').textContent = STATE_TITLES[p.status] || p.status;
  $('#d-state-text').textContent = stateText(p);
  const changed = $('#d-state-changed');
  changed.hidden = !p.changedSinceApproval;
  changed.textContent = p.changedSinceApproval
    ? `Mjeshtri e ndryshoi profilin pas aprovimit${p.editedAt ? ` (më ${dateTime(p.editedAt)})` : ''}. Shikoje dhe shënoje si të kontrolluar.`
    : '';
  const note = (p.status === 'rejected' || p.status === 'suspended') && p.statusNote;
  $('#d-state-note').hidden = !note;
  $('#d-state-note-text').textContent = note || '';
  $('#d-public').hidden = !p.publicPath;
  if (p.publicPath) $('#d-public-a').href = p.publicPath;
  $('#d-verified-mark').hidden = !p.verified;
  $('#d-verify').setAttribute('aria-checked', String(Boolean(p.verified)));

  const missing = can.approve(p) ? missingItems(p) : [];
  $('#d-missing').hidden = missing.length === 0;
  $('#d-missing-list').replaceChildren(...missing.map((m) => {
    const li = document.createElement('li');
    li.textContent = m;
    return li;
  }));

  $('#d-approve-box').hidden = !can.approve(p);
  $('#d-seen').hidden = !can.seen(p);
  $('#d-notify-row').hidden = !(me.smsEnabled && can.approve(p));
  $('#d-reject').hidden = !can.reject(p);
  $('#d-unsuspend').hidden = !can.unsuspend(p);
  $('#d-suspend').hidden = !can.suspend(p);
  // A button that just did its job may be gone now: keep focus on the state, not lost at the top of the page.
  if (before && before !== document.body && view.contains(before) && before.closest('[hidden]')) $('#d-status-title').focus();
  renderApprove();
}

function renderApprove() {
  if (!pro) return;
  const hint = $('#d-approve-hint');
  const action = can.approve(pro) ? 'approve' : 'seen';
  const reason = approveBlock(action);
  for (const btn of [$('#d-approve'), $('#d-seen')]) {
    if (isBusy(btn)) continue;
    if (reason) btn.setAttribute('aria-disabled', 'true'); else btn.removeAttribute('aria-disabled');
  }
  hint.textContent = reason;
  hint.hidden = !reason;
  // The hint sits under Aprovo; for "Shënoje si të kontrolluar" it moves under that button.
  const seen = $('#d-seen');
  if (!seen.hidden) seen.after(hint); else $('#d-approve').after(hint);
}

function smsText(sms) {
  switch (sms) {
    case 'sent': return ' Mjeshtri u njoftua me SMS.';
    case 'failed': return ' SMS-ja nuk u dërgua.';
    case 'capped': return ' SMS-ja nuk u dërgua: u arrit kufiri i SMS-ve për sot.';
    default: return '';
  }
}

/** Sends one decision. Resolves { status, data }, or null when the view moved on to another mjeshtër meanwhile. */
async function decide(action, extra, btn) {
  const id = pro.id;
  setError($('#d-decide-error'), '');
  busy(btn, true);
  const res = await api('/api/admin/vendim', { id, action, ...extra });
  busy(btn, false);
  if (!isOpen || openId !== id) return null;
  if (res.data.pro) apply(res.data.pro);
  else renderApprove();
  return res;
}

function decisionFailed(data) {
  if (data.missing && data.missing.length) {
    setError($('#d-decide-error'), `Para se ta aprovosh, plotësoji: ${data.missing.map((k) => MISSING[k] || k).join(', ')}.`);
  } else {
    setError($('#d-decide-error'), data.message || GENERIC);
  }
}

async function approveLike(action, btn) {
  if (isBusy(btn)) return;
  const reason = approveBlock(action);
  if (reason) { setError($('#d-decide-error'), reason); return; }
  const extra = { seenEditedAt: pro.editedAt ?? null };
  if (action === 'approve' && me.smsEnabled) extra.notify = $('#d-notify').checked;
  const res = await decide(action, extra, btn);
  if (!res) return;
  if (!res.data.ok) { decisionFailed(res.data); return; }
  toast(`${res.data.message || 'U ruajt.'}${smsText(res.data.sms)}`);
}

$('#d-approve').addEventListener('click', (e) => approveLike('approve', e.currentTarget));
$('#d-seen').addEventListener('click', (e) => approveLike('seen', e.currentTarget));

$('#d-unsuspend').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (isBusy(btn)) return;
  const res = await decide('unsuspend', {}, btn);
  if (!res) return;
  if (!res.data.ok) { decisionFailed(res.data); return; }
  toast(res.data.message || 'Pezullimi u hoq.');
});

$('#d-verify').addEventListener('click', async (e) => {
  const sw = e.currentTarget;
  if (sw.getAttribute('aria-busy') === 'true' || !pro) return;
  const before = Boolean(pro.verified);
  const id = pro.id;
  sw.setAttribute('aria-checked', String(!before));
  sw.setAttribute('aria-busy', 'true');
  setError($('#d-decide-error'), '');
  const { data } = await api('/api/admin/vendim', { id, action: before ? 'unverify' : 'verify' });
  sw.removeAttribute('aria-busy');
  if (!isOpen || openId !== id) return;
  if (data.pro) apply(data.pro);
  if (!data.ok) {
    sw.setAttribute('aria-checked', String(Boolean(pro.verified)));
    decisionFailed(data);
    return;
  }
  toast(data.message || (before ? 'Shenja «Verifikuar» u hoq.' : 'U shënua «Verifikuar».'));
});

// ---------- the reason dialogs: send back, suspend ----------

function reasonDialog(kind, action) {
  const sheet = $(`#${kind}-sheet`);
  const note = $(`#${kind}-note`);
  const internal = $(`#${kind}-internal`);
  const notify = $(`#${kind}-notify`);
  const go = $(`#${kind}-go`);
  const opener = $(`#d-${kind}`);

  opener.addEventListener('click', () => {
    $(`#${kind}-form`).reset();
    setError($(`#${kind}-note-error`), '');
    note.removeAttribute('aria-invalid');
    setError($(`#${kind}-error`), '');
    if (notify) $(`#${kind}-notify-row`).hidden = !me.smsEnabled;
    openSheet(sheet);
    note.focus();
  });
  sheet.querySelector('[data-close]').addEventListener('click', () => closeSheet(sheet));
  sheet.addEventListener('close', () => {
    if (!isOpen) return;
    (opener.hidden ? $('#d-status-title') : opener).focus();
  });

  $(`#${kind}-form`).addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isBusy(go) || !pro) return;
    setError($(`#${kind}-note-error`), '');
    setError($(`#${kind}-error`), '');
    note.removeAttribute('aria-invalid');
    const text = note.value.trim();
    const bad = text.length < NOTE_MIN
      ? 'Shkruaje arsyen, të paktën 3 shkronja.'
      : text.length > NOTE_MAX ? `Arsyeja mund të ketë deri në ${NOTE_MAX} shkronja.` : '';
    if (bad) {
      setError($(`#${kind}-note-error`), bad);
      note.setAttribute('aria-invalid', 'true');
      note.focus();
      return;
    }
    const extra = { note: text, internalNote: internal.value.trim() };
    if (notify && me.smsEnabled) extra.notify = notify.checked;
    const res = await decide(action, extra, go);
    if (!res) return;
    const { status, data } = res;
    if (data.ok) {
      closeSheet(sheet);
      toast(`${data.message || 'U ruajt.'}${smsText(data.sms)}`);
      return;
    }
    if (data.field === 'note') {
      setError($(`#${kind}-note-error`), data.message);
      note.setAttribute('aria-invalid', 'true');
      note.focus();
    } else if (status === 409) {
      // Someone else changed the state meanwhile: the view now shows the fresh state, and the message says why.
      closeSheet(sheet);
      decisionFailed(data);
    } else {
      setError($(`#${kind}-error`), data.message || GENERIC);
    }
  });
}

reasonDialog('reject', 'reject');
reasonDialog('suspend', 'suspend');

// ---------- deleting ----------

const removeSheet = $('#remove-sheet');
const removeInput = $('#remove-confirm');
const removeGo = $('#remove-go');
const typedOk = () => removeInput.value.trim().toUpperCase() === 'FSHIJE';

$('#d-remove').addEventListener('click', () => {
  $('#remove-form').reset();
  removeGo.disabled = true;
  setError($('#remove-error'), '');
  $('#remove-text').textContent = pro.status === 'suspended'
    ? 'Profili, fotot dhe numrat e thirrjeve fshihen përgjithmonë. Numri mbetet i pezulluar, që të mos hapet prapë një llogari me të.'
    : 'Profili, fotot, numrat e thirrjeve dhe historia fshihen përgjithmonë, dhe mjeshtri del nga çdo telefon. Kjo nuk kthehet mbrapsht.';
  openSheet(removeSheet);
  removeInput.focus();
});
removeSheet.querySelector('[data-close]').addEventListener('click', () => closeSheet(removeSheet));
removeSheet.addEventListener('close', () => { if (isOpen) $('#d-remove').focus(); });
removeInput.addEventListener('input', () => { if (!isBusy(removeGo)) removeGo.disabled = !typedOk(); });

$('#remove-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (isBusy(removeGo) || !typedOk() || !pro) return;
  const id = pro.id;
  setError($('#remove-error'), '');
  busy(removeGo, true);
  const { data } = await api('/api/admin/fshi', { id, confirm: 'FSHIJE' });
  busy(removeGo, false);
  if (!isOpen || openId !== id) return;
  if (!data.ok) { setError($('#remove-error'), data.message || GENERIC); return; }
  saved = '';               // nothing left to keep as a draft
  drafts.delete(id);
  closeSheet(removeSheet);
  toast(data.message || 'Mjeshtri u fshi.');
  location.hash = backHref;
});

// ---------- the profile form ----------

const form = $('#a-form');
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
  $('#a-trades-list').append(label);
}
for (const t of TOWNS) {
  const { label, input } = chip('towns', t, 'town');
  label.dataset.search = fold(t.label);
  townBoxes.push(input);
  $('#a-towns-list').append(label);
}

function readForm() {
  const v = (id) => document.getElementById(id).value;
  return {
    name: v('a-name').trim(),
    about: v('a-about').trim(),
    trades: tradeBoxes.filter((b) => b.checked).map((b) => b.value),
    towns: townOrder.slice(),
    years: v('a-years').trim(),
    priceNote: v('a-price').trim(),
    whatsapp: $('#a-whatsapp').checked,
    viber: $('#a-viber').checked,
  };
}

function setForm(p) {
  $('#a-name').value = p.name;
  $('#a-about').value = p.about;
  for (const b of tradeBoxes) b.checked = p.trades.includes(b.value);
  townOrder = p.towns.filter((t) => townBoxes.some((b) => b.value === t));
  for (const b of townBoxes) b.checked = townOrder.includes(b.value);
  $('#a-years').value = p.years === null || p.years === undefined ? '' : String(p.years);
  $('#a-price').value = p.priceNote;
  $('#a-whatsapp').checked = p.whatsapp;
  $('#a-viber').checked = p.viber;
}

function fillForm(p) {
  setForm(p);
  saved = JSON.stringify(readForm());
  clearFieldErrors();
  renderTownChips();
}

const dirty = () => Boolean(saved) && JSON.stringify(readForm()) !== saved;

function updateLimits() {
  const nTrades = tradeBoxes.filter((b) => b.checked).length;
  for (const b of tradeBoxes) b.disabled = !b.checked && nTrades >= LIMITS.maxTrades;
  $('#a-trades-count').textContent = `${nTrades} nga ${LIMITS.maxTrades}`;
  const nTowns = townOrder.length;
  for (const b of townBoxes) b.disabled = !b.checked && nTowns >= LIMITS.maxTowns;
  $('#a-towns-count').textContent = `${nTowns} nga ${LIMITS.maxTowns}`;
  $('#a-about-count').textContent = `${$('#a-about').value.length}/${LIMITS.about}`;
}

function renderTownChips() {
  const box = $('#a-towns-selected');
  box.replaceChildren(...townOrder.map((slug) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip-on';
    b.dataset.town = slug;
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

$('#a-towns-selected').addEventListener('click', (e) => {
  const b = e.target.closest('[data-town]');
  if (!b) return;
  const slug = b.dataset.town;
  const next = b.nextElementSibling || b.previousElementSibling;
  townOrder = townOrder.filter((t) => t !== slug);
  const box = townBoxes.find((x) => x.value === slug);
  if (box) box.checked = false;
  renderTownChips();
  onFormChange();
  const again = next && $(`#a-towns-selected [data-town="${next.dataset.town}"]`);
  (again || $('#a-towns-filter')).focus();
});

$('#a-towns-list').addEventListener('change', (e) => {
  const box = e.target;
  if (box.checked && !townOrder.includes(box.value)) townOrder.push(box.value);
  if (!box.checked) townOrder = townOrder.filter((t) => t !== box.value);
  renderTownChips();
});

$('#a-towns-filter').addEventListener('input', (e) => {
  const q = fold(e.target.value.trim());
  let shown = 0;
  for (const label of $('#a-towns-list').children) {
    const match = !q || label.dataset.search.includes(q);
    label.hidden = !match;
    if (match) shown++;
  }
  $('#a-towns-empty').hidden = shown > 0;
});
// Enter in the town search ticks the only match instead of submitting the form.
$('#a-towns-filter').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const visible = [...$('#a-towns-list').children].filter((l) => !l.hidden);
  if (visible.length === 1) visible[0].querySelector('input').click();
});

$('#a-years').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 2); });

function renderSaveState() {
  const isDirty = dirty();
  const save = $('#a-save');
  if (saving || !isDirty) save.setAttribute('aria-disabled', 'true');
  else save.removeAttribute('aria-disabled');
  const text = isDirty ? 'Ndryshime të paruajtura' : 'Gjithçka është ruajtur';
  if ($('#a-save-state').textContent !== text) $('#a-save-state').textContent = text;
  $('#a-save-bar').classList.toggle('is-dirty', isDirty);
}

function onFormChange() {
  if (!pro) return;
  updateLimits();
  renderSaveState();
  renderApprove();
}
form.addEventListener('input', onFormChange);
form.addEventListener('change', onFormChange);

const FIELD_ERRORS = { name: 'a-name', about: 'a-about', trades: 'a-trades', towns: 'a-towns', years: 'a-years', priceNote: 'a-price' };

function clearFieldErrors() {
  for (const id of Object.values(FIELD_ERRORS)) {
    setError(document.getElementById(`${id}-error`), '');
    document.getElementById(id).removeAttribute('aria-invalid');
  }
  setError($('#a-error'), '');
}

function focusField(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const target = el.matches('fieldset') ? el.querySelector('input:not([disabled])') : el;
  if (target) { target.focus(); target.scrollIntoView({ block: 'center' }); }
}

async function saveForm() {
  if (saving || !pro) return;
  clearFieldErrors();
  const body = readForm();
  const sent = JSON.stringify(body);
  if (body.years && Number(body.years) > LIMITS.maxYears) {
    setError($('#a-years-error'), `Shkruaji vitet nga 0 deri në ${LIMITS.maxYears}.`);
    $('#a-years').setAttribute('aria-invalid', 'true');
    focusField('a-years');
    return;
  }
  const id = pro.id;
  const btn = $('#a-save');
  saving = true;
  busy(btn, true);
  const { data } = await api('/api/admin/profili', { ...body, id });
  saving = false;
  busy(btn, false);
  if (!isOpen || openId !== id) return;
  if (!data.ok) {
    renderSaveState();
    if (data.errors) {
      let first = null;
      for (const [field, message] of Object.entries(data.errors)) {
        const fid = FIELD_ERRORS[field];
        if (!fid) continue;
        setError(document.getElementById(`${fid}-error`), message);
        document.getElementById(fid).setAttribute('aria-invalid', 'true');
        first = first || fid;
      }
      setError($('#a-error'), data.message || GENERIC);
      if (first) focusField(first);
    } else {
      setError($('#a-error'), data.message || GENERIC);
    }
    return;
  }
  // Anything typed while the save was on its way stays in the form, still marked as unsaved.
  const typedSince = JSON.stringify(readForm()) !== sent;
  if (typedSince) saved = sent;
  if (data.pro) apply(data.pro, { refill: !typedSince });
  else renderSaveState();
  toast(data.message || 'U ruajt.');
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (dirty()) saveForm();
});

// ---------- photos ----------

const PHOTO_ERRORS = {
  unreadable: 'Kjo foto nuk u hap. Zgjidh një foto JPG ose PNG.',
  too_small: 'Kjo foto është shumë e vogël. Zgjidh një foto më të madhe.',
  too_big: 'Kjo foto është shumë e madhe. Zgjidh një foto tjetër.',
  too_wide: 'Kjo foto është shumë e gjatë dhe e ngushtë. Zgjidh një foto tjetër.',
};
const photoMessage = (err) => PHOTO_ERRORS[err && err.code] || PHOTO_ERRORS.unreadable;

function photoInto(box, photo, fallbackInitials) {
  const img = box.querySelector('img');
  const letters = box.querySelector('.pp-initials');
  if (photo) {
    const el = img || document.createElement('img');
    if (!img) { el.alt = ''; el.decoding = 'async'; box.prepend(el); }
    if (el.getAttribute('src') !== photo.url) el.src = photo.url;
    letters.hidden = true;
  } else {
    if (img) img.remove();
    letters.hidden = false;
    letters.textContent = fallbackInitials;
  }
}

function renderPhotos() {
  const off = !(typeof pro.photosEnabled === 'boolean' ? pro.photosEnabled : me.photosEnabled);
  $('#d-photos-off').hidden = !off;
  const profile = pro.photos.profile;
  photoInto($('#d-avatar'), profile, initials(pro.profile.name));
  $('#d-avatar-pick').textContent = profile ? 'Ndrysho foton' : 'Zgjidh foton';
  $('#d-avatar-input').disabled = off;
  $('#d-avatar-pick').classList.toggle('is-disabled', off);
  const del = $('#d-avatar-delete');
  if (!profile && document.activeElement === del) $('#d-avatar-title').focus();
  del.hidden = !profile;

  const work = pro.photos.work;
  const mine = queue.filter((j) => j.proId === pro.id);
  const tiles = work.map((photo, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'work-tile';
    b.dataset.index = String(i);
    const img = document.createElement('img');
    img.src = photo.url;
    img.alt = `Foto e punës ${i + 1}`;
    img.loading = 'lazy';
    img.decoding = 'async';
    b.append(img);
    li.append(b);
    return li;
  });
  for (const job of mine) {
    const li = document.createElement('li');
    li.className = 'work-tile is-pending';
    if (job.url) {
      const img = document.createElement('img');
      img.src = job.url;
      img.alt = '';
      li.append(img);
    }
    const label = document.createElement('span');
    label.className = 'work-progress';
    label.textContent = job.label;
    li.append(label);
    tiles.push(li);
  }
  const grid = $('#d-work-grid');
  grid.replaceChildren(...tiles);
  grid.hidden = tiles.length === 0;
  $('#d-work-count').textContent = String(work.length);
  const full = work.length + mine.length >= MAX_WORK;
  // Never disable the file picker while it has focus: focus would drop to the top of the page.
  if ((off || full) && document.activeElement === $('#d-work-input')) $('#d-work-title').focus();
  $('#d-work-input').disabled = off || full;
  $('#d-work-pick').hidden = full;
  $('#d-work-pick').classList.toggle('is-disabled', off);
}

$('#d-avatar-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file || !pro) return;
  const id = pro.id;
  // The status line is announced; the percentage beside it is only shown, so a screen reader isn't flooded.
  const status = $('#d-avatar-status');
  const progress = $('#d-avatar-progress');
  status.textContent = 'Po përgatitet fotoja…';
  let blob;
  try {
    ({ blob } = await shrinkPhoto(file, { square: true, squareSize: 800, minEdge: 200 }));
  } catch (err) {
    if (openId === id) status.textContent = photoMessage(err);
    return;
  }
  if (openId !== id) return;
  status.textContent = 'Po ngarkohet…';
  const { data } = await uploadJpeg(`/api/admin/foto?id=${encodeURIComponent(id)}&lloji=profili`, blob, (f) => {
    if (openId === id) progress.textContent = `${Math.round(f * 100)}%`;
  });
  if (!isOpen || openId !== id) return;
  progress.textContent = '';
  if (!data.ok) { status.textContent = data.message || GENERIC; return; }
  status.textContent = '';
  if (data.pro) apply(data.pro);
  toast('Fotoja e profilit u ruajt.');
});

// Work photos go up one at a time from a single queue, so picking more while some are uploading just adds to it.
// A job remembers its mjeshtër: opening another one meanwhile doesn't send the photo to the wrong profile.
$('#d-work-input').addEventListener('change', (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length || !pro) return;
  const room = MAX_WORK - pro.photos.work.length - queue.filter((j) => j.proId === pro.id).length;
  const take = files.slice(0, Math.max(0, room));
  const chosen = take.length === 1 ? 'U zgjodh vetëm 1' : `U zgjodhën vetëm ${take.length}`;
  $('#d-work-status').textContent = files.length > take.length ? `${chosen} nga ${files.length}: një profil mund të ketë deri në 12 foto të punëve.` : '';
  queue.push(...take.map((file) => ({ proId: pro.id, file, url: '', label: 'Në pritje…' })));
  renderPhotos();
  uploadQueue();
});

async function uploadQueue() {
  if (pumping) return;
  pumping = true;
  const tally = new Map();  // proId → { ok, failed, lastError }
  const redraw = (proId) => { if (isOpen && pro && pro.id === proId) renderPhotos(); };
  while (queue.length) {
    const job = queue[0];
    const t = tally.get(job.proId) || { ok: 0, failed: 0, lastError: '' };
    tally.set(job.proId, t);
    job.label = 'Po përgatitet…';
    redraw(job.proId);
    let blob = null;
    try {
      ({ blob } = await shrinkPhoto(job.file, { maxEdge: 1600, minEdge: 300, minOutEdge: 200, maxOutEdge: 2048 }));
    } catch (err) {
      t.lastError = photoMessage(err);
    }
    let data = null;
    if (blob && queue[0] === job) {
      job.url = URL.createObjectURL(blob);
      job.label = '0%';
      redraw(job.proId);
      ({ data } = await uploadJpeg(`/api/admin/foto?id=${encodeURIComponent(job.proId)}&lloji=pune`, blob, (f) => {
        job.label = `${Math.round(f * 100)}%`;
        const tile = $('#d-work-grid .is-pending .work-progress');
        if (tile && queue[0] === job && pro && pro.id === job.proId) tile.textContent = job.label;
      }));
    }
    const at = queue.indexOf(job);
    if (at === -1) break;     // signed out meanwhile: the queue was emptied
    queue.splice(at, 1);
    if (job.url) URL.revokeObjectURL(job.url);
    if (data && data.signedOut) break;
    if (data && data.ok) {
      t.ok++;
      if (isOpen && pro && pro.id === job.proId && data.pro) apply(data.pro); else redraw(job.proId);
    } else {
      t.failed++;
      if (data) t.lastError = data.message || GENERIC;
      redraw(job.proId);
    }
  }
  pumping = false;
  if (!isOpen || !pro) return;
  renderPhotos();
  const t = tally.get(pro.id);
  if (!t) return;
  if (t.failed) {
    $('#d-work-status').textContent = `${t.ok ? (t.ok === 1 ? 'U shtua 1 foto. ' : `U shtuan ${t.ok} foto. `) : ''}${t.failed === 1 ? 'Një foto nuk u shtua' : `${t.failed} foto nuk u shtuan`}: ${t.lastError}`;
  } else if (t.ok) {
    toast(t.ok === 1 ? 'Fotoja u shtua.' : `U shtuan ${t.ok} foto.`);
  }
}

// One photo in a dialog, to look at it bigger or delete it (the profile photo or a work photo).
const sheet = $('#photo-sheet');
let sheetPhoto = null;    // { kind: 'profile' | 'work', index, id }
let sheetBusy = false;

function askDelete(on) {
  $('#photo-sheet-confirm').hidden = !on;
  $('#photo-sheet-actions').hidden = on;
  sheet.querySelector(on ? '[data-photo="keep"]' : '[data-photo="delete"]').focus();
}

function showPhoto(kind, index) {
  const photo = kind === 'profile' ? pro.photos.profile : pro.photos.work[index];
  if (!photo) return;
  sheetPhoto = { kind, index, id: photo.id };
  $('#photo-sheet-title').textContent = kind === 'profile'
    ? 'Foto e profilit'
    : `Foto e punës ${index + 1} nga ${pro.photos.work.length}`;
  $('#photo-sheet-img').src = photo.url;
  $('#photo-sheet-img').alt = kind === 'profile' ? 'Foto e profilit' : `Foto e punës ${index + 1}`;
  setError($('#photo-sheet-error'), '');
  openSheet(sheet);
  askDelete(kind === 'profile');
}

$('#d-work-grid').addEventListener('click', (e) => {
  const tile = e.target.closest('button.work-tile');
  if (tile) showPhoto('work', Number(tile.dataset.index));
});
$('#d-avatar-delete').addEventListener('click', () => showPhoto('profile', 0));

sheet.addEventListener('close', () => {
  const was = sheetPhoto;
  sheetPhoto = null;
  if (!isOpen || !was) return;
  if (was.kind === 'profile') {
    const del = $('#d-avatar-delete');
    (del.hidden ? $('#d-avatar-pick') : del).focus();
    return;
  }
  const tiles = document.querySelectorAll('#d-work-grid button.work-tile');
  const tile = tiles[Math.min(was.index, tiles.length - 1)];
  (tile || (!$('#d-work-pick').hidden ? $('#d-work-pick') : $('#d-work-title'))).focus();
});

sheet.addEventListener('click', async (e) => {
  const action = e.target.closest('[data-photo]')?.dataset.photo;
  if (!action || (sheetBusy && action !== 'close')) return;
  if (action === 'close') { closeSheet(sheet); return; }
  if (action === 'delete') { askDelete(true); return; }
  if (action === 'keep') {
    if (sheetPhoto && sheetPhoto.kind === 'profile') closeSheet(sheet); else askDelete(false);
    return;
  }
  if (action !== 'delete-yes' || !sheetPhoto || !pro) return;
  const btn = e.target.closest('[data-photo]');
  const id = pro.id;
  sheetBusy = true;
  busy(btn, true);
  const { data } = await api('/api/admin/foto/fshi', { id, photoId: sheetPhoto.id });
  sheetBusy = false;
  busy(btn, false);
  if (!isOpen || openId !== id) return;
  if (!data.ok) { setError($('#photo-sheet-error'), data.message || GENERIC); return; }
  if (data.pro) apply(data.pro);
  closeSheet(sheet);
  toast('Fotoja u fshi.');
});

// ---------- reviews ----------

const starText = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);

function reviewButton(label, action, reviewId, ghost) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = ghost ? 'btn btn-ghost' : 'btn';
  b.textContent = label;
  b.dataset.reviewAction = action;
  b.dataset.reviewId = reviewId;
  return b;
}

function renderReviews() {
  const list = Array.isArray(pro.reviews) ? pro.reviews : [];
  const shown = list.filter((r) => !r.hidden);
  const reported = list.filter((r) => r.reported && !r.hidden).length;
  const avg = shown.length ? shown.reduce((t, r) => t + r.stars, 0) / shown.length : 0;
  $('#d-reviews-meta').textContent = shown.length
    ? `${avg.toFixed(1).replace('.', ',')} ★ · ${shown.length}${reported ? ` · ${reported} të raportuara` : ''}`
    : '';
  setError($('#d-reviews-error'), '');
  // Reported ones first, so they are not missed.
  const ordered = list.slice().sort((a, b) => (Number(b.reported && !b.hidden) - Number(a.reported && !a.hidden)) || b.at - a.at);
  $('#d-reviews').replaceChildren(...ordered.map((r) => {
    const li = document.createElement('li');
    li.className = r.hidden ? 'review-admin-item is-hidden' : 'review-admin-item';
    const stars = document.createElement('p');
    stars.className = 'review-admin-stars';
    stars.textContent = starText(r.stars);
    stars.setAttribute('aria-label', `${r.stars} nga 5 yje`);
    li.append(stars, line('review-admin-who', '', `${r.author || 'Klient'} · ${dateTime(r.at)}${r.hidden ? ' · I fshehur' : ''}`));
    if (r.comment) li.append(line('review-admin-text', '', r.comment));
    if (r.reply) li.append(line('review-admin-reply', 'Përgjigja e mjeshtrit:', r.reply));
    const actions = document.createElement('div');
    actions.className = 'review-admin-actions';
    if (r.hidden) {
      actions.append(reviewButton('Shfaqe sërish', 'show', r.id, true));
    } else if (r.reported) {
      li.append(line('review-admin-flag', 'Mjeshtri e raportoi:', r.reportReason || 'Pa arsye.'));
      actions.append(reviewButton('Mbaje', 'keep', r.id, true), reviewButton('Fshihe', 'hide', r.id, false));
    } else {
      actions.append(reviewButton('Fshihe', 'hide', r.id, true));
    }
    li.append(actions);
    return li;
  }));
  $('#d-reviews').hidden = list.length === 0;
  $('#d-reviews-empty').hidden = list.length > 0;
}

$('#d-reviews').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-review-action]');
  if (!btn || isBusy(btn) || !pro) return;
  const id = pro.id;
  setError($('#d-reviews-error'), '');
  busy(btn, true);
  const { data } = await api('/api/admin/vleresim', { id, reviewId: btn.dataset.reviewId, action: btn.dataset.reviewAction });
  busy(btn, false);
  if (!isOpen || openId !== id) return;
  if (data.pro) apply(data.pro);
  if (!data.ok) { setError($('#d-reviews-error'), data.message || GENERIC); return; }
  toast(data.message || 'U ruajt.');
});

// ---------- history ----------

const ACTIONS = {
  created: 'E shtoi në Rregullo',
  profile: 'Ndryshoi profilin',
  photo: 'Ndryshoi fotot',
  approve: 'E aprovoi',
  reject: 'E ktheu për ndryshime',
  suspend: 'E pezulloi',
  unsuspend: 'Hoqi pezullimin',
  verify: 'E shënoi «Verifikuar»',
  unverify: 'Hoqi «Verifikuar»',
  seen: 'I shënoi ndryshimet si të kontrolluara',
  deleted: 'Fshiu profilin dhe fotot',
  review_keep: 'E la të dukshëm një vlerësim të raportuar',
  review_hide: 'Fshehu një vlerësim',
  review_show: 'E shfaqi sërish një vlerësim',
};

const DECISIONS = new Set(['approve', 'reject', 'suspend', 'unsuspend', 'verify', 'unverify', 'seen']);

function line(cls, label, text) {
  const p = document.createElement('p');
  p.className = cls;
  if (label) {
    const l = document.createElement('span');
    l.className = 'history-label';
    l.textContent = label;
    p.append(l, ' ');
  }
  p.append(text);
  return p;
}

function renderHistory() {
  $('#d-created').textContent = pro.createdAt ? `Llogaria u hap më ${dateTime(pro.createdAt)}.` : '';
  const log = Array.isArray(pro.log) ? pro.log.slice().sort((a, b) => b.at - a.at) : [];
  $('#d-history').replaceChildren(...log.map((row) => {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.append(line('history-what', '', ACTIONS[row.action] || row.action));
    li.append(line('history-who', '', `${row.admin} · ${dateTime(row.at)}`));
    if (row.publicNote) li.append(line('history-note', 'Arsyeja që sheh mjeshtri:', row.publicNote));
    // For the decisions the note is what a team member wrote for the team; elsewhere it says what changed.
    if (row.note && DECISIONS.has(row.action)) li.append(line('history-note is-internal', 'Shënim për ekipin:', row.note));
    else if (row.note) li.append(line('history-note', '', row.note));
    return li;
  }));
  $('#d-history').hidden = log.length === 0;
  $('#d-history-empty').hidden = log.length > 0;
}
