// Branded emails: Ink background, Paper text, one Vial lime button. Table layout and inline styles,
// because that is what email clients render reliably. Every email has a plain-text version.

const INK = '#16171A';
const INK_2 = '#1E2024';
const PAPER = '#F1F2EF';
const MUTE = '#A9ACA6';
const LIME = '#ABE23F';
const FONT = "'Schibsted Grotesk', Helvetica, Arial, sans-serif";

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function layout({ siteUrl, preheader, bodyHtml, footerHtml }) {
  return `<!doctype html>
<html lang="sq">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>Rregullo</title>
</head>
<body style="margin:0;padding:0;background:${INK};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${INK};">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${INK};">
  <tr><td align="center" style="padding:40px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
      <tr><td style="padding:0 8px 32px;">
        <a href="${esc(siteUrl)}/" style="text-decoration:none;"><img src="${esc(siteUrl)}/email/rregullo-logo.png" width="152" height="48" alt="Rregullo" style="display:block;border:0;width:152px;height:auto;color:${PAPER};font:700 24px ${FONT};"></a>
      </td></tr>
      <tr><td style="background:${INK_2};border:1px solid #2A2C31;border-radius:16px;padding:36px 32px;font-family:${FONT};color:${PAPER};font-size:16px;line-height:1.55;">
        ${bodyHtml}
      </td></tr>
      <tr><td style="padding:24px 8px 0;font-family:${FONT};color:${MUTE};font-size:13px;line-height:1.5;">
        ${footerHtml}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0;">
  <tr><td style="border-radius:999px;background:${LIME};">
    <a href="${esc(href)}" style="display:inline-block;padding:14px 28px;border-radius:999px;background:${LIME};color:${INK};font-family:${FONT};font-size:16px;font-weight:700;text-decoration:none;">${esc(label)}</a>
  </td></tr>
</table>`;
}

const p = (text, extra = '') => `<p style="margin:0 0 16px;${extra}">${esc(text)}</p>`;

/** Double opt-in confirmation. Copy as approved; only the expiry line and the "didn't ask" line are added. */
export function confirmationEmail({ siteUrl, confirmUrl, ttlHours }) {
  const subject = 'Konfirmo emailin për lansimin e Rregullo';
  const html = layout({
    siteUrl,
    preheader: 'Kliko për ta konfirmuar emailin dhe për të marrë njoftimin kur Rregullo të jetë gati.',
    bodyHtml: [
      `<h1 style="margin:0 0 20px;font-size:24px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:${PAPER};">Përshëndetje!</h1>`,
      p('Faleminderit për interesimin për Rregullo.'),
      p('Kliko butonin më poshtë për ta konfirmuar emailin dhe për të marrë njoftimin kur Rregullo të jetë gati.', 'margin-bottom:0;'),
      button(confirmUrl, 'Konfirmo emailin'),
      `<p style="margin:0 0 16px;color:${MUTE};font-size:14px;">Lidhja vlen ${ttlHours} orë. Nëse butoni nuk punon, kopjoje këtë adresë në shfletues:<br><a href="${esc(confirmUrl)}" style="color:${PAPER};word-break:break-all;">${esc(confirmUrl)}</a></p>`,
      p('Me respekt,', 'margin:24px 0 0;'),
      p('Ekipi Rregullo', 'margin:0;font-weight:700;'),
    ].join('\n'),
    footerHtml: `Ky email është dërguar sepse ke kërkuar të njoftohesh rreth lansimit të Rregullo. Nëse nuk e ke kërkuar ti, mos bëj asgjë: adresa fshihet vetvetiu pas 7 ditësh.<br><a href="${esc(siteUrl)}/privatesia" style="color:${MUTE};">Njoftimi për privatësi</a>`,
  });
  const text = `Përshëndetje!

Faleminderit për interesimin për Rregullo.

Kliko lidhjen më poshtë për ta konfirmuar emailin dhe për të marrë njoftimin kur Rregullo të jetë gati.

Konfirmo emailin: ${confirmUrl}
(Lidhja vlen ${ttlHours} orë.)

Me respekt,
Ekipi Rregullo

--
Ky email është dërguar sepse ke kërkuar të njoftohesh rreth lansimit të Rregullo. Nëse nuk e ke kërkuar ti, mos bëj asgjë: adresa fshihet vetvetiu pas 7 ditësh.
Njoftimi për privatësi: ${siteUrl}/privatesia
`;
  return { subject, html, text };
}

/**
 * Launch announcement. Sent only by scripts/send-launch.mjs, only after the team confirms the platform
 * is live. The wording says Rregullo is available, so it must never go out before that is true.
 */
export function launchEmail({ siteUrl, launchUrl, unsubscribeUrl }) {
  const subject = 'Rregullo është gati';
  const html = layout({
    siteUrl,
    preheader: 'Rregullo tani është e hapur. Gjeje mjeshtrin për punët e shpisë.',
    bodyHtml: [
      `<h1 style="margin:0 0 20px;font-size:26px;line-height:1.15;font-weight:700;letter-spacing:-0.02em;color:${PAPER};">Rregullo është gati.</h1>`,
      p('Të premtuam që të lajmërojmë, dhe ja ku jemi. Prej sot mund ta përdorësh Rregullo për me gjetë mjeshtrin e duhur për punët e shpisë.', 'margin-bottom:0;'),
      button(launchUrl, 'Hape Rregullo'),
      p('Faleminderit që ishe ndër të parët.'),
      p('Ekipi Rregullo', 'margin:0;font-weight:700;'),
    ].join('\n'),
    footerHtml: `Ky email të ka ardhur nga Rregullo sepse e konfirmove adresën për njoftimin e lansimit. Ky ishte njoftimi i lansimit; pa pëlqimin tënd të veçantë nuk të dërgojmë email marketingu.<br><a href="${esc(unsubscribeUrl)}" style="color:${PAPER};">Çregjistrohu</a> · <a href="${esc(siteUrl)}/privatesia" style="color:${MUTE};">Njoftimi për privatësi</a>`,
  });
  const text = `Rregullo është gati.

Të premtuam që të lajmërojmë, dhe ja ku jemi. Prej sot mund ta përdorësh Rregullo për me gjetë mjeshtrin e duhur për punët e shpisë.

Hape Rregullo: ${launchUrl}

Faleminderit që ishe ndër të parët.
Ekipi Rregullo

--
Ky email të ka ardhur nga Rregullo sepse e konfirmove adresën për njoftimin e lansimit.
Çregjistrohu: ${unsubscribeUrl}
Njoftimi për privatësi: ${siteUrl}/privatesia
`;
  return { subject, html, text };
}

/** Internal note to the team. One signup per email, address masked, plus the list totals. */
export function teamNotificationEmail({ event, maskedEmail, at, totals }) {
  const when = new Date(at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const subject = event === 'confirmed' ? 'Rregullo: regjistrim i ri i konfirmuar' : 'Rregullo: kërkesë e re për njoftim';
  const status = event === 'confirmed' ? 'I konfirmuar' : 'Në pritje të konfirmimit';
  const lines = [
    `Statusi: ${status}`,
    `Koha: ${when}`,
    `Adresa: ${maskedEmail}`,
    `Lista tani: ${totals.confirmed} të konfirmuar, ${totals.pending} në pritje`,
  ];
  const text = `${lines.join('\n')}\n\nLista e plotë mbetet vetëm në bazën e të dhënave (shih README, "Manage the list").\n`;
  const html = `<div style="font-family:${FONT};font-size:15px;line-height:1.6;color:#16171A;">${lines.map((l) => esc(l)).join('<br>')}<p style="color:#555;font-size:13px;">Lista e plotë mbetet vetëm në bazën e të dhënave (shih README, "Manage the list").</p></div>`;
  return { subject, html, text };
}

/**
 * Sign-in to the team panel: a link (the token rides in the URL fragment, so it never reaches a server log) and the
 * same sign-in as a 6-digit code, for when the link opens in another browser (a mail app's own, say).
 * In the text version the code comes before the link.
 */
export function adminLinkEmail({ siteUrl, linkUrl, code, ttlMinutes }) {
  const subject = 'Hyrja në panelin e ekipit të Rregullo';
  const html = layout({
    siteUrl,
    preheader: `Lidhja dhe kodi për të hyrë në panelin e ekipit. Vlejnë ${ttlMinutes} minuta.`,
    bodyHtml: [
      `<h1 style="margin:0 0 20px;font-size:24px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:${PAPER};">Hyrja në panelin e ekipit</h1>`,
      p('Kliko butonin për të hyrë në panelin e ekipit të Rregullo.', 'margin-bottom:0;'),
      button(linkUrl, 'Hyr në panel'),
      p('Nëse lidhja hapet në një shfletues tjetër, shkruaje këtë kod në faqen ku e kërkove:'),
      `<p style="margin:0 0 20px;font-size:32px;line-height:1.2;font-weight:700;letter-spacing:0.2em;color:${PAPER};">${esc(code)}</p>`,
      `<p style="margin:0 0 16px;color:${MUTE};font-size:14px;">Lidhja dhe kodi vlejnë ${ttlMinutes} minuta dhe përdoren vetëm një herë. Nëse butoni nuk punon, kopjoje këtë adresë në shfletues:<br><a href="${esc(linkUrl)}" style="color:${PAPER};word-break:break-all;">${esc(linkUrl)}</a></p>`,
    ].join('\n'),
    footerHtml: 'Ky email u dërgua sepse dikush kërkoi të hyjë në panelin e ekipit të Rregullo me këtë adresë. Nëse nuk e ke kërkuar ti, mos bëj asgjë.',
  });
  const text = `Hyrja në panelin e ekipit të Rregullo

Kodi: ${code}

Hyr në panel: ${linkUrl}

Lidhja dhe kodi vlejnë ${ttlMinutes} minuta dhe përdoren vetëm një herë. Nëse lidhja hapet në një shfletues tjetër, shkruaje kodin në faqen ku e kërkove.

--
Ky email u dërgua sepse dikush kërkoi të hyjë në panelin e ekipit të Rregullo me këtë adresë. Nëse nuk e ke kërkuar ti, mos bëj asgjë.
`;
  return { subject, html, text };
}

/**
 * To the team: the approval queue has something new (a profile sent for approval, or a review a mjeshtër reported).
 * No name, number or id: only the counts and the panel's link.
 */
export function adminQueueEmail({ siteUrl, pendingCount, reportedCount = 0 }) {
  const reviewsOnly = !pendingCount && reportedCount > 0;
  const subject = reviewsOnly ? 'Një vlerësim i raportuar pret shqyrtim' : 'Një profil i ri pret shqyrtim';
  const listUrl = `${siteUrl}/admin/#lista`;
  const waiting = pendingCount === 1 ? '1 profil' : `${pendingCount} profile`;
  const reported = reportedCount === 1 ? '1 vlerësim i raportuar' : `${reportedCount} vlerësime të raportuara`;
  const lead = reviewsOnly ? 'Një mjeshtër e raportoi një vlerësim.' : 'Një mjeshtër e dërgoi profilin për aprovim.';
  const counts = `Në pritje tani: ${waiting}${reportedCount ? ` dhe ${reported}` : ''}.`;
  const html = layout({
    siteUrl,
    preheader: counts,
    bodyHtml: [
      `<h1 style="margin:0 0 20px;font-size:24px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:${PAPER};">${esc(subject)}</h1>`,
      p(`${lead} ${counts}`, 'margin-bottom:0;'),
      button(listUrl, 'Hape panelin e ekipit'),
    ].join('\n'),
    footerHtml: 'Ky email u dërgua sepse adresa jote është në listën e ekipit të Rregullo. Të dërgojmë më së shumti një të tillë në orë.',
  });
  const text = `${subject}

${lead} ${counts}

Hape panelin e ekipit: ${listUrl}

--
Ky email u dërgua sepse adresa jote është në listën e ekipit të Rregullo. Të dërgojmë më së shumti një të tillë në orë.
`;
  return { subject, html, text };
}

/**
 * To a client who reviewed a mjeshtër: the link that publishes the review. The same link later lets them delete it.
 * Says which mjeshtër and how many stars, so someone who didn't write it can tell and ignore it.
 */
export function reviewConfirmEmail({ siteUrl, confirmUrl, proName, stars, ttlHours }) {
  const subject = 'Konfirmo vlerësimin tënd në Rregullo';
  const starsText = stars === 1 ? '1 yll' : `${stars} yje`;
  const html = layout({
    siteUrl,
    preheader: `Kliko për ta publikuar vlerësimin për ${proName}.`,
    bodyHtml: [
      `<h1 style="margin:0 0 20px;font-size:24px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:${PAPER};">Faleminderit për vlerësimin!</h1>`,
      p(`E vlerësove ${proName} me ${starsText}. Kliko butonin dhe vlerësimi yt shfaqet në profilin e mjeshtrit.`, 'margin-bottom:0;'),
      button(confirmUrl, 'Publiko vlerësimin'),
      `<p style="margin:0 0 16px;color:${MUTE};font-size:14px;">Lidhja e publikon vlerësimin brenda ${ttlHours} orësh. Ruaje këtë email: me të njëjtën lidhje mund ta fshish vlerësimin më vonë. Nëse butoni nuk punon, kopjoje këtë adresë në shfletues:<br><a href="${esc(confirmUrl)}" style="color:${PAPER};word-break:break-all;">${esc(confirmUrl)}</a></p>`,
      p('Me respekt,', 'margin:24px 0 0;'),
      p('Ekipi Rregullo', 'margin:0;font-weight:700;'),
    ].join('\n'),
    footerHtml: `Ky email u dërgua sepse dikush e vlerësoi një mjeshtër në Rregullo me këtë adresë. Nëse nuk e ke bërë ti, mos bëj asgjë: vlerësimi nuk shfaqet dhe fshihet pas ${ttlHours} orësh.<br><a href="${esc(siteUrl)}/privatesia#klientet" style="color:${MUTE};">Njoftimi për privatësi</a>`,
  });
  const text = `Faleminderit për vlerësimin!

E vlerësove ${proName} me ${starsText}. Kliko lidhjen dhe vlerësimi yt shfaqet në profilin e mjeshtrit.

Publiko vlerësimin: ${confirmUrl}

Lidhja e publikon vlerësimin brenda ${ttlHours} orësh. Ruaje këtë email: me të njëjtën lidhje mund ta fshish vlerësimin më vonë.

Me respekt,
Ekipi Rregullo

--
Ky email u dërgua sepse dikush e vlerësoi një mjeshtër në Rregullo me këtë adresë. Nëse nuk e ke bërë ti, mos bëj asgjë: vlerësimi nuk shfaqet dhe fshihet pas ${ttlHours} orësh.
Njoftimi për privatësi: ${siteUrl}/privatesia#klientet
`;
  return { subject, html, text };
}
