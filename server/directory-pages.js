// The public directory's pages, rendered on the server so they load fast on any phone and Google can read them:
// /kerko (search results) and /m/<name>-<handle> (one mjeshtër). Everything from the database is escaped here;
// src/kerko/kerko.js only adds counting and "Thirrjet e mia" on top.

import { CSS_HASH, DIR_CSS_HASH, DIR_JS_HASH } from './build-info.js';
import { TOWNS, TRADES, labelOf } from '../src/mjeshtri/catalog.js';
import { LOGO, esc } from './pages.js';
import { searchForm } from './search-form.js';
import { formatPhone } from './signin.js';

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; manifest-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

function initials(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.slice(0, 2).map((w) => [...w][0]).join('') || '?').toUpperCase();
}

export function yearsText(n) {
  if (n === null || n === undefined) return '';
  if (n === 0) return 'Më pak se një vit përvojë';
  return n === 1 ? '1 vit përvojë' : `${n} vjet përvojë`;
}

const count = (n) => `${n} mjeshtër`;

// The towns, with the one searched for first, shortened after three.
function townsLine(labels, first) {
  const list = first ? [first, ...labels.filter((t) => t !== first)] : labels;
  if (list.length <= 3) return list.join(', ');
  const rest = list.length - 3;
  return `${list.slice(0, 3).join(', ')} dhe ${rest === 1 ? '1 komunë tjetër' : `${rest} komuna të tjera`}`;
}

const avatar = (p, cls) => `<span class="${cls}" aria-hidden="true">${p.photo
  ? `<img src="${esc(p.photo)}" alt="" width="96" height="96" loading="lazy" decoding="async">`
  : `<span class="dir-initials">${esc(initials(p.name))}</span>`}</span>`;

const badge = (p) => (p.verified ? ' <span class="dir-badge" title="Ekipi i Rregullo e ka verifikuar">Verifikuar</span>' : '');

const available = (p) => `<p class="dir-avail${p.available ? '' : ' is-off'}">${p.available ? 'Merr punë tani' : 'Tani për tani nuk merr punë'}</p>`;

// Thirre, WhatsApp and Viber. kerko.js counts each tap and saves it in "Thirrjet e mia"; without JavaScript the links still work.
function actions(p, big = false) {
  const digits = p.phone.slice(1);
  const name = esc(p.name);
  const links = [
    `<a class="btn btn-primary dir-act dir-call" href="tel:${esc(p.phone)}" data-tap="thirrje" aria-label="Thirre ${name}">Thirre</a>`,
    p.whatsapp ? `<a class="btn dir-act dir-ghost" href="https://wa.me/${esc(digits)}" data-tap="whatsapp" rel="noopener" aria-label="Shkruaji ${name} në WhatsApp">WhatsApp</a>` : '',
    p.viber ? `<a class="btn dir-act dir-ghost" href="viber://chat?number=%2B${esc(digits)}" data-tap="viber" aria-label="Shkruaji ${name} në Viber">Viber</a>` : '',
  ].filter(Boolean).join('');
  return `<div class="dir-actions${big ? ' dir-actions-big' : ''}">${links}</div>`;
}

// What kerko.js needs to save a tap in "Thirrjet e mia".
const proData = (p) => `data-m="${esc(p.handle)}" data-name="${esc(p.name)}" data-path="${esc(p.path)}" data-phone="${esc(p.phone)}" data-trades="${esc(p.tradeLabels.join(' · '))}"`;

function shell({ title, description = '', canonical = '', index = true, head = '', main, preview = false, bodyAttrs = '' }, status = 200) {
  const html = `<!doctype html>
<html lang="sq">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">` : ''}
${index && !preview ? '' : '<meta name="robots" content="noindex">'}
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<meta name="theme-color" content="#16171A">
<meta name="color-scheme" content="dark">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/icons/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<link rel="preload" href="/fonts/schibsted-grotesk-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/site.css?v=${CSS_HASH}">
<link rel="stylesheet" href="/kerko/kerko.css?v=${DIR_CSS_HASH}">
<script type="module" src="/kerko/kerko.js?v=${DIR_JS_HASH}"></script>
${head}
</head>
<body${bodyAttrs}>
<a class="skip" href="#main">Kalo te përmbajtja</a>
<header class="top dir-top">
  <a class="top-brand" href="/" aria-label="Rregullo, faqja kryesore">${LOGO}</a>
  <nav class="dir-nav" aria-label="Lidhjet kryesore"><a href="/kerko">Kërko</a><a href="/thirrjet">Thirrjet e mia</a></nav>
</header>
${preview ? '<p class="dir-preview" role="note">Lista e mjeshtrave ende nuk është e hapur. Këtë faqe e sheh vetëm ekipi, dhe asgjë këtu nuk numërohet.</p>' : ''}
<main class="dir" id="main"${preview ? ' data-preview' : ''}>
${main}
</main>
<footer class="dir-foot"><p>Rregullo nuk merr pagesë nga klientët dhe nuk ndërhyn në marrëveshjen tënde me mjeshtrin. <a href="/privatesia">Privatësia</a></p></footer>
</body>
</html>`.replace(/^\s*\n/gm, '');
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': preview ? 'private, no-store' : 'no-cache',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
      'Content-Security-Policy': CSP,
      ...(index && !preview ? {} : { 'X-Robots-Tag': 'noindex' }),
    },
  });
}

// ---------- /kerko ----------

function searchTitle(trade, town) {
  const t = trade && labelOf(TRADES, trade);
  const w = town && labelOf(TOWNS, town);
  if (t && w) return `${t} në ${w}`;
  if (t) return `${t} në gjithë Kosovën`;
  if (w) return `Mjeshtër në ${w}`;
  return 'Gjej mjeshtër';
}

const query = (o) => {
  const q = new URLSearchParams();
  if (o.trade) q.set('zanati', o.trade);
  if (o.town) q.set('komuna', o.town);
  if (o.page > 1) q.set('faqja', String(o.page));
  const s = q.toString();
  return `/kerko${s ? `?${s}` : ''}`;
};

function card(p, town) {
  const townLabel = town ? labelOf(TOWNS, town) : '';
  const facts = [townsLine(p.townLabels, townLabel), yearsText(p.years)].filter(Boolean).join(' · ');
  return `<li class="dir-card" ${proData(p)}>
  <a class="dir-card-main" href="${esc(p.path)}">
    ${avatar(p, 'dir-avatar')}
    <span class="dir-card-who">
      <span class="dir-name">${esc(p.name)}${badge(p)}</span>
      <span class="dir-trades">${esc(p.tradeLabels.join(' · '))}</span>
      <span class="dir-facts">${esc(facts)}</span>
      ${p.priceNote ? `<span class="dir-price">${esc(p.priceNote)}</span>` : ''}
    </span>
  </a>
  ${available(p)}
  ${actions(p)}
</li>`;
}

function emptyResults(trade, town) {
  const tries = [];
  if (town) tries.push(`<a href="${esc(query({ trade }))}">Kërko në gjithë Kosovën</a>`);
  if (trade) tries.push(`<a href="${esc(query({ town }))}">Shiko të gjitha zanatet${town ? ` në ${esc(labelOf(TOWNS, town))}` : ''}</a>`);
  return `<div class="dir-empty">
  <p class="dir-empty-title">Ende nuk kemi mjeshtër për këtë kërkim.</p>
  <p>Po shtojmë mjeshtër çdo ditë, komunë pas komune.${tries.length ? '' : ' Provo përsëri së shpejti.'}</p>
  ${tries.length ? `<ul class="dir-tries">${tries.map((t) => `<li>${t}</li>`).join('')}</ul>` : ''}
</div>`;
}

function pager(s, r) {
  if (r.pages < 2) return '';
  const prev = r.page > 1 ? `<a class="btn dir-ghost" rel="prev" href="${esc(query({ ...s, page: r.page - 1 }))}">Më parë</a>` : '<span></span>';
  const next = r.page < r.pages ? `<a class="btn dir-ghost" rel="next" href="${esc(query({ ...s, page: r.page + 1 }))}">Më tutje</a>` : '<span></span>';
  return `<nav class="dir-pager" aria-label="Faqet e rezultateve">${prev}<span class="dir-pager-at">Faqja ${r.page} nga ${r.pages}</span>${next}</nav>`;
}

/** The search page with its results. `s` is readSearch()'s answer, `r` search()'s. */
export function searchPage(siteUrl, s, r, { preview = false } = {}) {
  const title = searchTitle(s.trade, s.town);
  const summary = r.total
    ? `${count(r.total)}${r.pages > 1 ? `, faqja ${r.page} nga ${r.pages}` : ''}`
    : '';
  const main = `<section class="dir-search" aria-labelledby="dir-title">
  <h1 class="dir-title" id="dir-title">${esc(title)}</h1>
  ${searchForm({ trade: s.trade, town: s.town })}
</section>
<section class="dir-results" aria-labelledby="dir-count">
  ${r.total ? `<p class="dir-count" id="dir-count" role="status">${esc(summary)}</p>
  <ol class="dir-list">${r.results.map((p) => card(p, s.town)).join('\n')}</ol>
  ${pager(s, r)}` : `<h2 class="visually-hidden" id="dir-count">Rezultatet</h2>${emptyResults(s.trade, s.town)}`}
</section>`;
  const where = s.town ? ` në ${labelOf(TOWNS, s.town)}` : ' në Kosovë';
  const what = s.trade ? labelOf(TRADES, s.trade).toLowerCase() : 'mjeshtër';
  return shell({
    title: `${title} | Rregullo`,
    description: `Gjej ${what}${where} te Rregullo. Shiko profilin, punët dhe thirre direkt, pa pagesë.`,
    canonical: `${siteUrl}${query({ ...s, page: r.page })}`,
    // Only the first page of a real search is worth indexing; empty results never are.
    index: r.total > 0 && r.page === 1,
    main,
    preview,
  });
}

// ---------- /m/<name>-<handle> ----------

function paragraphs(text) {
  return text.split(/\n{2,}/).map((para) => `<p>${esc(para).replace(/\n/g, '<br>')}</p>`).join('');
}

function jsonLd(siteUrl, p) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'HomeAndConstructionBusiness',
    name: p.name,
    url: `${siteUrl}${p.path}`,
    telephone: p.phone,
    ...(p.photo ? { image: `${siteUrl}${p.photo}` } : {}),
    ...(p.about ? { description: p.about.slice(0, 300) } : {}),
    areaServed: p.townLabels.map((name) => ({ '@type': 'City', name })),
    knowsAbout: p.tradeLabels,
    ...(p.priceNote ? { priceRange: p.priceNote } : {}),
  };
  // In a <script> block, "</" or "<!--" in someone's text must not end it.
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/** One mjeshtër's public profile. */
export function profilePage(siteUrl, p, { preview = false } = {}) {
  const facts = [
    `Punon në ${p.townLabels.join(', ')}`,
    yearsText(p.years),
    p.priceNote,
  ].filter(Boolean);
  const work = p.work.length ? `<section class="dir-section" aria-labelledby="work-title">
  <h2 class="dir-h2" id="work-title">Punët</h2>
  <ul class="dir-work">${p.work.map((w, i) => `<li><a href="${esc(w.url)}"><img src="${esc(w.url)}" alt="Punë e ${esc(p.name)}, foto ${i + 1}" width="${w.width}" height="${w.height}" loading="lazy" decoding="async"></a></li>`).join('')}</ul>
</section>` : '';
  const main = `<p class="dir-back"><a href="/kerko">← Kërko mjeshtër tjetër</a></p>
<article class="dir-profile" ${proData(p)} data-view>
  <header class="dir-profile-head">
    ${avatar(p, 'dir-avatar dir-avatar-big')}
    <div>
      <h1 class="dir-profile-name">${esc(p.name)}${badge(p)}</h1>
      <p class="dir-trades">${esc(p.tradeLabels.join(' · '))}</p>
      <p class="dir-rating">Ende pa vlerësime</p>
    </div>
  </header>
  ${available(p)}
  ${actions(p, true)}
  <p class="dir-phone">${esc(formatPhone(p.phone))}</p>
  <ul class="dir-profile-facts">${facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
  ${p.about ? `<section class="dir-section" aria-labelledby="about-title"><h2 class="dir-h2" id="about-title">Rreth meje</h2><div class="dir-about">${paragraphs(p.about)}</div></section>` : ''}
  ${work}
</article>`;
  const trade = p.tradeLabels[0] || 'Mjeshtër';
  const town = p.townLabels[0] ? ` në ${p.townLabels[0]}` : '';
  const description = p.about
    ? p.about.replace(/\s+/g, ' ').slice(0, 155)
    : `${p.name}, ${p.tradeLabels.join(', ').toLowerCase()}${town}. Thirre direkt nga Rregullo.`;
  const og = [
    '<meta property="og:type" content="profile">',
    '<meta property="og:site_name" content="Rregullo">',
    '<meta property="og:locale" content="sq_XK">',
    `<meta property="og:title" content="${esc(`${p.name}, ${trade}${town}`)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(`${siteUrl}${p.path}`)}">`,
    `<meta property="og:image" content="${esc(p.photo ? `${siteUrl}${p.photo}` : `${siteUrl}/media/og-image.png`)}">`,
    `<script type="application/ld+json">${jsonLd(siteUrl, p)}</script>`,
  ].join('\n');
  return shell({
    title: `${p.name}, ${trade}${town} | Rregullo`,
    description,
    canonical: `${siteUrl}${p.path}`,
    head: preview ? '' : og,
    main,
    preview,
  });
}
