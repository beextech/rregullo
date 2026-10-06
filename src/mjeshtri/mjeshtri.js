// The mjeshtër panel: sign in with a phone number and an SMS code, then the dashboard (paneli.js).
// Talks only to /api/mjeshtri/*; the session lives in an HttpOnly cookie the script never sees.

import { GENERIC, api } from './api.js';
import { closeDashboard, openDashboard } from './paneli.js';

const RESEND_AFTER = 60;   // seconds, matching the server's one-SMS-a-minute limit
const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

const $ = (sel) => document.querySelector(sel);
const views = document.querySelectorAll('main > [data-view]');
let phoneTyped = '';
let resendTimer = 0;

function show(name, focus = true) {
  for (const v of views) v.hidden = v.dataset.view !== name;
  if (name === 'phone') loadHumanCheck();
  const title = document.querySelector(`[data-view="${name}"] .pro-title`);
  if (focus && title && name !== 'app') title.focus();
}

function setError(el, message) {
  el.textContent = message || '';
  el.hidden = !message;
}

function busy(form, on) {
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = on;
  btn.classList.toggle('is-busy', on);
}

// ---------- the bot check (Cloudflare Turnstile), loaded only when the phone form is shown ----------

const humanBox = $('.cf-turnstile');
let humanWidget = null;
let humanLoading = false;

function loadHumanCheck() {
  if (!humanBox || humanWidget !== null || humanLoading) return;
  humanLoading = true;
  const s = document.createElement('script');
  s.src = TURNSTILE_SRC;
  s.async = true;
  s.onload = () => {
    try {
      humanWidget = window.turnstile.render(humanBox, {
        sitekey: humanBox.dataset.sitekey, theme: humanBox.dataset.theme, size: humanBox.dataset.size,
      });
    } catch { /* the form still submits; the server then asks to retry the check */ }
  };
  s.onerror = () => { humanLoading = false; };
  document.head.append(s);
}

function resetHumanCheck() {
  if (window.turnstile && humanWidget !== null) try { window.turnstile.reset(humanWidget); } catch { /* not rendered */ }
}

function startResendTimer() {
  const btn = document.querySelector('[data-action="resend"]');
  let left = RESEND_AFTER;
  clearInterval(resendTimer);
  btn.disabled = true;
  btn.textContent = `Dërgo kodin prapë (${left})`;
  resendTimer = setInterval(() => {
    left -= 1;
    if (left > 0) { btn.textContent = `Dërgo kodin prapë (${left})`; return; }
    clearInterval(resendTimer);
    btn.disabled = false;
    btn.textContent = 'Dërgo kodin prapë';
  }, 1000);
}

// ---------- step 1: the phone number ----------

const phoneForm = $('#phone-form');
const phoneInput = $('#phone');
phoneForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  setError($('#phone-error'), '');
  setError($('#phone-form-error'), '');
  setError($('#signed-out-note'), '');
  phoneInput.removeAttribute('aria-invalid');
  const phone = phoneInput.value.trim();
  if (!phone) {
    setError($('#phone-error'), 'Shkruaje numrin e telefonit.');
    phoneInput.setAttribute('aria-invalid', 'true');
    phoneInput.focus();
    return;
  }
  const human = phoneForm.querySelector('[name="cf-turnstile-response"]');
  if (humanWidget === null) loadHumanCheck();   // the check's script failed to load before: try again
  busy(phoneForm, true);
  const { data } = await api('/api/mjeshtri/kodi', { phone, turnstile: human ? human.value : '' });
  busy(phoneForm, false);
  resetHumanCheck();
  if (!data.ok) {
    if (data.field === 'phone') {
      setError($('#phone-error'), data.message);
      phoneInput.setAttribute('aria-invalid', 'true');
      phoneInput.focus();
    } else {
      setError($('#phone-form-error'), data.message || GENERIC);
    }
    return;
  }
  phoneTyped = phone;
  $('#code-phone').textContent = data.phone;
  setError($('#dev-code'), data.devCode ? `Zhvillim lokal, pa SMS: kodi është ${data.devCode}` : '');
  $('#code-form').reset();
  setError($('#code-error'), '');
  setError($('#code-form-error'), '');
  show('code');
  $('#code').focus();
  startResendTimer();
});

// ---------- step 2: the code ----------

const codeForm = $('#code-form');
const codeInput = $('#code');
codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
  if (codeInput.value.length === 6) codeForm.requestSubmit();
});
codeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
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
  busy(codeForm, true);
  const { data } = await api('/api/mjeshtri/hyr', { phone: phoneTyped, code });
  if (!data.ok) {
    busy(codeForm, false);
    if (data.field === 'code') {
      setError($('#code-error'), data.message);
      codeInput.setAttribute('aria-invalid', 'true');
      codeInput.select();
    } else {
      setError($('#code-form-error'), data.message || GENERIC);
    }
    return;
  }
  clearInterval(resendTimer);
  const opened = await loadDashboard(true);
  busy(codeForm, false);
  if (!opened) setError($('#code-form-error'), GENERIC);
});

document.querySelector('[data-action="change-number"]').addEventListener('click', () => {
  clearInterval(resendTimer);
  show('phone');
  phoneInput.focus();
});
document.querySelector('[data-action="resend"]').addEventListener('click', () => {
  // A new code needs a fresh human check, so it goes through step 1 again with the number filled in.
  clearInterval(resendTimer);
  phoneInput.value = phoneTyped;
  show('phone');
  setError($('#phone-form-error'), '');
  phoneForm.querySelector('button[type="submit"]').focus();
});

// ---------- signed in ----------

async function loadDashboard(fresh) {
  const { status, data } = await api('/api/mjeshtri/une');
  if (status === 200 && data.ok) {
    show('app', false);
    openDashboard(data.dashboard, { fresh });
    return true;
  }
  return false;
}

function signedOut(message) {
  closeDashboard();
  phoneForm.reset();
  setError($('#signed-out-note'), message || '');
  show('phone');
}

// The server ended the session (expired, or "sign out everywhere" on another phone), or the dashboard signed out.
// A 401 before the dashboard is open (the first visit, or the start-up check) is just "not signed in yet".
const appView = document.querySelector('[data-view="app"]');
window.addEventListener('rr:signedout', () => {
  if (!appView.hidden) signedOut('Nuk je më i kyçur. Hyr prapë me numrin e telefonit.');
});
window.addEventListener('rr:left', (e) => signedOut(e.detail && e.detail.message));

// ---------- start ----------

if (!(await loadDashboard(false))) show('phone', false);
