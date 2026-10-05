// The mjeshtër panel: sign in with a phone number and an SMS code, then the (for now small) signed-in view.
// Talks only to /api/mjeshtri/*; the session lives in an HttpOnly cookie the script never sees.

const GENERIC = 'Diçka nuk shkoi si duhet. Provo përsëri pas pak.';
const RESEND_AFTER = 60;   // seconds, matching the server's one-SMS-a-minute limit

const $ = (sel) => document.querySelector(sel);
const views = document.querySelectorAll('[data-view]');
let phoneTyped = '';
let resendTimer = 0;

function show(name, focus = true) {
  for (const v of views) v.hidden = v.dataset.view !== name;
  const title = document.querySelector(`[data-view="${name}"] .pro-title`);
  if (focus && title) title.focus();
}

async function api(path, body) {
  const init = body === undefined
    ? { headers: { Accept: 'application/json' } }
    : { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) };
  let res;
  try { res = await fetch(path, { ...init, credentials: 'same-origin' }); } catch { return { status: 0, data: { ok: false, message: GENERIC } }; }
  const data = await res.json().catch(() => ({ ok: false, message: GENERIC }));
  return { status: res.status, data };
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

function resetHumanCheck() {
  if (window.turnstile) try { window.turnstile.reset(); } catch { /* not rendered */ }
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
  phoneInput.removeAttribute('aria-invalid');
  const phone = phoneInput.value.trim();
  if (!phone) {
    setError($('#phone-error'), 'Shkruaje numrin e telefonit.');
    phoneInput.setAttribute('aria-invalid', 'true');
    phoneInput.focus();
    return;
  }
  const human = phoneForm.querySelector('[name="cf-turnstile-response"]');
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
  busy(codeForm, false);
  if (!data.ok) {
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
  await loadHome();
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

async function loadHome(focus = true) {
  const { status, data } = await api('/api/mjeshtri/une');
  if (status === 200 && data.ok) {
    $('#home-phone').textContent = data.pro.phone;
    show('home', focus);
    return true;
  }
  return false;
}

const signout = document.querySelector('[data-action="signout"]');
signout.addEventListener('click', async () => {
  signout.disabled = true;
  const { data } = await api('/api/mjeshtri/dil', {});
  signout.disabled = false;
  if (!data.ok) { setError($('#home-error'), data.message || GENERIC); return; }
  phoneForm.reset();
  show('phone');
});

// ---------- start ----------

if (!(await loadHome(false))) show('phone', false);
