// Server-side validation. The form validates too, but only these checks count.

export const MESSAGES = {
  emailMissing: 'Shkruaje email adresën tënde.',
  emailInvalid: 'Kjo nuk duket si email adresë e vlefshme. Shembull: emri@shembull.com',
  consentMissing: 'Për me të lajmëru, duhet ta pranosh ruajtjen e emailit.',
  generic: 'Diçka nuk shkoi si duhet. Provo përsëri pas pak.',
  rateLimited: 'Ke provu shumë herë. Provo përsëri pas pak.',
  accepted: 'Faleminderit! Do të të lajmërojmë kur Rregullo të jetë gati.',
};

/** Trim and lower-case. Plus-addressing is kept: it is a real, distinct address. */
export function normaliseEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

export function isValidEmail(email) {
  if (email.length < 6 || email.length > 254) return false;
  const at = email.lastIndexOf('@');
  if (at < 1 || at !== email.indexOf('@')) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64) return false;
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  for (const l of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) return false;
  }
  return /^[a-z]{2,63}$/.test(labels[labels.length - 1]) || /^xn--[a-z0-9-]+$/.test(labels[labels.length - 1]);
}

/** Returns { email, errors } where errors maps field name to a message. */
export function validateSignup(fields) {
  const errors = {};
  const email = normaliseEmail(fields.email);
  if (!email) errors.email = MESSAGES.emailMissing;
  else if (!isValidEmail(email)) errors.email = MESSAGES.emailInvalid;
  const c = fields.consent;
  if (!(c === true || c === 'true' || c === 'on' || c === '1' || c === 1)) errors.consent = MESSAGES.consentMissing;
  return { email, errors };
}

/** For logs and team notifications: b***@g***.com, never the full address. */
export function maskEmail(email) {
  if (!email) return '(fshirë)';
  const [local, domain = ''] = email.split('@');
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local.slice(0, 1)}***@${host.slice(0, 1)}***${tld}`;
}
