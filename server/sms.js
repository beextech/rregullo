// SMS through Twilio's REST API (https://www.twilio.com/docs/messaging/api/message-resource#create-a-message-resource).
// Plain fetch, no SDK. To switch to a cheaper provider, replace sendSms(); nothing else depends on Twilio.

export class SmsError extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.name = 'SmsError';
    this.status = status;
  }
}

export function readSmsConfig(env) {
  return {
    accountSid: env.TWILIO_ACCOUNT_SID || '',
    authToken: env.TWILIO_AUTH_TOKEN || '',
    from: env.SMS_FROM || 'Rregullo',   // an alphanumeric sender ID, or a Twilio number / Messaging Service SID (MG…)
    apiBase: (env.SMS_API_BASE || 'https://api.twilio.com').replace(/\/$/, ''),
  };
}

export const smsConfigured = (cfg) => Boolean(cfg.accountSid && cfg.authToken);

/** @returns {Promise<string>} the provider's message id */
export async function sendSms(cfg, to, body) {
  const form = new URLSearchParams({ To: to, Body: body });
  form.set(cfg.from.startsWith('MG') ? 'MessagingServiceSid' : 'From', cfg.from);
  let res;
  try {
    res = await fetch(`${cfg.apiBase}/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${cfg.accountSid}:${cfg.authToken}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw new SmsError(`network: ${e.name}`);
  }
  // The provider's error text can echo the number; log only the status and Twilio's numeric error code.
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = Number.isInteger(data.code) ? ` ${data.code}` : '';
    throw new SmsError(`provider status ${res.status}${code}`, { status: res.status });
  }
  return data.sid || '';
}
