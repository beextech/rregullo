// /mjeshter: craftsman signup. Nothing is sent to or stored by the site: on submit the form is checked,
// turned into a WhatsApp message and handed to WhatsApp's click-to-chat link, where the craftsman sends it.

const WHATSAPP = '38345632031';

const MSG = {
  name: 'Shkruaje emrin dhe mbiemrin.',
  phone: 'Shkruaje numrin e telefonit.',
  phoneInvalid: 'Ky numër nuk duket i plotë. Shembull: +383 44 123 456',
  whatsappInvalid: 'Ky numër nuk duket i plotë. Lëre bosh nëse është i njëjti si telefoni.',
  city: 'Shkruaje qytetin ku punon.',
  trade: 'Zgjedhe zanatin ose shkruaje vetë.',
  tradeOther: 'Shkruaje zanatin tënd.',
  experience: 'Zgjedhe sa vite përvojë ki.',
  summary: 'Plotësoji fushat e shënuara më lart.',
};

const line = (s) => s.replace(/\s+/g, ' ').trim();
const digits = (s) => s.replace(/\D/g, '').length;
const phoneOk = (s) => /^\+?[\d\s()./-]+$/.test(s) && digits(s) >= 8 && digits(s) <= 15;

export function buildMessage(d) {
  const rows = [
    ['Emri', d.name],
    ['Telefoni', d.phone],
    ['Qyteti', d.city],
    ['Zanati', d.trade],
    ['Përvoja', d.experience],
    ['Përshkrimi', d.about],
    ['WhatsApp', d.whatsapp],
    ['Instagram/Facebook', d.social],
    ['Website', d.website],
  ].filter(([, v]) => v);
  return ['Përshëndetje, dua të bëhem pjesë e Rregullo.', '', ...rows.map(([k, v]) => `${k}: ${v}`)].join('\n');
}

export const whatsappUrl = (text) => `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(text)}`;

function mount(form) {
  const card = form.closest('.mj-card');
  const done = card.querySelector('[data-mj-done]');
  const openLink = done.querySelector('[data-mj-open]');
  const formError = form.querySelector('[data-form-error]');
  const el = (id) => form.querySelector(`#${id}`);
  const other = form.querySelector('[data-trade-other]');
  const otherInput = el('mj-trade-other');

  const setError = (target, errorId, text) => {
    const err = el(errorId);
    err.textContent = text || '';
    err.hidden = !text;
    for (const t of [].concat(target)) {
      if (text) t.setAttribute('aria-invalid', 'true'); else t.removeAttribute('aria-invalid');
    }
  };

  const read = () => {
    const trades = [...form.querySelectorAll('input[name="zanati"]:checked')].map((c) => c.value).filter((v) => v !== 'Të tjera');
    const custom = line(otherInput.value);
    if (custom) trades.push(custom);
    const exp = form.querySelector('input[name="pervoja"]:checked');
    return {
      name: line(el('mj-name').value),
      phone: line(el('mj-phone').value),
      city: line(el('mj-city').value),
      trade: trades.join(', '),
      experience: exp ? exp.value : '',
      about: el('mj-about').value.trim().replace(/\n{3,}/g, '\n\n'),
      whatsapp: line(el('mj-whatsapp').value),
      social: line(el('mj-social').value),
      website: line(el('mj-web').value),
    };
  };

  // Returns the first field with a problem (to focus), or null.
  const validate = (d) => {
    const bad = [];
    const check = (ok, target, errorId, text) => { setError(target, errorId, ok ? '' : text); if (!ok) bad.push([].concat(target)[0]); };
    check(d.name.length >= 2, el('mj-name'), 'mj-name-error', MSG.name);
    check(d.phone && phoneOk(d.phone), el('mj-phone'), 'mj-phone-error', d.phone ? MSG.phoneInvalid : MSG.phone);
    check(d.city.length >= 2, el('mj-city'), 'mj-city-error', MSG.city);
    const otherMissing = other.checked && !line(otherInput.value);
    const tradeBoxes = [...form.querySelectorAll('input[name="zanati"]')];
    setError([otherInput, ...tradeBoxes], 'mj-trade-error', '');
    check(d.trade && !otherMissing, otherMissing ? otherInput : tradeBoxes, 'mj-trade-error', otherMissing ? MSG.tradeOther : MSG.trade);
    const expBoxes = [...form.querySelectorAll('input[name="pervoja"]')];
    check(Boolean(d.experience), expBoxes, 'mj-exp-error', MSG.experience);
    check(!d.whatsapp || phoneOk(d.whatsapp), el('mj-whatsapp'), 'mj-whatsapp-error', MSG.whatsappInvalid);
    return bad[0] || null;
  };

  let tried = false;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    tried = true;
    const d = read();
    const first = validate(d);
    formError.hidden = !first;
    formError.textContent = first ? MSG.summary : '';
    if (first) { first.focus(); return; }

    const url = whatsappUrl(buildMessage(d));
    openLink.href = url;
    form.hidden = true;
    done.hidden = false;
    done.focus({ preventScroll: true });
    done.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    // A new tab keeps this page (and the "Hape WhatsApp-in" button) behind it; if the browser refuses, go there directly.
    const win = window.open(url, '_blank');
    if (win) win.opener = null; else location.href = url;
  });

  // Once the visitor has tried to submit, errors clear as soon as a field is fixed.
  form.addEventListener('input', () => { if (tried) { const first = validate(read()); formError.hidden = !first; } });
  form.addEventListener('change', (e) => {
    if (e.target === other && other.checked) otherInput.focus();
    if (tried) { const first = validate(read()); formError.hidden = !first; }
  });

  done.querySelector('[data-mj-back]').addEventListener('click', () => {
    done.hidden = true;
    form.hidden = false;
    el('mj-name').focus();
  });
}

const form = document.querySelector('[data-mj-form]');
if (form) mount(form);
