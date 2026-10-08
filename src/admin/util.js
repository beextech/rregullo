// Small helpers the team admin's views share. Mjeshtër-written text only ever goes into the page through
// textContent or attribute setters, never as HTML.

export const $ = (sel, root = document) => root.querySelector(sel);

export function setError(el, message) {
  el.textContent = message || '';
  el.hidden = !message;
}

// While a request runs, the button shows a spinner and ignores taps. It stays focusable (aria-disabled rather than
// disabled), so keyboard and screen-reader focus isn't thrown back to the top of the page.
export function busy(btn, on) {
  btn.classList.toggle('is-busy', on);
  if (on) btn.setAttribute('aria-disabled', 'true'); else btn.removeAttribute('aria-disabled');
}
export const isBusy = (btn) => btn.classList.contains('is-busy');

let toastTimer = 0;
export function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('is-on'); el.textContent = ''; }, 6000);
}

// For screen readers only (list counts after a filter or a search). Cleared first, so the same words are read again.
let announceTimer = 0;
export function announce(message) {
  const el = $('#announce');
  el.textContent = '';
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { el.textContent = message; }, 60);
}

export function openSheet(sheet) {
  if (typeof sheet.showModal === 'function') { if (!sheet.open) sheet.showModal(); } else sheet.setAttribute('open', '');
}
export function closeSheet(sheet) {
  if (typeof sheet.close === 'function') sheet.close(); else sheet.removeAttribute('open');
}

// ë → e, ç → c, for matching what was typed against names.
export const fold = (s) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

export function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  return (words.slice(0, 2).map((w) => [...w][0]).join('') || '?').toUpperCase();
}

export const STATUS = {
  draft: 'Pa dërguar',
  pending: 'Në pritje',
  approved: 'Aprovuar',
  rejected: 'Kthyer për ndryshime',
  suspended: 'Pezulluar',
};

// The required checklist items, as the team reads them in "Para se ta aprovosh, mungon: …".
export const MISSING = {
  name: 'emri (të paktën 2 shkronja)',
  trades: 'të paktën një zanat',
  towns: 'të paktën një komunë',
  photo: 'foto e profilit',
};

// ---------- times ----------

const MONTHS = ['janar', 'shkurt', 'mars', 'prill', 'maj', 'qershor', 'korrik', 'gusht', 'shtator', 'tetor', 'nëntor', 'dhjetor'];
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** 6 tetor, 14:05 (the year only when it isn't this year). */
export function dateTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const year = d.getFullYear() === new Date().getFullYear() ? '' : ` ${d.getFullYear()}`;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}, ${hh}:${mm}`;
}

/** "sot", "1 dite", "3 ditësh", "5 orësh": how long since, for "në pritje prej …". */
export function since(ms, now = Date.now()) {
  const gap = Math.max(0, now - ms);
  if (gap < HOUR) return 'pak minutash';
  if (gap < DAY) {
    const h = Math.floor(gap / HOUR);
    return h === 1 ? '1 ore' : `${h} orësh`;
  }
  const days = Math.floor(gap / DAY);
  return days === 1 ? '1 dite' : `${days} ditësh`;
}

export const countText = (n) => `${n} mjeshtër`;
