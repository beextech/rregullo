// A stand-in for the Resend API, for local development and tests. Nothing is sent anywhere.
//   node scripts/mock-email.mjs            listens on http://127.0.0.1:8790
// Point the Functions at it with EMAIL_API_BASE=http://127.0.0.1:8790 (in .dev.vars).
//   GET  /_messages        everything "sent" so far (JSON)
//   POST /_mode {"fail": true|false}   make sends fail with HTTP 500, to test provider outages
//   POST /_reset           forget all messages

import { createServer } from 'node:http';

export function startMockEmail(port = 8790) {
  const messages = [];
  let fail = false;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.method === 'POST' && req.url === '/emails') {
      if (!/^Bearer \S+/.test(req.headers.authorization || '')) return json(401, { message: 'missing key' });
      if (fail) return json(500, { message: 'mock outage' });
      const msg = JSON.parse(body);
      msg.idempotencyKey = req.headers['idempotency-key'] || null;
      messages.push(msg);
      return json(200, { id: `mock-${messages.length}` });
    }
    if (req.method === 'GET' && req.url === '/_messages') return json(200, messages);
    if (req.method === 'POST' && req.url === '/_mode') { fail = !!JSON.parse(body || '{}').fail; return json(200, { fail }); }
    if (req.method === 'POST' && req.url === '/_reset') { messages.length = 0; return json(200, {}); }
    json(404, {});
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, messages, setFail: (v) => { fail = v; } })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { server } = await startMockEmail(Number(process.env.PORT) || 8790);
  console.log(`mock email API on http://127.0.0.1:${server.address().port}`);
}
