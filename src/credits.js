// The AI credit rail.
//
// Every AI call in the product goes through spend() and nothing else does. The
// rule it enforces is not "make the member pay per report" — the pricing page
// promises the opposite — it is "no single account can cost an unbounded
// amount". Before this existed, `marketScan` (a web search plus a crawl of the
// member's own site) sat behind a Redraw button with no cap at all.
//
// All the arithmetic lives in Postgres, in spend_ai_credits(). This module is
// deliberately thin: if the cost of a call were decided here, the browser could
// argue with it. The client picks a kind; the database picks the price.
//
// Shape of a result, from either spend() or status():
//
//   { ok, plan, balance, cap, cost, visible, refillsOn }
//
// `visible` is the one field views should branch on. Free members are shown
// what they have left, because "2 coach replies left this month" is the best
// upgrade prompt in the product. Paying members are shown nothing: their
// ceiling exists to stop abuse, and a subscriber who can see a meter starts
// rationing a thing they already paid for.

const norm = (row) => {
  const r = row || {};
  return {
    ok: !!r.ok,
    reason: r.reason || null,
    plan: r.plan || 'free',
    balance: typeof r.balance === 'number' ? r.balance : 0,
    cap: typeof r.cap === 'number' ? r.cap : 0,
    cost: typeof r.cost === 'number' ? r.cost : 0,
    spent: typeof r.spent === 'number' ? r.spent : 0,
    visible: r.visible !== false,
    refillsOn: r.refills_on || null
  };
};

// A failure to reach the rail must not become a free pass. If the RPC itself
// errors we return ok:false — the member sees "try again", which is true, and
// the call does not run unmetered.
async function call(sb, fn, args) {
  try {
    const { data, error } = await sb.rpc(fn, args);
    if (error) return norm({ ok: false, reason: 'rpc:' + error.message });
    return norm(data);
  } catch (e) {
    return norm({ ok: false, reason: 'rpc:' + (e && e.message) });
  }
}

// Debit for one call. Returns ok:false when the balance will not cover it —
// the caller must not run the AI in that case.
const spend = (sb, kind) => call(sb, 'spend_ai_credits', { p_kind: kind, p_dry_run: false });

// Could they afford it? Spends nothing. This is what a view asks before
// deciding whether to render a button or an upgrade nudge.
const canAfford = (sb, kind) => call(sb, 'spend_ai_credits', { p_kind: kind, p_dry_run: true });

// Balance, cap and visibility, with nothing spent and no particular call in
// mind. Used by the header and the account page.
const status = (sb) => call(sb, 'ai_credit_status', {});

// Give back a debit whose AI call then threw. Capped server-side at the plan
// cap, so a fail/refund loop cannot mint credits.
const refund = (sb, kind) => call(sb, 'refund_ai_credits', { p_kind: kind });

// The wrapper that makes the ordering hard to get wrong: debit, run, and give
// the credits back if the run threw. Callers get either the AI result or a
// thrown error, and never a silent unmetered call.
//
//   const compass = await credits.run(req.sb, 'compass', () => cai.generate(...));
//
// `onBroke` lets a route decide what refusal looks like — a rendered upgrade
// panel for a page, a JSON error for a background job — rather than every
// caller re-deriving the message.
async function run(sb, kind, fn) {
  const paid = await spend(sb, kind);
  if (!paid.ok) {
    const err = new Error(paid.reason === 'insufficient'
      ? 'out of AI credits'
      : 'could not check your AI credits');
    err.credits = paid;
    err.outOfCredits = paid.reason === 'insufficient';
    throw err;
  }
  try {
    return await fn();
  } catch (e) {
    await refund(sb, kind);
    throw e;
  }
}

// How the refusal reads to a member. Free members get the honest version and a
// way out; paid members hitting a 400-credit month are almost certainly a
// script, so they get the plain limit without an upsell that makes no sense.
function brokeMessage(c) {
  if (!c || c.reason !== 'insufficient') return 'The AI could not be reached just now. Please try again.';
  if (c.plan === 'paid') {
    return 'That is a lot of AI in one month — you have hit the fair-use ceiling. It refills on the 1st. '
         + 'If you are genuinely working at this pace, reply to any NoBossly email and we will raise it.';
  }
  return 'You have used this month’s free AI. It refills on the 1st, or the Escape plan lifts the ceiling.';
}

module.exports = { spend, canAfford, status, refund, run, brokeMessage };
