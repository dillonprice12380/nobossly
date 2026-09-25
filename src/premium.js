// NoBossly Premium: the five standalone tools. Everything else on the site —
// the paths, the ladder, quests, trophies, the community — stays free.
//
// hasPremium() mirrors public.has_premium() in the database, so pages can
// decide what to show without a round trip. The database is still the one
// that enforces it: premium_save() refuses a write from anyone without
// Premium, whatever this file thinks.

const TOOLS = [
  { key: 'quit',       href: '/tools/quit-date',  emoji: '🗓️', name: 'Quit-Date Planner',
    blurb: 'Your costs, savings and side income in — the month you can hand in your notice out. Log each month and watch the date move.' },
  { key: 'tax',        href: '/tools/tax',        emoji: '🧾', name: 'Tax Set-Aside',
    blurb: 'How much of every payment to put aside, your quarterly estimates and deadlines, and a running log of deductions and miles.' },
  { key: 'pricing',    href: '/tools/pricing',    emoji: '🏷️', name: 'Pricing & Margin Calculator',
    blurb: 'The rate you need to charge for the income you want, and the true margin on every product after every fee.' },
  { key: 'proof',      href: '/tools/proof',      emoji: '🌟', name: 'Proof Page',
    blurb: 'A public page for your business — testimonials, wins and your verified level — to link from your bio, proposals and emails.' },
  { key: 'interviews', href: '/tools/interviews', emoji: '🎙️', name: 'Customer Interview Tracker',
    blurb: 'Log every validation conversation, tag the problems people raise, and see which ones keep coming up and who would pay.' }
];

const GRACE_MS = 3 * 86400000;

function hasPremium(profile) {
  if (!profile) return false;
  if (profile.is_admin || profile.is_lifetime) return true;
  const status = profile.subscription_status;
  const end = profile.subscription_period_end ? new Date(profile.subscription_period_end).getTime() : null;
  if (['active', 'trialing', 'past_due'].includes(status)) return end === null || end > Date.now() - GRACE_MS;
  if (status === 'canceled') return end !== null && end > Date.now();
  return false;
}

// Makes `isPremium` and the tool list available to every view.
function attach(req, res, next) {
  res.locals.isPremium = hasPremium(req.profile);
  res.locals.premiumTools = TOOLS;
  next();
}

// Tool pages: signed-out visitors go to log in (requireAuth runs first);
// members without Premium see the tool's own sales page instead of the tool.
function requirePremium(tool) {
  return (req, res, next) => {
    if (hasPremium(req.profile)) return next();
    const def = TOOLS.find(t => t.key === tool);
    res.status(200).render('tools/locked', { title: def ? def.name : 'Premium', tool: def });
  };
}

async function load(req, tool) {
  const { data, error } = await req.sb.from('premium_tool_data')
    .select('data, updated_at').eq('user_id', req.user.id).eq('tool', tool).maybeSingle();
  if (error) console.error('[db] premium_tool_data read failed:', error.message);
  return (data && data.data) || {};
}

async function save(req, tool, data) {
  const { error } = await req.sb.rpc('premium_save', { p_tool: tool, p_data: data });
  if (error) {
    const e = new Error('premium_save: ' + error.message);
    e.userMessage = /premium_required/.test(error.message)
      ? 'Your Premium access has ended — renew from the pricing page to keep saving.'
      : /too_large/.test(error.message) ? 'That is more than this tool can store — remove some older entries first.'
      : 'Could not save. Please try again.';
    throw e;
  }
}

module.exports = { TOOLS, hasPremium, attach, requirePremium, load, save };
