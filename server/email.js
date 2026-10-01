// Transactional email through Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email).
// Plain fetch, no SDK. To use another provider, replace sendEmail(); nothing else depends on Resend.

export class EmailError extends Error {
  constructor(message, { status = 0, retryable = true } = {}) {
    super(message);
    this.name = 'EmailError';
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * @param {object} cfg  readConfig(env).email
 * @param {{to: string, subject: string, html: string, text: string, headers?: object, idempotencyKey?: string}} msg
 * @returns {Promise<string>} the provider's message id
 */
export async function sendEmail(cfg, msg) {
  const body = {
    from: cfg.from,
    to: [msg.to],
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
  };
  if (cfg.replyTo) body.reply_to = cfg.replyTo;
  if (msg.headers) body.headers = msg.headers;

  let res;
  try {
    res = await fetch(`${cfg.apiBase}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        ...(msg.idempotencyKey ? { 'Idempotency-Key': msg.idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw new EmailError(`network: ${e.name}`);
  }
  if (!res.ok) {
    // The provider's error body can echo the recipient; log only the status code.
    throw new EmailError(`provider status ${res.status}`, { status: res.status, retryable: res.status === 429 || res.status >= 500 });
  }
  const data = await res.json().catch(() => ({}));
  return data.id || '';
}
