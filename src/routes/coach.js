// The coach, the weekly plan, the reading list and proof review.
//
// The free/paid line here is the whole monetisation argument in one file:
//
//   The reading list is FREE. It costs one credit, it makes the 129 published
//   guides compound instead of only serving search traffic, and it is the
//   cheapest possible demonstration that the AI here knows who you are.
//
//   The coach chat is FREE, bounded by the credit allowance rather than by a
//   separate counter. Twenty credits a month is roughly twenty questions if you
//   spend them all here — enough to feel it work, few enough to meet the wall.
//
//   The weekly plan and proof review are PAID, because they are the two that
//   are worthless in arrears. A plan you generate once and keep is not a plan;
//   it is a document, and documents do not hold subscriptions.
const router = require('express').Router();
const coach = require('../coach');
const credits = require('../credits');
const qsvc = require('../questionnaires');
const paths = require('../paths');
const { requireAuth, planOf } = require('../middleware/auth');
const { gate, gateCredits } = require('../upgrade');

const { quiet } = require('../db');
router.use(requireAuth);

const enc = encodeURIComponent;
const isPaid = req => planOf(req.profile) === 'paid';

// Everything on this page needs the same context, and building it is four
// parallel queries, so it is built once per request and passed down.
async function load(req) {
  const q = await qsvc.latestCompleted(req.sb, req.user.id);
  const ctx = await coach.contextFor(req.sb, req.user.id, req.profile, q);
  const [plan, convo, reading] = await Promise.all([
    req.sb.from('weekly_plans').select('*')
      .eq('user_id', req.user.id).eq('week_of', coach.thisMonday())
      .maybeSingle().then(r => r.data, () => null),
    req.sb.from('ai_conversations').select('*')
      .eq('user_id', req.user.id).eq('context_type', 'coach')
      .maybeSingle().then(r => r.data, () => null),
    req.sb.from('ai_reading_lists').select('*')
      .eq('user_id', req.user.id).eq('week_of', coach.thisMonday())
      .maybeSingle().then(r => r.data, () => null)
  ]);
  return { q, ctx, plan, convo, reading };
}

// The guides behind a reading list, resolved from the ids the list stored.
async function guidesFor(sb, ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const { data } = await sb.from('cms_guides')
    .select('id, slug, title, excerpt').in('id', ids);
  const by = {};
  (data || []).forEach(g => { by[g.id] = g; });
  return ids.map(id => by[id]).filter(Boolean);
}

router.get('/', async (req, res, next) => {
  try {
    const { ctx, plan, convo, reading } = await load(req);
    const readingGuides = reading ? await guidesFor(req.sb, reading.guide_ids) : [];
    res.render('coach', {
      title: 'Your coach',
      ctx, plan, reading, readingGuides,
      messages: (convo && Array.isArray(convo.messages) ? convo.messages : []).slice(-20),
      paid: isPaid(req),
      needsQuestionnaire: !ctx.q,
      msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

// --- the weekly plan (paid) -------------------------------------------------

router.post('/plan', async (req, res, next) => {
  try {
    if (!isPaid(req)) return gate(res, 'weekly_plan');
    const { ctx } = await load(req);
    if (!ctx.q) return res.redirect('/questionnaire');
    let plan;
    try {
      plan = await coach.weeklyPlan(req.sb, req.accessToken, ctx);
    } catch (err) {
      if (err.outOfCredits) return gateCredits(res, err.credits, '/coach');
      return res.redirect('/coach?msg=' + enc('Could not write this week’s plan: ' + err.message));
    }
    await coach.savePlan(req.sb, req.user.id, ctx, plan);
    res.redirect('/coach');
  } catch (e) { next(e); }
});

// Ticking an item is what makes next week's plan honest — it is the only thing
// that tells the coach what actually happened.
router.post('/plan/:idx/toggle', async (req, res, next) => {
  try {
    const { data: plan } = await req.sb.from('weekly_plans').select('*')
      .eq('user_id', req.user.id).eq('week_of', coach.thisMonday()).maybeSingle();
    if (!plan) return res.redirect('/coach');
    const idx = parseInt(req.params.idx, 10);
    const items = Array.isArray(plan.items) ? plan.items.slice() : [];
    if (items[idx]) {
      items[idx] = { ...items[idx], done: !items[idx].done };
      await req.sb.from('weekly_plans')
        .update({ items, updated_at: new Date().toISOString() })
        .eq('id', plan.id).eq('user_id', req.user.id);
    }
    res.redirect('/coach');
  } catch (e) { next(e); }
});

// --- the chat (free, bounded by the allowance) ------------------------------

router.post('/ask', async (req, res, next) => {
  try {
    const question = String((req.body || {}).question || '').trim().slice(0, 1500);
    if (!question) return res.redirect('/coach');
    const { ctx, convo } = await load(req);
    if (!ctx.q) return res.redirect('/questionnaire');

    const history = (convo && Array.isArray(convo.messages) ? convo.messages : []);
    let answer;
    try {
      answer = await coach.reply(req.sb, req.accessToken, ctx, history, question);
    } catch (err) {
      if (err.outOfCredits) return gateCredits(res, err.credits, '/coach');
      return res.redirect('/coach?msg=' + enc('The coach could not answer just now: ' + err.message));
    }

    // Kept to the last 40 turns. The value is in the context block, not in a
    // long backlog of chat, and an unbounded jsonb column on a hot row is a
    // problem that only shows up once it is expensive to fix.
    const next = history.concat([
      { role: 'user', content: question, at: new Date().toISOString() },
      { role: 'coach', content: answer, at: new Date().toISOString() }
    ]).slice(-40);

    await req.sb.from('ai_conversations').upsert({
      user_id: req.user.id, context_type: 'coach',
      messages: next, updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,context_type' });

    // What the coach knows about the business, refreshed each time it answers,
    // so a later session opens with the summary rather than rebuilding it.
    await req.sb.from('ai_memory').upsert({
      user_id: req.user.id,
      business_summary: (ctx.idea ? ctx.idea.name + ' — ' + (ctx.idea.tagline || '') : 'No idea drafted yet').slice(0, 500),
      active_sprint_context: coach.brief(ctx).slice(0, 4000),
      last_briefed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' }).then(...quiet('ai_memory.upsert'));

    res.redirect('/coach#latest');
  } catch (e) { next(e); }
});

router.post('/clear', async (req, res, next) => {
  try {
    await req.sb.from('ai_conversations').delete()
      .eq('user_id', req.user.id).eq('context_type', 'coach');
    res.redirect('/coach');
  } catch (e) { next(e); }
});

// --- the reading list (free) ------------------------------------------------

router.post('/reading', async (req, res, next) => {
  try {
    const { ctx } = await load(req);
    if (!ctx.q) return res.redirect('/questionnaire');
    // A slice of the library, not all 129: the whole index in one prompt costs
    // more than the pick is worth, and the model reads the first fifty as
    // attentively as it would read all of them.
    const { data: guides } = await req.sb.from('cms_guides')
      .select('id, slug, title, excerpt')
      .eq('status', 'published')
      .order('published_at', { ascending: false })
      .limit(60);
    let picks;
    try {
      picks = await coach.readingList(req.sb, req.accessToken, ctx, guides || []);
    } catch (err) {
      if (err.outOfCredits) return gateCredits(res, err.credits, '/coach');
      return res.redirect('/coach?msg=' + enc('Could not pick your guides: ' + err.message));
    }
    if (!picks) return res.redirect('/coach?msg=' + enc('Nothing in the library fits this week — try again once your idea is drafted.'));

    await req.sb.from('ai_reading_lists').delete()
      .eq('user_id', req.user.id).eq('week_of', coach.thisMonday());
    await req.sb.from('ai_reading_lists').insert({
      user_id: req.user.id,
      guide_ids: picks.map(p => p.guide.id),
      reasoning: picks.map(p => p.guide.title + ' — ' + p.why).join('\n'),
      week_of: coach.thisMonday()
    });
    res.redirect('/coach#reading');
  } catch (e) { next(e); }
});

// --- proof review (paid) ----------------------------------------------------

router.post('/proof', async (req, res, next) => {
  try {
    if (!isPaid(req)) return gate(res, 'proof_review');
    const gateTitle = String((req.body || {}).gate || '').trim().slice(0, 200);
    const note = String((req.body || {}).note || '').trim().slice(0, 2000);
    if (!gateTitle || !note) return res.redirect('/coach?msg=' + enc('Pick a quest and write what you actually did.'));
    const { ctx, plan, convo, reading } = await load(req);
    const readingGuides = reading ? await guidesFor(req.sb, reading.guide_ids) : [];
    let review = null;
    let msg = null;
    try {
      review = await coach.reviewProof(req.sb, req.accessToken, ctx, gateTitle, note);
    } catch (err) {
      if (err.outOfCredits) return gateCredits(res, err.credits, '/coach');
      msg = 'Could not review that proof: ' + err.message;
    }
    res.render('coach', {
      title: 'Your coach',
      ctx, plan, reading, readingGuides,
      messages: (convo && Array.isArray(convo.messages) ? convo.messages : []).slice(-20),
      paid: true, needsQuestionnaire: !ctx.q,
      review, reviewGate: gateTitle, reviewNote: note, msg
    });
  } catch (e) { next(e); }
});

module.exports = router;
