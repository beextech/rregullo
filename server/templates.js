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
