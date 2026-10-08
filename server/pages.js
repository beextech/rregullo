// Server-rendered pages for the confirmation, unsubscribe and no-JavaScript signup results.
// They reuse the site's stylesheet, so they look like the rest of rregullo.net.

import { CSS_HASH } from './build-info.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The wordmark from Rregullo identity 2.4 (01-logo/svg/rregullo-logo_dark.svg), drawn, not typed.
export const LOGO = `<svg class="logo-small" viewBox="0 -62 714 226" role="img" aria-label="Rregullo"><path fill="#F1F2EF" d="M0 0H20V100H0ZM0 56A56 56 0 0 1 56 0L56 20C32.52 20 20 32.52 20 56ZM56 0H59V20H56ZM74 0H94V100H74ZM74 56A56 56 0 0 1 130 0L130 20C106.52 20 94 32.52 94 56ZM130 0H133V20H130ZM157 40H240V60H157ZM240 50H250V60H240ZM245.06 72A51.5 51.5 0 1 1 250 50L230 50A31.5 31.5 0 1 0 221.04 72ZM264 50A51.5 51.5 0 1 1 367 50A51.5 51.5 0 1 1 264 50ZM315.5 18.5C298.1 18.5 284 32.6 284 50C284 67.4 298.1 81.5 315.5 81.5C336.04 81.5 347 70.54 347 50C347 29.46 336.04 18.5 315.5 18.5ZM347 0H367V112H347ZM367 112A51.5 51.5 0 0 1 268.94 134L292.96 134A31.5 31.5 0 0 0 347 112ZM391 0H411V50H391ZM494 50A51.5 51.5 0 0 1 391 50L411 50C411 67.4 425.1 81.5 442.5 81.5C463.04 81.5 474 70.54 474 50ZM474 0H494V100H474ZM518 -62H538V100H518ZM562 -62H582V100H562Z"/><path fill="#ABE23F" d="M658 14.5H658C678.99 14.5 696 30.39 696 50C696 69.61 678.99 85.5 658 85.5H658C637.01 85.5 620 69.61 620 50C620 30.39 637.01 14.5 658 14.5Z"/><path fill="#F1F2EF" fill-rule="evenodd" d="M658 -1.5H658C688.93 -1.5 714 21.56 714 50C714 78.44 688.93 101.5 658 101.5H658C627.07 101.5 602 78.44 602 50C602 21.56 627.07 -1.5 658 -1.5ZM658 16.5H658C677.88 16.5 694 31.5 694 50C694 68.5 677.88 83.5 658 83.5H658C638.12 83.5 622 68.5 622 50C622 31.5 638.12 16.5 658 16.5Z"/><path fill="#16171A" d="M650 41.5H666A8.5 8.5 0 0 1 666 58.5H650A8.5 8.5 0 0 1 650 41.5Z"/><path fill="#F1F2EF" d="M650 44.5H666A5.5 5.5 0 0 1 666 55.5H650A5.5 5.5 0 0 1 650 44.5Z"/></svg>`;

/**
 * @param {{ title: string, heading: string, body?: string, tone?: 'ok' | 'error', action?: string, script?: string }} o
 * `action` is trusted HTML built by the caller (a form or a link).
 */
export function page({ title, heading, body = '', tone = 'ok', action = '', script = '' }, status = 200) {
  const html = `<!doctype html>
<html lang="sq">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} | Rregullo</title>
<meta name="robots" content="noindex">
<meta name="theme-color" content="#16171A">
<meta name="color-scheme" content="dark">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/icons/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/site.css?v=${CSS_HASH}">
${script ? `<script type="module" src="${esc(script)}"></script>` : ''}
</head>
<body>
<header class="top"><a class="top-brand" href="/" aria-label="Rregullo, faqja kryesore">${LOGO}</a></header>
<main class="notice notice-${tone}" id="main">
  <span class="notice-mark" aria-hidden="true"></span>
  <h1 class="notice-title" tabindex="-1">${esc(heading)}</h1>
  ${body ? `<p class="notice-text">${esc(body)}</p>` : ''}
  ${action}
</main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',     // never leak a token in the query string to another site
      'X-Robots-Tag': 'noindex',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}

export const homeLink = '<p class="notice-action"><a class="btn" href="/">Kthehu te faqja</a></p>';
export const signupLink = '<p class="notice-action"><a class="btn" href="/#lajmerimi">Regjistrohu sërish</a></p>';
export { esc };
