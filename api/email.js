// ── email.js — SendGrid email API ─────────────────────────────────
// Warm, personal templates with navy anchor. Designed for Gmail/Apple Mail
// with graceful degradation in Outlook (uses tables, avoids flex/grid).
//
// Required env vars: SENDGRID_API_KEY, FROM_EMAIL

const BRAND = {
  name: 'Auto Pals USA',
  city: 'Pompano Beach, FL',
  navy: '#0f2557',
  navyDeep: '#0a1b3f',
  cream: '#faf6ed',
  creamDark: '#f0e9d8',
  paper: '#ffffff',
  ink: '#1a1f36',
  muted: '#5a6480',
  mutedSoft: '#8b93a8',
  accent: '#c9a961',
  border: '#e4dcc6',
  green: '#2d7a4f',
  greenSoft: '#e8f2ec',
  red: '#b03a3a',
  redSoft: '#fbeded'
};

function header() {
  return `
    <tr>
      <td style="padding:32px 40px 0;">
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;color:${BRAND.navy};letter-spacing:-0.01em;">
          Auto Pals USA
        </div>
        <div style="font-family:Georgia,serif;font-size:11px;font-style:italic;color:${BRAND.mutedSoft};margin-top:2px;letter-spacing:0.02em;">
          Your personal car-sourcing team
        </div>
        <div style="border-bottom:1px solid ${BRAND.border};margin-top:20px;"></div>
      </td>
    </tr>`;
}

function footer(d = {}) {
  const portalLink = d.portalUrl
    ? ` or check your <a href="${d.portalUrl}" style="color:${BRAND.navy};text-decoration:underline;">portal</a>`
    : '';
  return `
    <tr>
      <td style="padding:28px 40px 36px;">
        <div style="border-top:1px solid ${BRAND.border};padding-top:24px;">
          <div style="font-family:'Brush Script MT','Lucida Handwriting',cursive;font-size:26px;color:${BRAND.navy};line-height:1;margin-bottom:6px;">
            Alex &amp; Josh
          </div>
          <div style="font-family:Georgia,serif;font-size:12px;font-style:italic;color:${BRAND.mutedSoft};letter-spacing:0.02em;">
            Co-founders &middot; Auto Pals USA
          </div>
        </div>
        <div style="margin-top:20px;font-family:-apple-system,'Segoe UI',sans-serif;font-size:11px;color:${BRAND.mutedSoft};line-height:1.6;">
          Auto Pals USA &middot; Pompano Beach, FL<br>
          Reply to this email any time${portalLink}. We read every message.
        </div>
      </td>
    </tr>`;
}

function shell(inner) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${BRAND.name}</title></head>
<body style="margin:0;padding:0;background:${BRAND.cream};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream};"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="580" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;width:100%;background:${BRAND.paper};border:1px solid ${BRAND.border};border-radius:14px;overflow:hidden;">
${inner}
</table>
<div style="max-width:580px;margin:16px auto 0;font-family:-apple-system,'Segoe UI',sans-serif;font-size:11px;color:${BRAND.mutedSoft};text-align:center;line-height:1.6;">
You received this email because you submitted a request at autopalsusa.com.
</div>
</td></tr></table></body></html>`;
}

function button(href, label, opts = {}) {
  const bg = opts.bg || BRAND.navy;
  const color = opts.color || BRAND.cream;
  return `<a href="${href}" style="display:inline-block;background:${bg};color:${color};font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;font-weight:600;padding:13px 28px;border-radius:8px;text-decoration:none;letter-spacing:0.01em;">${label}</a>`;
}

function buttonSecondary(href, label) {
  return `<a href="${href}" style="display:inline-block;background:transparent;color:${BRAND.navy};font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;font-weight:600;padding:11px 22px;border-radius:8px;text-decoration:none;border:1px solid ${BRAND.border};margin-left:10px;">${label}</a>`;
}

const TEMPLATES = {
  confirmation: (d) => ({
    subject: `We got your request, ${d.firstName} — let's find your car`,
    html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:26px;font-weight:700;color:${BRAND.ink};line-height:1.25;margin-bottom:14px;">Hey ${d.firstName}, we got your request.</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 22px;">Thanks for trusting us with your search. One of us will personally look over your details and reach out within 24 hours. In the meantime, the fastest way to get moving is to book your intro call below — it takes 30 minutes and we'll walk through exactly how this works.</p>
</td></tr>
${d.portalCode ? `<tr><td style="padding:0 40px 22px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream};border:1px solid ${BRAND.border};border-radius:10px;"><tr><td style="padding:18px 22px;">
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${BRAND.mutedSoft};margin-bottom:6px;">🔑 Your portal access code — save this email</div>
<div style="font-family:'SF Mono','Menlo','Consolas',monospace;font-size:22px;font-weight:700;color:${BRAND.navy};letter-spacing:0.06em;margin-bottom:8px;">${d.portalCode}</div>
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:12px;color:${BRAND.muted};line-height:1.55;">Use this on the portal page to check status, message us, view recommendations, and sign your service agreement. Anyone with this code can see your request, so keep it private.</div>
</td></tr></table>
</td></tr>` : ''}
<tr><td style="padding:0 40px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream};border-radius:10px;"><tr><td style="padding:22px 24px;">
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${BRAND.mutedSoft};margin-bottom:14px;">Your Request</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;">
<tr><td style="padding:6px 0;color:${BRAND.muted};width:40%;">Vehicle</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.make ? d.make + (d.model && d.model !== '—' ? ' ' + d.model : '') : 'Open Search'}</td></tr>
<tr><td style="padding:6px 0;color:${BRAND.muted};">Year Range</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.yearFrom}${d.yearTo && d.yearTo !== d.yearFrom ? '–' + d.yearTo : ''}</td></tr>
<tr><td style="padding:6px 0;color:${BRAND.muted};">Budget</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">$${Number(d.budgetMin).toLocaleString()}–$${Number(d.budgetMax).toLocaleString()}</td></tr>
</table>
</td></tr></table>
</td></tr>
<tr><td style="padding:0 40px 12px;">
<div style="font-family:Georgia,serif;font-size:15px;font-weight:700;color:${BRAND.navy};margin-bottom:10px;">📅 Next step — book a 30-min call</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;color:${BRAND.muted};line-height:1.65;margin:0 0 18px;">Pick a time that works. Monday through Friday, 9am–5pm ET.</p>
${button(d.bookingUrl, 'Book your call →')}
${d.portalUrl ? buttonSecondary(d.portalUrl, 'View portal') : ''}
</td></tr>
${footer(d)}`)
  }),

  // Client confirmation when they sign the contract. Welcomes them in,
  // confirms the 60-day search window is live.
  contractSigned: (d) => ({
    subject: `Contract signed — your search starts now, ${d.firstName}`,
    html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:14px;">Welcome aboard, ${d.firstName}.</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 22px;">Your service agreement is signed and your deposit is in. Your 60-day search window is officially live — our team starts hunting auctions for your match today.</p>
</td></tr>
<tr><td style="padding:0 40px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.greenSoft};border-left:3px solid ${BRAND.green};border-radius:0 8px 8px 0;"><tr><td style="padding:16px 20px;">
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;color:${BRAND.ink};line-height:1.7;"><strong style="color:${BRAND.green};">What happens next:</strong> we'll be in touch through your portal as soon as we find vehicles worth your attention. Most clients see their first matches within the first 1–2 weeks.</div>
</td></tr></table>
</td></tr>
<tr><td style="padding:0 40px 12px;">${button(d.portalUrl, 'Open your portal →', { bg: BRAND.green })}</td></tr>
<tr><td style="padding:0 40px 8px;">
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;color:${BRAND.muted};line-height:1.65;margin:8px 0 0;">Questions or want to adjust your search? Just reply to this email — we read every message.</p>
</td></tr>
${footer(d)}`)
  }),

  // Staff fan-out when a client signs. Pairs with the staff_contract_signed SMS.
  staffContractSigned: (d) => ({
    subject: `🖊 Contract signed — ${d.clientName || 'client'}`,
    html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:8px;">Contract signed</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;color:${BRAND.muted};line-height:1.65;margin:0 0 18px;">Search window is officially live for this client.</p>
</td></tr>
<tr><td style="padding:0 40px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream};border-radius:10px;"><tr><td style="padding:18px 22px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;">
<tr><td style="padding:6px 0;color:${BRAND.muted};width:38%;">Client</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.clientName || '—'}</td></tr>
${d.clientEmail ? `<tr><td style="padding:6px 0;color:${BRAND.muted};">Email</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.clientEmail}</td></tr>` : ''}
${d.clientPhone ? `<tr><td style="padding:6px 0;color:${BRAND.muted};">Phone</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.clientPhone}</td></tr>` : ''}
${d.vehicleStr ? `<tr><td style="padding:6px 0;color:${BRAND.muted};">Vehicle</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.vehicleStr}</td></tr>` : ''}
<tr><td style="padding:6px 0;color:${BRAND.muted};">Signed name</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.signatureName || '—'}</td></tr>
<tr><td style="padding:6px 0;color:${BRAND.muted};">Signed at</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.signedAt || '—'}</td></tr>
${d.portalCode ? `<tr><td style="padding:6px 0;color:${BRAND.muted};">Portal code</td><td style="padding:6px 0;color:${BRAND.navy};font-weight:700;text-align:right;font-size:12px;">${d.portalCode}</td></tr>` : ''}
</table>
</td></tr></table>
</td></tr>
${footer(d)}`)
  }),

  // Sent by /api/portal-recover when a client clicks "Forgot your code?".
  // Lists all portal codes tied to the email they entered.
  portalCodeRecovery: (d) => ({
    subject: `Your Auto Pals USA portal code${(d.codes && d.codes.length > 1) ? 's' : ''}`,
    html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:14px;">Here ${(d.codes && d.codes.length > 1) ? 'are your portal codes' : 'is your portal code'}.</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 22px;">You requested a code reminder for ${d.email}. Use ${(d.codes && d.codes.length > 1) ? 'any of these' : 'this'} on the portal page to access your account.</p>
</td></tr>
<tr><td style="padding:0 40px 22px;">
${(d.codes || []).map((c, i) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream};border:1px solid ${BRAND.border};border-radius:10px;margin-bottom:10px;"><tr><td style="padding:16px 22px;">
${c.vehicleStr ? `<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:11px;color:${BRAND.muted};margin-bottom:4px;">${c.vehicleStr}</div>` : ''}
<div style="font-family:'SF Mono','Menlo','Consolas',monospace;font-size:22px;font-weight:700;color:${BRAND.navy};letter-spacing:0.06em;">${c.code}</div>
</td></tr></table>`).join('')}
</td></tr>
<tr><td style="padding:0 40px 12px;">${button(d.portalUrl, 'Open the portal →')}</td></tr>
<tr><td style="padding:0 40px 8px;">
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;color:${BRAND.muted};line-height:1.65;margin:8px 0 0;">If you didn't request this, you can safely ignore this email — your account is unchanged.</p>
</td></tr>
${footer(d)}`)
  }),

  rejected: (d) => ({
    subject: `About your vehicle request`,
    html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:14px;">Hi ${d.firstName},</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.75;margin:0 0 20px;">Thanks for reaching out. After looking at your request, we have to be honest with you — we won't be able to help at this budget, and we'd rather tell you now than waste your time.</p>
</td></tr>
<tr><td style="padding:0 40px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.redSoft};border-left:3px solid ${BRAND.red};border-radius:0 8px 8px 0;"><tr><td style="padding:16px 20px;">
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;font-weight:700;color:${BRAND.red};margin-bottom:6px;">Budget below our $4,000 minimum</div>
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;color:${BRAND.muted};line-height:1.6;">Below this threshold it gets extremely hard to find a vehicle in decent condition after auction fees, transport, and our service costs. We don't want to take a deposit knowing the search is stacked against you.</div>
</td></tr></table>
</td></tr>
<tr><td style="padding:0 40px 28px;">
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;color:${BRAND.muted};line-height:1.7;margin:0;">If your budget changes, we'd love to help. Just reply to this email or submit a new request — no hard feelings, and we appreciate you reaching out.</p>
</td></tr>
${footer(d)}`)
  }),

  statusUpdate: (d) => ({
    subject: `Quick update on your search, ${d.firstName}`,
    html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:10px;">A quick update for you</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 22px;">Hi ${d.firstName} — wanted to give you the latest on your ${d.make ? d.make + (d.model && d.model !== '—' ? ' ' + d.model : '') : 'vehicle'} search.</p>
</td></tr>
<tr><td style="padding:0 40px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream};border-left:3px solid ${BRAND.navy};border-radius:0 8px 8px 0;"><tr><td style="padding:18px 22px;">
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${BRAND.mutedSoft};margin-bottom:6px;">Current Status</div>
<div style="font-family:Georgia,serif;font-size:18px;font-weight:700;color:${BRAND.navy};line-height:1.3;">${d.statusLabel}</div>
${d.statusNote ? `<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;color:${BRAND.muted};margin:10px 0 0;line-height:1.65;">${d.statusNote}</p>` : ''}
</td></tr></table>
</td></tr>
<tr><td style="padding:0 40px 12px;">${button(d.portalUrl, 'View your portal →')}</td></tr>
${footer(d)}`)
  }),

  vehicleFound: (d) => ({
    subject: `🚗 We found your car, ${d.firstName}`,
    html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.greenSoft};border-radius:10px;margin-bottom:20px;"><tr><td style="padding:16px 20px;">
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${BRAND.green};margin-bottom:4px;">✓ Match Found</div>
<div style="font-family:Georgia,serif;font-size:15px;color:${BRAND.ink};font-weight:600;">We located a vehicle that matches your request.</div>
</td></tr></table>
<div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:12px;">This is the one, ${d.firstName}.</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 22px;">We've tracked down a vehicle through our dealer auction network that fits your request. Full details, photos, and the auction info are waiting for you in your portal. Let's hop on a call to walk through it together.</p>
</td></tr>
<tr><td style="padding:0 40px 12px;">${button(d.portalUrl, 'View vehicle details →', { bg: BRAND.green })}</td></tr>
<tr><td style="padding:0 40px 8px;">
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;color:${BRAND.muted};line-height:1.65;margin:8px 0 0;">Reply to this email to schedule the call or ask any questions.</p>
</td></tr>
${footer(d)}`)
  }),

  depositReceipt: (d) => ({
    subject: `Deposit received — your search is live`,
    html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:10px;">Deposit received, ${d.firstName}.</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 22px;">Thanks — your 60-day search officially starts now. Here's your receipt for the records. We'll be actively hunting starting today.</p>
</td></tr>
<tr><td style="padding:0 40px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream};border-radius:10px;"><tr><td style="padding:22px 26px;">
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${BRAND.mutedSoft};margin-bottom:16px;">Receipt</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;">
<tr><td style="padding:8px 0;color:${BRAND.muted};border-bottom:1px solid ${BRAND.border};">Amount</td><td style="padding:8px 0;color:${BRAND.ink};font-weight:600;text-align:right;border-bottom:1px solid ${BRAND.border};">$750.00</td></tr>
<tr><td style="padding:8px 0;color:${BRAND.muted};border-bottom:1px solid ${BRAND.border};">Date</td><td style="padding:8px 0;color:${BRAND.ink};font-weight:600;text-align:right;border-bottom:1px solid ${BRAND.border};">${d.depositDate}</td></tr>
<tr><td style="padding:8px 0;color:${BRAND.muted};border-bottom:1px solid ${BRAND.border};">Reference</td><td style="padding:8px 0;color:${BRAND.navy};font-weight:700;text-align:right;font-size:12px;border-bottom:1px solid ${BRAND.border};">${d.depositRef}</td></tr>
<tr><td style="padding:8px 0;color:${BRAND.muted};">Search window</td><td style="padding:8px 0;color:${BRAND.ink};font-weight:600;text-align:right;">60 days</td></tr>
<tr><td style="padding:14px 0 0;color:${BRAND.ink};font-weight:700;font-size:15px;border-top:2px solid ${BRAND.border};">Total paid</td><td style="padding:14px 0 0;color:${BRAND.navy};font-weight:700;font-size:16px;text-align:right;border-top:2px solid ${BRAND.border};">$750.00</td></tr>
</table>
</td></tr></table>
</td></tr>
<tr><td style="padding:0 40px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.greenSoft};border-left:3px solid ${BRAND.green};border-radius:0 8px 8px 0;"><tr><td style="padding:14px 20px;">
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;color:${BRAND.ink};line-height:1.6;"><strong style="color:${BRAND.green};">What happens next:</strong> We start searching auctions today. As soon as we find a match, you'll hear from us — most searches end within the 60-day window.</div>
</td></tr></table>
</td></tr>
<tr><td style="padding:0 40px 12px;">${button(d.portalUrl, 'Track your search →')}</td></tr>
${footer(d)}`)
  }),

  scheduleCall: (d) => ({
    subject: `Let's talk, ${d.firstName}`,
    html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:14px;">Ready when you are, ${d.firstName}.</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 22px;">Your request looks good and we're ready to get started. Grab 30 minutes with Alex or Josh — we'll go over the details, walk through how auctions work, and kick off the real search.</p>
</td></tr>
<tr><td style="padding:0 40px 22px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream};border-radius:10px;"><tr><td style="padding:20px 24px;">
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${BRAND.mutedSoft};margin-bottom:12px;">What we'll cover</div>
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;color:${BRAND.muted};line-height:1.9;">
<span style="color:${BRAND.navy};">✓</span> Confirm your vehicle preferences<br>
<span style="color:${BRAND.navy};">✓</span> Walk through the auction process<br>
<span style="color:${BRAND.navy};">✓</span> Set realistic expectations on timeline<br>
<span style="color:${BRAND.navy};">✓</span> Answer any questions you have
</div>
</td></tr></table>
</td></tr>
<tr><td style="padding:0 40px 12px;">${button(d.bookingUrl, 'Book your call →')}</td></tr>
<tr><td style="padding:0 40px 8px;">
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:12px;color:${BRAND.mutedSoft};line-height:1.6;margin:8px 0 0;">30 minutes &middot; Monday–Friday, 9am–5pm ET</p>
</td></tr>
${footer(d)}`)
  }),

  // ─── BOOKING REMINDERS ────────────────────────────────────────
  // Sent at 24h, 72h, 7 days if no call booked after form submission
  bookingReminder1: (d) => ({
    subject: `Still here when you're ready, ${d.firstName}`,
    html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:14px;">Friendly nudge, ${d.firstName} 👋</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 14px;">Saw your request for ${d.make ? `a ${d.make}${d.model && d.model !== '—' ? ' ' + d.model : ''}` : 'a vehicle'} yesterday and wanted to check in. The next step is just a quick 30-minute call — we can't start sourcing until we've talked through the details.</p>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;color:${BRAND.muted};line-height:1.7;margin:0 0 22px;">Most of our clients book this within a day of submitting. If something came up, no worries — just grab a time whenever you're free.</p>
</td></tr>
<tr><td style="padding:0 40px 12px;">${button(d.bookingUrl, 'Book your call →')}</td></tr>
${footer(d)}`)
  }),

  // 48h — casual "we're prepping, just need 30 min" follow-up
  bookingReminder2: (d) => {
    const vehicle = d.make
      ? `${d.make}${d.model && d.model !== '—' ? ' ' + d.model : ''}`
      : 'vehicle';
    return ({
      subject: `Quick thought, ${d.firstName}`,
      html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:14px;">Quick thought, ${d.firstName}.</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 18px;">Wanted to circle back on your ${vehicle} request. Our team's already getting prepped to start hunting — we just need 30 minutes on the phone first to lock in exactly what you want.</p>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 22px;">We're at 3 South Florida dealer auctions every week. The sooner we sync up, the sooner we can start watching for your match.</p>
</td></tr>
<tr><td style="padding:0 40px 12px;">${button(d.bookingUrl, 'Book your call →')}</td></tr>
<tr><td style="padding:0 40px 8px;">
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;color:${BRAND.muted};line-height:1.65;margin:8px 0 0;">Not sure what you want yet? Book the call anyway — we'll help you figure it out.</p>
</td></tr>
${footer(d)}`)
    });
  },

  // 72h — light check-in (was bookingReminder2 before the 48h slot was added)
  bookingReminder3: (d) => {
    const vehicle = d.make
      ? `${d.make}${d.model && d.model !== '—' ? ' ' + d.model : ''}`
      : 'car';
    return ({
      subject: `Hey ${d.firstName} — did you find that ${vehicle} yet?`,
      html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:14px;">Just checking in, ${d.firstName}.</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 18px;">Did you already grab that ${vehicle} you were looking for, or are you still on the hunt? Either way, no worries — just wanted to check in.</p>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 22px;">If you're still looking, we'd love to help. Most of our clients find their match within 30 days once we kick things off, and the first step is just a quick 30-minute call to figure out exactly what you want.</p>
</td></tr>
<tr><td style="padding:0 40px 12px;">${button(d.bookingUrl, 'Book a call →')}</td></tr>
<tr><td style="padding:0 40px 8px;">
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;color:${BRAND.muted};line-height:1.65;margin:8px 0 0;">Already found one? That's awesome — just reply and let us know so we can close things out on our end.</p>
</td></tr>
${footer(d)}`)
    });
  },

  // 96h — "saving your spot" / scarcity framing, day before the last note
  bookingReminder4: (d) => {
    const vehicle = d.make
      ? `${d.make}${d.model && d.model !== '—' ? ' ' + d.model : ''}`
      : 'vehicle';
    return ({
      subject: `Saving you a spot, ${d.firstName}?`,
      html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:14px;">Holding your spot, ${d.firstName}.</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 18px;">We only actively source for a handful of clients at any one time — and your request is still on our list. If you're still in the market for a ${vehicle}, grab a 30-minute call and we'll kick off the search the same week.</p>
</td></tr>
<tr><td style="padding:0 40px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream};border-left:3px solid ${BRAND.navy};border-radius:0 8px 8px 0;"><tr><td style="padding:16px 20px;">
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;color:${BRAND.muted};line-height:1.7;">No commitment until you decide to put down the $750 deposit — and that's fully refundable if we don't find a match in 60 days.</div>
</td></tr></table>
</td></tr>
<tr><td style="padding:0 40px 12px;">${button(d.bookingUrl, 'Book your call →')}</td></tr>
${footer(d)}`)
    });
  },

  // 168h / 7-day — last note (was bookingReminder3 under the old schedule)
  bookingReminder5: (d) => ({
    subject: `Closing your request soon, ${d.firstName}`,
    html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:14px;">Last note on this, ${d.firstName}.</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 20px;">It's been a week since you submitted your request and we haven't been able to connect. We'll go ahead and close out this request for now — but the door's still open anytime you want to pick this back up.</p>
</td></tr>
<tr><td style="padding:0 40px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream};border-radius:10px;"><tr><td style="padding:18px 22px;">
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;color:${BRAND.muted};line-height:1.7;">If you still want to work with us, just book a time below or reply to this email. No pressure, no hard feelings. We'll reactivate your search the moment we talk.</div>
</td></tr></table>
</td></tr>
<tr><td style="padding:0 40px 12px;">${button(d.bookingUrl, 'Book a call →')}</td></tr>
${footer(d)}`)
  }),

  // ─── DEPOSIT REMINDERS ────────────────────────────────────────
  // Sent at 24h, 48h, and 72h after call marked complete, if no deposit received.
  // 1 = friendly nudge, 2 = gentle middle check-in, 3 = firmer last call.
  depositReminder1: (d) => ({
    subject: `Quick follow-up from our call, ${d.firstName}`,
    html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:14px;">Great talking yesterday, ${d.firstName}.</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 20px;">Thanks for the call. To officially kick off your 60-day search, we just need the $750 deposit. Once we have it, our team starts hunting through dealer auctions that same day.</p>
</td></tr>
<tr><td style="padding:0 40px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream};border-left:3px solid ${BRAND.navy};border-radius:0 8px 8px 0;"><tr><td style="padding:18px 22px;">
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${BRAND.mutedSoft};margin-bottom:8px;">Why a deposit?</div>
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;color:${BRAND.muted};line-height:1.65;">It's what lets us commit real auction time to your search. If we don't find a match in 60 days, you get the full $750 back — no strings, no fees.</div>
</td></tr></table>
</td></tr>
<tr><td style="padding:0 40px 12px;">${button(d.portalUrl, 'Submit your deposit →')}</td></tr>
<tr><td style="padding:0 40px 8px;">
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;color:${BRAND.muted};line-height:1.65;margin:8px 0 0;">Questions about anything? Just reply and we'll sort it out.</p>
</td></tr>
${footer(d)}`)
  }),

  // 48h — gentle middle nudge, not pushy yet
  depositReminder2: (d) => ({
    subject: `Following up on your deposit, ${d.firstName}`,
    html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:14px;">Just a friendly nudge, ${d.firstName}.</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 18px;">Wanted to make sure the Zelle deposit instructions came through okay — they're in your portal if you need them again. As soon as we see the $750 land, the search kicks off that same day.</p>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 22px;">Quick reminder: it's fully refundable if we don't find your car within 60 days. No risk on your end.</p>
</td></tr>
<tr><td style="padding:0 40px 12px;">${button(d.portalUrl, 'Submit your deposit →')}</td></tr>
<tr><td style="padding:0 40px 8px;">
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;color:${BRAND.muted};line-height:1.65;margin:8px 0 0;">Anything holding things up? Just reply and we'll help sort it out.</p>
</td></tr>
${footer(d)}`)
  }),

  // 72h — firmer last call (was depositReminder2 before the 48h slot was added)
  depositReminder3: (d) => ({
    subject: `Ready to start your search, ${d.firstName}?`,
    html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:14px;">Just checking in, ${d.firstName}.</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 20px;">It's been a few days since we talked and we haven't received the deposit yet. <strong style="color:${BRAND.ink};">We can't begin sourcing your vehicle until the deposit is in.</strong> Just want to make sure nothing's fallen through the cracks.</p>
</td></tr>
<tr><td style="padding:0 40px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream};border-radius:10px;"><tr><td style="padding:18px 22px;">
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;color:${BRAND.muted};line-height:1.7;"><strong style="color:${BRAND.ink};">Reminder:</strong> $750 kicks off your 60-day search window. If we don't find a match in that time, you get it all back.</div>
</td></tr></table>
</td></tr>
<tr><td style="padding:0 40px 12px;">${button(d.portalUrl, 'Submit your deposit →')}</td></tr>
<tr><td style="padding:0 40px 8px;">
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;color:${BRAND.muted};line-height:1.65;margin:8px 0 0;">If you've changed your mind or something's come up, no problem — just let us know so we can close things out on our end.</p>
</td></tr>
${footer(d)}`)
  }),

  // ─── LONG-TERM DORMANT RE-ENGAGEMENT ─────────────────────────
  // Sent to clients who go quiet after the short-term booking drip.
  // d1 = 14 days post-signup, d2 = 44d (~1mo after d1), d3 = 104d (~3mo after d1).
  // Cron stops the campaign the moment deposit_paid flips true.
  dormantReminder1: (d) => {
    const vehicle = d.make
      ? `${d.make}${d.model && d.model !== '—' ? ' ' + d.model : ''}`
      : 'vehicle';
    return ({
      subject: `Ready when you are, ${d.firstName}`,
      html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:14px;">Hey ${d.firstName} — checking back in.</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 18px;">It's been a couple of weeks since you submitted your ${vehicle} request and we wanted to circle back. No pressure — we know life gets in the way — but we're ready whenever you are.</p>
</td></tr>
<tr><td style="padding:0 40px 22px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream};border-radius:10px;"><tr><td style="padding:20px 24px;">
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${BRAND.mutedSoft};margin-bottom:12px;">What you signed up for</div>
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;color:${BRAND.muted};line-height:1.9;">
<span style="color:${BRAND.navy};">✓</span> Personal vehicle sourcing through dealer-only auctions<br>
<span style="color:${BRAND.navy};">✓</span> Wholesale pricing, not retail<br>
<span style="color:${BRAND.navy};">✓</span> 60-day search window, $750 deposit (fully refundable if no match)<br>
<span style="color:${BRAND.navy};">✓</span> Free 30-minute intro call to kick everything off
</div>
</td></tr></table>
</td></tr>
<tr><td style="padding:0 40px 12px;">${button(d.bookingUrl, 'Book your intro call →')}</td></tr>
<tr><td style="padding:0 40px 8px;">
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;color:${BRAND.muted};line-height:1.65;margin:8px 0 0;">Changed your mind, or already bought somewhere else? Just reply and let us know so we can close your file — no hard feelings either way.</p>
</td></tr>
${footer(d)}`)
    });
  },

  dormantReminder2: (d) => {
    const vehicle = d.make
      ? `${d.make}${d.model && d.model !== '—' ? ' ' + d.model : ''}`
      : 'car';
    return ({
      subject: `Still thinking about that ${vehicle}, ${d.firstName}?`,
      html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:14px;">Quick check-in, ${d.firstName}.</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 18px;">A month has gone by since we first reached out about your ${vehicle} search. The market has shifted a bit — auction inventory's been good lately, and if you're still in the market we'd love to help you find a deal.</p>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 22px;">All it takes to start is a 30-minute call. No commitment until you decide to put down the deposit.</p>
</td></tr>
<tr><td style="padding:0 40px 12px;">${button(d.bookingUrl, 'Book your call →')}</td></tr>
<tr><td style="padding:0 40px 8px;">
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;color:${BRAND.muted};line-height:1.65;margin:8px 0 0;">If we should close out your request, just reply STOP-LOOKING and we'll take it from there.</p>
</td></tr>
${footer(d)}`)
    });
  },

  dormantReminder3: (d) => {
    const vehicle = d.make
      ? `${d.make}${d.model && d.model !== '—' ? ' ' + d.model : ''}`
      : 'vehicle';
    return ({
      subject: `Last check-in, ${d.firstName} — door's still open`,
      html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:14px;">Last note, ${d.firstName}.</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 18px;">It's been about three months since we reached out. We won't keep emailing — but the door is still open if you ever want to pick the ${vehicle} search back up.</p>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 22px;">If your timing's better now, just book a call and we'll start fresh. If not, no problem at all — wishing you well either way.</p>
</td></tr>
<tr><td style="padding:0 40px 12px;">${button(d.bookingUrl, 'Book a call →')}</td></tr>
${footer(d)}`)
    });
  },

  // ─── STAFF NOTIFICATION ──────────────────────────────────────
  // Sent to STAFF_NOTIFY_EMAIL (or whatever email is in data) the moment
  // staff marks a deposit received in the dashboard. Pairs with the
  // staff_deposit_received SMS fan-out from _sms.js.
  staffDepositReceived: (d) => ({
    subject: `💰 Deposit received — ${d.clientName || 'client'}`,
    html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:8px;">Deposit confirmed</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;color:${BRAND.muted};line-height:1.65;margin:0 0 18px;">Search window is now active for this client.</p>
</td></tr>
<tr><td style="padding:0 40px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream};border-radius:10px;"><tr><td style="padding:18px 22px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;">
<tr><td style="padding:6px 0;color:${BRAND.muted};width:38%;">Client</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.clientName || '—'}</td></tr>
<tr><td style="padding:6px 0;color:${BRAND.muted};">Email</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.clientEmail || '—'}</td></tr>
<tr><td style="padding:6px 0;color:${BRAND.muted};">Vehicle</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.vehicleStr || '—'}</td></tr>
${d.budgetStr ? `<tr><td style="padding:6px 0;color:${BRAND.muted};">Budget</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.budgetStr}</td></tr>` : ''}
<tr><td style="padding:6px 0;color:${BRAND.muted};">Amount</td><td style="padding:6px 0;color:${BRAND.green};font-weight:700;text-align:right;">$${d.amount || '750'}.00</td></tr>
<tr><td style="padding:6px 0;color:${BRAND.muted};">Reference</td><td style="padding:6px 0;color:${BRAND.navy};font-weight:700;text-align:right;font-size:12px;">${d.depositRef || '—'}</td></tr>
<tr><td style="padding:6px 0;color:${BRAND.muted};">Date</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.depositDate || '—'}</td></tr>
${d.portalCode ? `<tr><td style="padding:6px 0;color:${BRAND.muted};">Portal code</td><td style="padding:6px 0;color:${BRAND.navy};font-weight:700;text-align:right;font-size:12px;">${d.portalCode}</td></tr>` : ''}
</table>
</td></tr></table>
</td></tr>
${footer(d)}`)
  }),

  // Staff fan-out the moment a client books an intro call. Pairs with the
  // staff_booking_made SMS — and is the "always-arrives" half until A2P
  // approval lets the SMS flow through carriers.
  staffCallBooked: (d) => ({
    subject: `📅 Call booked — ${d.clientName || 'client'} · ${d.dateLabel || d.date}`,
    html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:8px;">Intro call booked</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;color:${BRAND.muted};line-height:1.65;margin:0 0 18px;">A client just booked their 30-minute intro call. Calendar invite + their confirmation email are out already.</p>
</td></tr>
<tr><td style="padding:0 40px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream};border-radius:10px;"><tr><td style="padding:18px 22px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;">
<tr><td style="padding:6px 0;color:${BRAND.muted};width:38%;">When</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.dateLabel || d.date || '—'} at ${d.time || '—'}</td></tr>
<tr><td style="padding:6px 0;color:${BRAND.muted};">Client</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.clientName || '—'}</td></tr>
${d.clientEmail ? `<tr><td style="padding:6px 0;color:${BRAND.muted};">Email</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.clientEmail}</td></tr>` : ''}
${d.clientPhone ? `<tr><td style="padding:6px 0;color:${BRAND.muted};">Phone</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.clientPhone}</td></tr>` : ''}
${d.vehicle ? `<tr><td style="padding:6px 0;color:${BRAND.muted};">Vehicle interest</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.vehicle}</td></tr>` : ''}
${d.portalCode ? `<tr><td style="padding:6px 0;color:${BRAND.muted};">Portal code</td><td style="padding:6px 0;color:${BRAND.navy};font-weight:700;text-align:right;font-size:12px;">${d.portalCode}</td></tr>` : ''}
</table>
</td></tr></table>
</td></tr>
${footer(d)}`)
  }),

  // Staff fan-out when a CLIENT replies in their portal. Pairs with the
  // staff_portal_message SMS.
  staffPortalMessage: (d) => ({
    subject: `💬 New portal message from ${d.clientName || 'a client'}`,
    html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:8px;">New message in the portal</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;color:${BRAND.muted};line-height:1.65;margin:0 0 18px;">${d.clientName || 'A client'} just sent you a message. Open the dashboard to reply.</p>
</td></tr>
${d.messageText ? `<tr><td style="padding:0 40px 22px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream};border-left:3px solid ${BRAND.navy};border-radius:0 8px 8px 0;"><tr><td style="padding:16px 20px;">
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;color:${BRAND.ink};line-height:1.65;white-space:pre-wrap;word-wrap:break-word;">${(d.messageText || '').slice(0, 1000)}</div>
</td></tr></table>
</td></tr>` : ''}
<tr><td style="padding:0 40px 22px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream};border-radius:10px;"><tr><td style="padding:14px 22px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;">
<tr><td style="padding:4px 0;color:${BRAND.muted};width:30%;">Client</td><td style="padding:4px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.clientName || '—'}</td></tr>
${d.clientEmail ? `<tr><td style="padding:4px 0;color:${BRAND.muted};">Email</td><td style="padding:4px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.clientEmail}</td></tr>` : ''}
${d.clientPhone ? `<tr><td style="padding:4px 0;color:${BRAND.muted};">Phone</td><td style="padding:4px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.clientPhone}</td></tr>` : ''}
${d.portalCode ? `<tr><td style="padding:4px 0;color:${BRAND.muted};">Portal code</td><td style="padding:4px 0;color:${BRAND.navy};font-weight:700;text-align:right;font-size:12px;">${d.portalCode}</td></tr>` : ''}
</table>
</td></tr></table>
</td></tr>
${footer(d)}`)
  }),

  // Sent to a client when STAFF replies in their portal. Email is the
  // always-arrives half here too — SMS to client is blocked by A2P.
  // Includes a short preview of the message to drive them back to the portal.
  clientPortalMessage: (d) => ({
    subject: `New message from Auto Pals USA`,
    html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:14px;">You've got a message, ${d.firstName || 'there'}.</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 20px;">${d.staffName ? d.staffName + ' from Auto Pals USA' : 'Your Auto Pals USA team'} just sent you a message in your portal. Hop in to read it and reply when you're ready.</p>
</td></tr>
${d.messagePreview ? `<tr><td style="padding:0 40px 22px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream};border-left:3px solid ${BRAND.navy};border-radius:0 8px 8px 0;"><tr><td style="padding:16px 20px;">
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;color:${BRAND.ink};line-height:1.65;white-space:pre-wrap;word-wrap:break-word;">${(d.messagePreview || '').slice(0, 400)}</div>
</td></tr></table>
</td></tr>` : ''}
<tr><td style="padding:0 40px 12px;">${button(d.portalUrl, 'Read & reply →')}</td></tr>
${footer(d)}`)
  }),

  // Client-side "you booked a call" confirmation. Replaces the old inline
  // HTML in api/booking.js that was still branded Auto Motivation Enterprise.
  bookingConfirmation: (d) => ({
    subject: `Call confirmed — ${d.dateLabel || d.date} at ${d.time}`,
    html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.greenSoft};border-radius:10px;margin-bottom:20px;"><tr><td style="padding:16px 20px;">
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${BRAND.green};margin-bottom:4px;">✓ Call Confirmed</div>
<div style="font-family:Georgia,serif;font-size:15px;color:${BRAND.ink};font-weight:600;">You're on the calendar — we'll call you at the scheduled time.</div>
</td></tr></table>
<div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:12px;">All set, ${d.firstName}.</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:15px;color:${BRAND.muted};line-height:1.7;margin:0 0 20px;">A calendar invite is on its way — if you need to reschedule, just reply to this email and we'll sort it out.</p>
</td></tr>
<tr><td style="padding:0 40px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream};border-radius:10px;"><tr><td style="padding:22px 26px;">
<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${BRAND.mutedSoft};margin-bottom:14px;">Your Appointment</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;">
<tr><td style="padding:6px 0;color:${BRAND.muted};width:40%;">Date</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.dateLabel || d.date || '—'}</td></tr>
<tr><td style="padding:6px 0;color:${BRAND.muted};">Time</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.time || '—'} Eastern Time</td></tr>
<tr><td style="padding:6px 0;color:${BRAND.muted};">Duration</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">30 minutes</td></tr>
<tr><td style="padding:6px 0;color:${BRAND.muted};">With</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">Alex or Josh</td></tr>
</table>
</td></tr></table>
</td></tr>
${d.portalUrl ? `<tr><td style="padding:0 40px 12px;">${button(d.portalUrl, 'View your portal →')}</td></tr>` : ''}
${footer(d)}`)
  }),

  // Sent to staff (fanned out via STAFF_NOTIFY_EMAIL comma-list) the moment
  // a client submits the request form. Pairs with the staff_new_request SMS.
  staffNewRequest: (d) => ({
    subject: `🚗 New request: ${d.clientName || 'client'}${d.vehicleStr ? ' — ' + d.vehicleStr : ''}`,
    html: shell(`${header()}
<tr><td style="padding:28px 40px 0;">
<div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:${BRAND.ink};line-height:1.3;margin-bottom:8px;">New client request</div>
<p style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;color:${BRAND.muted};line-height:1.65;margin:0 0 18px;">Just landed in the dashboard — review and reach out.</p>
</td></tr>
<tr><td style="padding:0 40px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream};border-radius:10px;"><tr><td style="padding:18px 22px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;">
<tr><td style="padding:6px 0;color:${BRAND.muted};width:38%;">Client</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.clientName || '—'}</td></tr>
${d.clientEmail ? `<tr><td style="padding:6px 0;color:${BRAND.muted};">Email</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.clientEmail}</td></tr>` : ''}
${d.clientPhone ? `<tr><td style="padding:6px 0;color:${BRAND.muted};">Phone</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.clientPhone}</td></tr>` : ''}
<tr><td style="padding:6px 0;color:${BRAND.muted};">Vehicle</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.vehicleStr || 'Open Search'}</td></tr>
${d.budgetStr ? `<tr><td style="padding:6px 0;color:${BRAND.muted};">Budget</td><td style="padding:6px 0;color:${BRAND.ink};font-weight:600;text-align:right;">${d.budgetStr}</td></tr>` : ''}
${d.portalCode ? `<tr><td style="padding:6px 0;color:${BRAND.muted};">Portal code</td><td style="padding:6px 0;color:${BRAND.navy};font-weight:700;text-align:right;font-size:12px;">${d.portalCode}</td></tr>` : ''}
</table>
</td></tr></table>
</td></tr>
${footer(d)}`)
  })
};

const { verifyToken } = require('./auth.js');

// ─── send pipeline ──────────────────────────────────────────────────
// Rewritten 2026-05-14 after a staff email went missing on a real form
// submission. The old pipeline silently returned ok:false on missing
// STAFF_NOTIFY_EMAIL and never retried SendGrid blips. This version:
//   1. Routes staff templates to env var, falls back to FROM_EMAIL so
//      a staff alert is *never* silently dropped on a missing env var.
//   2. Retries transient SendGrid failures (5xx, 429, fetch errors) up
//      to 3 attempts with backoff. Skips retry on 4xx (permanent).
//   3. Per-attempt 10s timeout so a hung socket can't kill the lambda.
//   4. Writes every attempt to public.email_log in Supabase if the
//      table exists — silent no-op if it doesn't, so this code can ship
//      before the migration is applied.
//   5. Structured [EMAIL] logging at every decision point.

const STAFF_TEMPLATES = new Set([
  'staffNewRequest',
  'staffCallBooked',
  'staffDepositReceived',
  'staffPortalMessage',
  'staffContractSigned'
]);

// Recipient resolution for staff templates. Anything that lands here is
// guaranteed to have AT LEAST one recipient, because we fall back to
// FROM_EMAIL when STAFF_NOTIFY_EMAIL is missing/empty. That mailbox is
// already verified in SendGrid, so we know mail to it works.
function resolveStaffRecipients() {
  const env = (process.env.STAFF_NOTIFY_EMAIL || '').trim();
  if (env) return env;
  const fromAddr = (process.env.FROM_EMAIL || '').trim();
  if (fromAddr) {
    console.warn('[EMAIL] STAFF_NOTIFY_EMAIL not set — falling back to FROM_EMAIL');
    return fromAddr;
  }
  console.warn('[EMAIL] STAFF_NOTIFY_EMAIL and FROM_EMAIL both unset — using hard fallback');
  return 'codydickinson@autopalsusa.com';
}

// fetch with hard timeout. AbortController works in the Node 24 runtime.
async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fire-and-forget log to email_log. Never throws, never delays the caller
// meaningfully (Promise floats independent of the send response).
function logAttempt(row) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
           || process.env.SUPABASE_KEY
           || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return;
  fetchWithTimeout(`${url}/rest/v1/email_log`, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(row)
  }, 5000).catch(err => {
    // Table might not exist yet (migration not applied) — that's fine.
    const msg = err && err.message;
    if (msg && !/relation .* does not exist|404/i.test(msg)) {
      console.error('[EMAIL] log write failed:', msg);
    }
  });
}

async function sendOnce({ apiKey, fromEmail, replyTo, subject, html, plainText, personalizations }) {
  const r = await fetchWithTimeout('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      personalizations,
      from:     { email: fromEmail, name: 'Alex & Josh — Auto Pals USA' },
      reply_to: { email: replyTo,   name: 'Alex & Josh — Auto Pals USA' },
      subject,
      content: [
        { type: 'text/plain', value: plainText },
        { type: 'text/html',  value: html }
      ]
    })
  }, 10000);
  if (r.ok) return { ok: true, status: r.status };
  const body = await r.text().catch(() => '');
  return { ok: false, status: r.status, body: body.slice(0, 400) };
}

// In-process sender — used by db.js, booking.js, cron.js to skip the HTTP hop.
async function sendTemplate(type, data) {
  const apiKey    = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.FROM_EMAIL || 'info@autopalsusa.com';
  const replyTo   = process.env.FROM_EMAIL || 'info@autopalsusa.com';
  const isStaff   = STAFF_TEMPLATES.has(type);

  const template = TEMPLATES[type];
  if (!template) {
    console.error('[EMAIL] unknown template type:', type);
    return { ok: false, error: 'unknown_type', type };
  }

  // Recipient resolution — staff templates ALWAYS get a recipient (fallback
  // chain). Client templates require data.email.
  const payload = { ...(data || {}) };
  if (isStaff) {
    payload.email = resolveStaffRecipients();
  }
  const recipients = String(payload.email || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!recipients.length) {
    console.error('[EMAIL] no recipient for', type, '— payload had no email');
    logAttempt({
      template: type, recipients: '', subject: null,
      ok: false, error: 'no_recipient', is_staff: isStaff,
      request_id: payload.requestId || null
    });
    return { ok: false, error: 'no_recipient' };
  }

  const { subject, html } = template(payload);
  const plainText = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const personalizations = recipients.map(addr => ({
    to: [{ email: addr, name: `${payload.firstName || ''} ${payload.lastName || ''}`.trim() }]
  }));

  if (!apiKey) {
    console.log('[EMAIL DEMO]', type, '→', recipients.join(','));
    logAttempt({
      template: type, recipients: recipients.join(','), subject,
      ok: true, is_staff: isStaff,
      request_id: payload.requestId || null
    });
    return { ok: true, demo: true };
  }

  // Retry loop. Transient: network errors, 5xx, 429. Permanent: other 4xx.
  const MAX_ATTEMPTS = 3;
  let lastStatus = null;
  let lastErr    = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result;
    try {
      result = await sendOnce({ apiKey, fromEmail, replyTo, subject, html, plainText, personalizations });
    } catch (err) {
      lastErr = (err && err.message) || String(err);
      console.error(`[EMAIL] attempt ${attempt}/${MAX_ATTEMPTS} fetch failed for ${type}:`, lastErr);
      if (attempt < MAX_ATTEMPTS) { await sleep(500 * attempt); continue; }
      break;
    }
    if (result.ok) {
      console.log(`[EMAIL] ok ${type} → ${recipients.length} recipient(s) (attempt ${attempt})`);
      logAttempt({
        template: type, recipients: recipients.join(','), subject,
        ok: true, attempts: attempt, sg_status: result.status,
        is_staff: isStaff, request_id: payload.requestId || null
      });
      return { ok: true, recipients: recipients.length, attempts: attempt };
    }
    lastStatus = result.status;
    lastErr    = result.body;
    const transient = result.status >= 500 || result.status === 429;
    console.error(`[EMAIL] attempt ${attempt}/${MAX_ATTEMPTS} ${type} → ${result.status}: ${(result.body||'').slice(0,200)}`);
    if (!transient || attempt === MAX_ATTEMPTS) break;
    await sleep(500 * attempt);
  }

  // Total failure — log loudly. Staff misses are critical because the team
  // has no other signal that a client just came in.
  const tag = isStaff ? '[EMAIL CRITICAL] STAFF MISS' : '[EMAIL FAIL]';
  console.error(`${tag} ${type} → ${recipients.join(',')} status=${lastStatus} err=${(lastErr||'').slice(0,200)}`);
  logAttempt({
    template: type, recipients: recipients.join(','), subject,
    ok: false, attempts: MAX_ATTEMPTS, sg_status: lastStatus,
    error: (lastErr || 'unknown').slice(0, 500),
    is_staff: isStaff, request_id: payload.requestId || null
  });
  return { ok: false, status: lastStatus, error: 'sendgrid_failed', attempts: MAX_ATTEMPTS };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Staff-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers['x-staff-token']
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!verifyToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { type, data } = req.body || {};
  if (!type) return res.status(400).json({ error: 'missing_type' });

  const result = await sendTemplate(type, data || {});
  return res.status(result.ok ? 200 : (result.error === 'unknown_type' ? 400 : 500)).json(result);
};

module.exports.sendTemplate = sendTemplate;
module.exports.sendEmail    = sendTemplate;   // alias for prod naming convention
