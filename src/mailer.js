// Outbound email. There was none at all: no welcome, no reminder that a
// half-finished questionnaire was waiting, nothing to bring a founder back once
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
function shell(heading, bodyHtml, ctaLabel, ctaHref) {
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
        You're getting this because you started a NoBossly account.
        <a href="${SITE}/account" style="color:#6b7a74">Email settings</a>
      </p>
    </td></tr>
  </table></body></html>`;
}

const p = t => `<p style="margin:0 0 13px;font-size:15px;line-height:1.62;color:#33413b">${t}</p>`;

const TEMPLATES = {
  welcome: name => ({
    subject: 'Your way out is seven questions away',
    html: shell(
      `Welcome, ${esc(name)}.`,
      p('You have an account. The next thing that happens is your <strong>Compass</strong> &mdash; your archetype, the strengths you actually have, the hours and runway you genuinely have outside your job, and an honest list of what to avoid.')
      + p('It takes seven questions. About two minutes, tonight, after work. You can go deeper later if you want a sharper read, but you do not have to.'),
      'Draw my Compass', SITE + '/questionnaire')
  }),

  resume_questionnaire: name => ({
    subject: 'You were two minutes from your Compass',
    html: shell(
      `Pick up where you left off, ${esc(name)}.`,
      p('Your answers are saved. Nothing was lost &mdash; the questionnaire opens exactly where you stopped.')
      + p('It is seven questions in total, and the Compass is drawn the moment you finish the last one.'),
      'Finish and see my Compass', SITE + '/questionnaire')
  }),

  comeback: name => ({
    subject: 'Your Compass is still waiting',
    html: shell(
      `Still here when you are, ${esc(name)}.`,
      p('Your Compass, your ideas and your board are exactly where you left them.')
      + p('The fastest way back in is a single daily check-in &mdash; it takes a minute, keeps your streak alive, and puts the next concrete step in front of you.'),
      'Open my dashboard', SITE + '/dashboard')
  })
};

async function record(sb, row) {
  if (!sb) return;
  try { await sb.from('email_log').insert(row); } catch (e) { console.error('email_log', e.message); }
}

// Sends one email and logs the outcome. Never throws — a failed send must never
// take down the request or sweep that triggered it.
async function send(type, to, name, opts = {}) {
  const sb = opts.sb || admin();
  const tpl = TEMPLATES[type];
  if (!tpl) return false;
  const { subject, html } = tpl(name || 'there');

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
async function runSweep() {
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

module.exports = { send, runSweep, enabled };
