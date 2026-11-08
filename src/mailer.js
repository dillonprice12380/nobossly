// Outbound email. There was none at all: no welcome, no reminder that a
// path was still unpicked, nothing to bring a founder back once
// they closed the tab. Every drop-off was permanent by construction.
//
// Sending is gated on RESEND_API_KEY. With the key unset the module is inert —
// nothing is sent, nothing throws, and the app behaves exactly as it did before.
// Every attempt (sent or failed) is recorded in email_log, which already carried
// a resend_id column waiting for exactly this.

const { serviceClient } = require('./supabase');

const API = 'https://api.resend.com/emails';
const FROM = process.env.EMAIL_FROM || 'NoBossly <hello@nobossly.com>';
const SITE = (process.env.SITE_URL || 'https://nobossly.com').replace(/\/$/, '');

const enabled = () => !!process.env.RESEND_API_KEY;

// Service role is needed for the sweep (it reads across users) and for logging
// sends that happen outside any request. Absent key = sweeps stay off.
function admin() {
  try { return serviceClient(); } catch (_) { return null; }
}

const esc = v => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// One shell for every email, so they all look like they came from the same place.
function shell(heading, bodyHtml, ctaLabel, ctaHref, why) {
  return `<!doctype html><html><body style="margin:0;background:#f4f6f5;padding:28px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#14201c">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e7e4;border-radius:14px">
    <tr><td style="padding:28px 30px 8px">
      <p style="margin:0 0 18px;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#10b981;font-weight:700">NoBossly</p>
      <h1 style="margin:0 0 14px;font-size:23px;line-height:1.25;color:#14201c">${heading}</h1>
      ${bodyHtml}
    </td></tr>
    <tr><td style="padding:6px 30px 30px">
      <a href="${esc(ctaHref)}" style="display:inline-block;background:#10b981;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:9px">${esc(ctaLabel)}</a>
    </td></tr>
    <tr><td style="padding:0 30px 26px;border-top:1px solid #eef2f0">
      <p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:#6b7a74">
        ${why || `You're getting this because you started a NoBossly account.
        <a href="${SITE}/account" style="color:#6b7a74">Email settings</a>`}
      </p>
    </td></tr>
  </table></body></html>`;
}

const p = t => `<p style="margin:0 0 13px;font-size:15px;line-height:1.62;color:#33413b">${t}</p>`;

const TEMPLATES = {
  welcome: name => ({
    subject: 'Your NoBossly workspace is ready',
    html: shell(
      `Welcome, ${esc(name)}.`,
      p('You have an account, and NoBossly is free &mdash; every path and every tool.')
      + p('Your workspace is set up for the path you picked: the numbers, boards and tools for that kind of business, and a community of people building the same way.'),
      'Open my dashboard', SITE + '/dashboard')
  }),

  resume_questionnaire: name => ({
    subject: 'One choice left: pick your path',
    html: shell(
      `Pick up where you left off, ${esc(name)}.`,
      p('Your account is ready. The only thing left is choosing your path &mdash; creator, freelancer, local service, online store and more. It takes a few seconds, and you can change it later.')
      + p('Once it is picked, your workspace is set up with the numbers, boards and tools for that path.'),
      'Pick my path', SITE + '/choose-path')
  }),

  comeback: name => ({
    subject: 'Your workspace is where you left it',
    html: shell(
      `Still here when you are, ${esc(name)}.`,
      p('Your path, your tasks and your workspace are exactly where you left them.')
      + p('Everything opens where you left it.'),
      'Open my dashboard', SITE + '/dashboard')
  }),

  // The weekly news digest (src/digest.js). opts: { items, pathLabel }; each
  // item is a path_news row. Headlines link to the publisher.
  weekly_brief: (name, o = {}) => {
    const items = Array.isArray(o.items) ? o.items : [];
    const who = o.pathLabel ? o.pathLabel.toLowerCase() + 's' : 'people building their own thing';
    const groups = [];
    items.forEach(n => {
      let g = groups.find(x => x.label === n.label);
      if (!g) groups.push(g = { label: n.label, items: [] });
      g.items.push(n);
    });
    const safeUrl = u => (/^https:\/\/\S+$/i.test(String(u || '')) ? u : SITE + '/news');
    const list = groups.map(g =>
      `<p style="margin:18px 0 6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#10b981;font-weight:700">${esc(g.label)}</p>`
      + g.items.map(n => `<p style="margin:0 0 10px;font-size:15px;line-height:1.45"><a href="${esc(safeUrl(n.url))}" style="color:#14201c;font-weight:600;text-decoration:none">${esc(n.title)}</a><br><span style="font-size:12px;color:#6b7a74">${esc(n.publisher || 'News')}</span></p>`).join('')
    ).join('');
    const top = items[0] ? String(items[0].title) : 'your week in news';
    return {
      subject: 'This week for ' + who + ': ' + (top.length > 70 ? top.slice(0, 67).trim() + '…' : top),
      html: shell(
        `Your week, ${esc(name)}.`,
        p(`The news that matters to ${esc(who)}, from the last seven days.`) + list,
        'See all the news', SITE + '/news',
        `You're getting this because the weekly digest is on. <a href="${SITE}/account" style="color:#6b7a74">Turn it off</a> in account settings.`)
    };
  },

  // A worksheet shared by email. opts: { from, title, label, note, link }.
  doc_share: (name, o = {}) => ({
    subject: `${String(o.from || 'Someone').slice(0, 60)} shared "${String(o.title || 'a worksheet').slice(0, 80)}" with you`,
    html: shell(
      `${esc(o.from || 'Someone')} shared a ${esc(o.label || 'worksheet')} with you.`,
      p(`<strong>${esc(o.title || 'A worksheet')}</strong> &mdash; you can read it online or download it as a PDF. No account needed.`)
      + (o.note ? p(`&ldquo;${esc(o.note)}&rdquo;`) : '')
      + p('The link shows the latest version and works for 30 days.'),
      'Open it', o.link || SITE,
      `You're getting this because ${esc(o.from || 'a NoBossly member')} entered your address to share a document. Nothing else will be sent.`)
  })
};

// email_log is written with the service-role client. Without that key an email
// still sends, but leaves no trace in the log — which once made a working
// welcome email look like no email at all. Say so, once, in the server log.
let warnedNoLog = false;
async function record(sb, row) {
  if (!sb) {
    if (!warnedNoLog) {
      warnedNoLog = true;
      console.warn('[mailer] SUPABASE_SERVICE_ROLE_KEY unset — emails still send, but are not recorded in email_log, and the reminder sweep is off.');
    }
    return;
  }
  const { error } = await sb.from('email_log').insert(row).then(r => r, e => ({ error: e }));
  if (error) console.error('[mailer] email_log insert failed:', error.message);
}

// Sends one email and logs the outcome. Never throws — a failed send must never
// take down the request or sweep that triggered it.
async function send(type, to, name, opts = {}) {
  const sb = opts.sb || admin();
  const tpl = TEMPLATES[type];
  if (!tpl) return false;
  const { subject, html } = tpl(name || 'there', opts.template || {});

  if (!enabled()) {
    console.log('[mailer] RESEND_API_KEY unset — skipping "' + type + '" to ' + to);
    return false;
  }
  try {
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.RESEND_API_KEY },
      body: JSON.stringify({ from: FROM, to: [to], subject, html })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      await record(sb, { user_id: opts.userId || null, to_email: to, email_type: type, subject, status: 'failed', error_msg: String(j.message || j.error || ('HTTP ' + r.status)).slice(0, 500) });
      return false;
    }
    await record(sb, { user_id: opts.userId || null, to_email: to, email_type: type, subject, resend_id: j.id || null, status: 'sent' });
    return true;
  } catch (e) {
    await record(sb, { user_id: opts.userId || null, to_email: to, email_type: type, subject, status: 'failed', error_msg: String(e.message).slice(0, 500) });
    return false;
  }
}

// True when this user has already been sent this type of email. Every nudge is
// once-only — a reminder that repeats is just spam with a nicer template.
async function alreadySent(sb, userId, type) {
  const { count } = await sb.from('email_log')
    .select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('email_type', type);
  return (count || 0) > 0;
}

/**
 * Daily sweep for the two nudges that need to look across users:
 *  - resume_questionnaire: signed up, never finished onboarding, 1-14 days ago
 *  - comeback: onboarded, but nothing has happened for 10-45 days
 * Both are once-per-user for life. Needs the service role key; without it the
 * sweep is skipped rather than half-run.
 */
// The last sweep's outcome, for /debug: when it ran and what it did or why it
// did not run.
let lastSweep = null;

async function runSweep() {
  const out = await sweep();
  lastSweep = Object.assign({ at: new Date().toISOString() }, out);
  return out;
}

async function sweep() {
  if (!enabled()) return { skipped: 'RESEND_API_KEY unset' };
  const sb = admin();
  if (!sb) return { skipped: 'SUPABASE_SERVICE_ROLE_KEY unset' };

  const days = n => new Date(Date.now() - n * 86400000).toISOString();
  const out = { resume: 0, comeback: 0 };

  try {
    const { data: stalled } = await sb.from('profiles')
      .select('id, username, display_name, created_at')
      .eq('onboarding_completed', false)
      .lt('created_at', days(1)).gt('created_at', days(14))
      .limit(200);

    for (const prof of stalled || []) {
      if (await alreadySent(sb, prof.id, 'resume_questionnaire')) continue;
      const email = await emailOf(sb, prof.id);
      if (!email) continue;
      if (await send('resume_questionnaire', email, prof.display_name || prof.username, { sb, userId: prof.id })) out.resume++;
    }

    const { data: quiet } = await sb.from('profiles')
      .select('id, username, display_name, last_active_at')
      .eq('onboarding_completed', true)
      .lt('last_active_at', days(10)).gt('last_active_at', days(45))
      .limit(200);

    for (const prof of quiet || []) {
      if (await alreadySent(sb, prof.id, 'comeback')) continue;
      const email = await emailOf(sb, prof.id);
      if (!email) continue;
      if (await send('comeback', email, prof.display_name || prof.username, { sb, userId: prof.id })) out.comeback++;
    }
  } catch (e) {
    console.error('email sweep', e.message);
  }
  return out;
}

// Addresses live in auth.users, which only the service role can read.
async function emailOf(sb, userId) {
  try {
    const { data } = await sb.auth.admin.getUserById(userId);
    return (data && data.user && data.user.email) || null;
  } catch (_) { return null; }
}

// What /debug shows about email: which keys are set and how the last sweep went.
function status() {
  return {
    resendKey: enabled(),
    serviceRoleKey: !!admin(),
    from: FROM,
    site: SITE,
    lastSweep
  };
}

module.exports = { send, runSweep, enabled, status, emailOf, SITE };
