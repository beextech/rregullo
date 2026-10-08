// The team's ads (step 6): advertisers (#reklamat), one campaign (#fushata/<id>, or #fushata/re/<advertiser id> for
// a new one), its image, and the monthly report as a CSV download. Every change answers with the whole list again.
// Text from the database only ever goes into the page through textContent or attribute setters.

import { GENERIC, api, uploadJpeg } from '/mjeshtri/api.js';
import { TOWNS, TRADES, labelOf } from '/mjeshtri/catalog.js';
import { shrinkPhoto } from '/mjeshtri/photo.js';
import { $, busy, closeSheet, isBusy, openSheet, setError, toast } from './util.js';

const SLOTS = [['kerko', 'Kërkimi'], ['profili', 'Profilet'], ['loja', 'Lojërat'], ['paneli', 'Paneli i mjeshtrit']];
const STATE = { live: 'Aktive', scheduled: 'Pa filluar', ended: 'Mbaruar', off: 'E fikur' };

let ads = null;           // the last answer: { today, advertisers: [...] }
let campaign = null;      // the campaign open in the form, or null for a new one
let advertiserId = '';    // whose campaign it is
let seq = 0;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const thisMonth = () => new Date().toISOString().slice(0, 7);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const findCampaign = (id) => ads && ads.advertisers.flatMap((a) => a.campaigns).find((c) => c.id === id);
const findAdvertiser = (id) => ads && ads.advertisers.find((a) => a.id === id);
const num = (n) => n.toLocaleString('de-DE');

async function load() {
  const s = ++seq;
  const { data } = await api('/api/admin/reklamat', {});
  if (s !== seq) return null;
  if (!data.ok) return data;
  ads = data;
  return data;
}

// ---------- the list ----------

function targets(c) {
  const t = c.trades.length ? c.trades.map((x) => labelOf(TRADES, x)).join(', ') : 'Të gjitha zanatet';
  const w = c.towns.length ? (c.towns.length > 3 ? `${c.towns.length} komuna` : c.towns.map((x) => labelOf(TOWNS, x)).join(', ')) : 'Gjithë Kosova';
  return `${t} · ${w}`;
}

function campaignRow(c) {
  const li = el('li', 'ad-row');
  const a = el('a', 'ad-row-link');
  a.href = `#fushata/${encodeURIComponent(c.id)}`;
  const head = el('span', 'ad-row-head');
  head.append(el('span', 'ad-row-title', c.title));
  const chip = el('span', 'status-chip', STATE[c.state] || c.state);
  chip.dataset.state = c.state === 'live' ? 'approved' : c.state === 'off' || c.state === 'ended' ? 'draft' : 'pending';
  head.append(chip);
  a.append(head);
  a.append(el('span', 'row-line', `${c.startsOn} – ${c.endsOn} · ${c.slots.map((s) => (SLOTS.find((x) => x[0] === s) || [s, s])[1]).join(', ')}`));
  a.append(el('span', 'row-line', targets(c)));
  a.append(el('span', 'row-line', `30 ditët e fundit: ${num(c.views30)} shikime, ${num(c.clicks30)} klikime`));
  li.append(a);
  return li;
}

function advertiserCard(adv) {
  const card = el('section', 'panel adv-card');
  card.setAttribute('aria-label', adv.name);
  const head = el('div', 'panel-head');
  head.append(el('h2', 'panel-title', adv.name));
  const edit = el('button', 'pro-link', 'Ndrysho');
  edit.type = 'button';
  edit.addEventListener('click', () => openAdvertiser(adv));
  head.append(edit);
  card.append(head);
  if (adv.contact) card.append(el('p', 'pro-hint', `Kontakti: ${adv.contact}`));
  if (adv.campaigns.length) {
    const ul = el('ul', 'ad-rows');
    ul.append(...adv.campaigns.map(campaignRow));
    card.append(ul);
  } else {
    card.append(el('p', 'pro-hint', 'Ende asnjë reklamë.'));
  }
  const actions = el('div', 'adv-actions');
  const add = el('a', 'btn btn-ghost', 'Shto reklamë');
  add.href = `#fushata/re/${encodeURIComponent(adv.id)}`;
  actions.append(add);
  // The report: a plain link, so the browser downloads the CSV with the session cookie.
  const form = el('form', 'report-form');
  const label = el('label', 'pro-hint', 'Raporti për muajin');
  const month = el('input', 'field-input report-month');
  month.type = 'month';
  month.value = thisMonth();
  month.id = `report-${adv.id}`;
  label.htmlFor = month.id;
  const go = el('a', 'btn btn-ghost', 'Shkarko raportin (CSV)');
  const setHref = () => { go.href = `/api/admin/raporti?reklamuesi=${encodeURIComponent(adv.id)}&muaji=${encodeURIComponent(month.value || thisMonth())}`; };
  setHref();
  month.addEventListener('input', setHref);
  go.setAttribute('download', '');
  form.append(label, month, go);
  form.addEventListener('submit', (e) => e.preventDefault());
  actions.append(form);
  card.append(actions);
  return card;
}

function renderList() {
  const list = $('#ads-list');
  list.removeAttribute('aria-busy');
  list.replaceChildren(...ads.advertisers.map(advertiserCard));
  $('#ads-empty').hidden = ads.advertisers.length > 0;
}

export async function openAds(focus) {
  setError($('#ads-error'), '');
  if (focus) { window.scrollTo(0, 0); $('#ads-title').focus(); }
  const data = await load();
  if (!data) return;
  if (!data.ok) { setError($('#ads-error'), data.message || GENERIC); return; }
  renderList();
}

// ---------- an advertiser (the dialog) ----------

const advSheet = $('#adv-sheet');
let advEditing = null;

function openAdvertiser(adv) {
  advEditing = adv || null;
  $('#adv-sheet-title').textContent = adv ? 'Ndrysho reklamuesin' : 'Reklamues i ri';
  $('#adv-name').value = adv ? adv.name : '';
  $('#adv-contact').value = adv ? adv.contact : '';
  $('#adv-confirm').value = '';
  $('#adv-delete').disabled = true;
  $('#adv-delete-box').hidden = !adv;
  for (const id of ['adv-error', 'adv-name-error']) setError($(`#${id}`), '');
  openSheet(advSheet);
  $('#adv-name').focus();
}

$('#adv-new').addEventListener('click', () => openAdvertiser(null));
advSheet.querySelector('[data-close]').addEventListener('click', () => closeSheet(advSheet));
$('#adv-confirm').addEventListener('input', (e) => { $('#adv-delete').disabled = e.target.value.trim().toUpperCase() !== 'FSHIJE'; });

$('#adv-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#adv-go');
  if (isBusy(btn)) return;
  setError($('#adv-error'), '');
  setError($('#adv-name-error'), '');
  busy(btn, true);
  const { data } = await api('/api/admin/reklamuesi', { id: advEditing ? advEditing.id : null, name: $('#adv-name').value, contact: $('#adv-contact').value });
  busy(btn, false);
  if (!data.ok) {
    if (data.errors && data.errors.name) { setError($('#adv-name-error'), data.errors.name); $('#adv-name').focus(); } else setError($('#adv-error'), data.message || GENERIC);
    return;
  }
  ads = data;
  closeSheet(advSheet);
  renderList();
  toast(data.message);
});

$('#adv-delete').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (isBusy(btn) || !advEditing) return;
  busy(btn, true);
  const { data } = await api('/api/admin/reklamuesi/fshi', { id: advEditing.id, confirm: $('#adv-confirm').value.trim().toUpperCase() });
  busy(btn, false);
  if (!data.ok) { setError($('#adv-error'), data.message || GENERIC); return; }
  ads = data;
  closeSheet(advSheet);
  renderList();
  toast(data.message);
});

// ---------- one campaign ----------

function checks(box, items, name) {
  box.replaceChildren(...items.map(([value, label]) => {
    const l = el('label', 'check');
    const i = el('input', 'consent-box');
    i.type = 'checkbox';
    i.name = name;
    i.value = value;
    l.append(i, el('span', '', label));
    return l;
  }));
}
checks($('#c-slots'), SLOTS, 'slots');
checks($('#c-trades'), TRADES.map((t) => [t.slug, t.label]), 'trades');
checks($('#c-towns'), TOWNS.map((t) => [t.slug, t.label]), 'towns');

const checked = (name) => [...document.querySelectorAll(`#c-form input[name="${name}"]:checked`)].map((i) => i.value);
const setChecked = (name, values) => { for (const i of document.querySelectorAll(`#c-form input[name="${name}"]`)) i.checked = values.includes(i.value); };

function fill(c) {
  $('#c-text').value = c ? c.title : '';
  $('#c-link').value = c ? c.link : '';
  setChecked('slots', c ? c.slots : ['kerko', 'profili']);
  setChecked('trades', c ? c.trades : []);
  setChecked('towns', c ? c.towns : []);
  const today = (ads && ads.today) || new Date().toISOString().slice(0, 10);
  $('#c-start').value = c ? c.startsOn : today;
  $('#c-end').value = c ? c.endsOn : addDays(today, 29);
  $('#c-active').checked = c ? c.active : true;
}

function renderImage() {
  const img = $('#c-image');
  if (campaign && campaign.image) { img.src = campaign.image; img.hidden = false; } else { img.removeAttribute('src'); img.hidden = true; }
  $('#c-image-remove').hidden = !(campaign && campaign.image);
  $('#c-image-pick').hidden = !campaign;
  $('#c-image-hint').textContent = campaign
    ? 'Jo e detyrueshme. Pa foto, reklama shfaqet vetëm me tekst. Më mirë e gjerë, p.sh. 1200 × 600.'
    : 'Jo e detyrueshme. Fotoja ngarkohet pasi ta ruash reklamën.';
}

function renderPreview() {
  const box = el('aside', 'ad');
  const adv = findAdvertiser(advertiserId);
  box.append(el('p', 'ad-label', `Sponsorizuar · ${adv ? adv.name : ''}`));
  const a = el('span', 'ad-link');
  if (campaign && campaign.image) { const img = el('img', 'ad-img'); img.src = campaign.image; img.alt = ''; a.append(img); }
  a.append(el('span', 'ad-title', $('#c-text').value.trim() || 'Teksti i reklamës'), el('span', 'ad-cta', 'Shiko ofertën ↗'));
  box.append(a);
  $('#c-preview').replaceChildren(box);
}

function clearErrors() {
  for (const id of ['c-text-error', 'c-link-error', 'c-slots-error', 'c-dates-error', 'c-error', 'c-load-error', 'c-image-status']) {
    const e = $(`#${id}`);
    if (e.classList.contains('photo-status')) e.textContent = ''; else setError(e, '');
  }
}

export async function openCampaign({ id, advertiser }, focus) {
  clearErrors();
  $('#c-body').hidden = true;
  if (focus) { window.scrollTo(0, 0); $('#c-title').focus(); }
  if (!ads || (id && !findCampaign(id))) {
    const data = await load();
    if (!data) return;
    if (!data.ok) { setError($('#c-load-error'), data.message || GENERIC); return; }
  }
  campaign = id ? findCampaign(id) : null;
  advertiserId = campaign ? campaign.advertiserId : advertiser;
  const adv = findAdvertiser(advertiserId);
  if ((id && !campaign) || !adv) {
    $('#c-title').textContent = 'Nuk u gjet';
    setError($('#c-load-error'), 'Mund të jetë fshirë ndërkohë. Kthehu te reklamat.');
    return;
  }
  $('#c-advertiser').textContent = adv.name;
  $('#c-title').textContent = campaign ? campaign.title : 'Reklamë e re';
  $('#c-delete').hidden = !campaign;
  fill(campaign);
  renderImage();
  renderPreview();
  $('#c-body').hidden = false;
}

$('#c-form').addEventListener('input', renderPreview);

const FIELD = { title: ['c-text-error', 'c-text'], link: ['c-link-error', 'c-link'], slots: ['c-slots-error', null], dates: ['c-dates-error', 'c-start'] };

$('#c-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#c-save');
  if (isBusy(btn)) return;
  clearErrors();
  busy(btn, true);
  const body = {
    title: $('#c-text').value, link: $('#c-link').value.trim(), slots: checked('slots'), trades: checked('trades'), towns: checked('towns'),
    startsOn: $('#c-start').value, endsOn: $('#c-end').value, active: $('#c-active').checked,
  };
  if (campaign) body.id = campaign.id; else body.advertiserId = advertiserId;
  const { data } = await api('/api/admin/fushata', body);
  busy(btn, false);
  if (!data.ok) {
    const keys = Object.keys(data.errors || {});
    for (const k of keys) if (FIELD[k]) setError($(`#${FIELD[k][0]}`), data.errors[k]);
    if (!keys.length) setError($('#c-error'), data.message || GENERIC);
    const first = keys.length && FIELD[keys[0]] && FIELD[keys[0]][1];
    if (first) $(`#${first}`).focus();
    return;
  }
  ads = data;
  const wasNew = !campaign;
  campaign = data.campaign;
  toast(wasNew ? `${data.message} Tani mund t’i shtosh edhe një foto.` : data.message);
  if (wasNew) { history.replaceState(null, '', `#fushata/${encodeURIComponent(campaign.id)}`); }
  $('#c-title').textContent = campaign.title;
  $('#c-delete').hidden = false;
  renderImage();
  renderPreview();
});

$('#c-delete').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (isBusy(btn) || !campaign) return;
  if (!confirm('Ta fshijmë këtë reklamë bashkë me numrat e saj? Raportet e muajve të kaluar nuk do ta kenë më.')) return;
  busy(btn, true);
  const { data } = await api('/api/admin/fushata/fshi', { id: campaign.id });
  busy(btn, false);
  if (!data.ok) { setError($('#c-error'), data.message || GENERIC); return; }
  ads = data;
  toast(data.message);
  location.hash = '#reklamat';
});

$('#c-image-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file || !campaign) return;
  const status = $('#c-image-status');
  const id = campaign.id;
  status.textContent = 'Po përgatitet…';
  let blob;
  try {
    ({ blob } = await shrinkPhoto(file, { maxEdge: 1600, minEdge: 200 }));
  } catch (err) {
    status.textContent = err.message || 'Kjo foto nuk u lexua.';
    return;
  }
  const { data } = await uploadJpeg(`/api/admin/fushata/foto?id=${encodeURIComponent(id)}`, blob, (f) => { status.textContent = `Po ngarkohet… ${Math.round(f * 100)}%`; });
  if (!campaign || campaign.id !== id) return;
  if (!data.ok) { status.textContent = data.message || GENERIC; return; }
  ads = data;
  campaign = data.campaign;
  status.textContent = data.message;
  renderImage();
  renderPreview();
});

$('#c-image-remove').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (isBusy(btn) || !campaign) return;
  busy(btn, true);
  const { data } = await api('/api/admin/fushata/foto/hiq', { id: campaign.id });
  busy(btn, false);
  if (!data.ok) { $('#c-image-status').textContent = data.message || GENERIC; return; }
  ads = data;
  campaign = data.campaign;
  $('#c-image-status').textContent = data.message;
  renderImage();
  renderPreview();
});

/** On sign-out: nothing of the session is kept. */
export function closeAds() {
  ads = null;
  campaign = null;
  closeSheet(advSheet);
}
