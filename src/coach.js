// The coach: the AI that knows where you are on your ladder.
//
// Everything else the AI does in this product generates a document. A Compass,
// a blueprint, a list of challenges, a budget — you make one, you have it, you
// are done. That is why none of them can hold a subscription: there is no month
// two.
//
// This module is the other kind. It reads a member's actual position — which of
// nine paths, which of fifty-eight subpaths, which rung, the exact gate blocking
// the next one, the hours they said they have after work, the number their path
// is measured by, and what they did or did not finish last week — and answers
// from there.
//
// That context is the whole point, and it is the one thing a general chatbot
// cannot reproduce: you can paste your situation into any model, but you cannot
// paste "you are at Signwritten, three quotes short of Quoting, with six hours
// this week and a plumbing round in Leeds". Every function here takes the same
// context object, built once, so that the coach, the weekly plan and the proof
// review all speak from the same facts.

const paths = require('./paths');
const ladders = require('./ladders');
const traction = require('./traction');
const fitLib = require('./fit_library');
const credits = require('./credits');
const { achievedQuests } = require('./xp');

const EDGE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '') + '/functions/v1/ai-proxy';

// --- the model call ---------------------------------------------------------
//
// Kept local, like tailor.js does, so this module stands on its own. `json`
// false is what the coach chat uses: a reply to a person should be prose, and
// asking for JSON around it only gives the model something else to get wrong.

async function ask(token, system, prompt, maxTokens, opts) {
  const o = opts || {};
  const r = await fetch(EDGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
      'apikey': process.env.SUPABASE_ANON_KEY
    },
    body: JSON.stringify({
      system: o.json === false ? system : system + ' Respond ONLY with valid JSON. No markdown fences, no commentary.',
      prompt,
      max_tokens: maxTokens || 1200
    })
  });
  const raw = await r.text();
  let j = {};
  let parsed = true;
  try { j = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = false; }
  if (!r.ok || j.error) {
    if (r.status === 546 || r.status === 504) {
      throw new Error('the AI request ran past the server time limit. Please try again.');
    }
    throw new Error(j.error || ('AI proxy HTTP ' + r.status));
  }
  if (!parsed) throw new Error('the AI response was cut off in transit. Please try again.');
  let text = String(j.text || '').trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  if (!text) throw new Error('the AI returned an empty response. Please try again.');
  if (o.json === false) return text;
  const start = Math.min(...['[', '{'].map(c => { const i = text.indexOf(c); return i === -1 ? Infinity : i; }));
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  if (start === Infinity || end === -1) throw new Error('AI returned no JSON');
  return JSON.parse(text.slice(start, end + 1));
}

// --- weeks ------------------------------------------------------------------
//
// Weeks are Monday-anchored and computed in the server's local day, matching
// the check-in streak. A plan dated to the wrong Monday would silently make
// "last week" the current week and the coach would review work not yet done.

function mondayOf(d) {
  const t = new Date(d || Date.now());
  t.setHours(0, 0, 0, 0);
  const dow = (t.getDay() + 6) % 7; // Monday = 0
  t.setDate(t.getDate() - dow);
  return t;
}
const isoDate = d => new Date(d).toISOString().slice(0, 10);
const thisMonday = () => isoDate(mondayOf());
const lastMonday = () => {
  const m = mondayOf();
  m.setDate(m.getDate() - 7);
  return isoDate(m);
};

// --- context ----------------------------------------------------------------
//
// One round of queries, run in parallel, and every one of them tolerant of
// coming back empty: a member who has answered the questionnaire and nothing
// else must still get a usable coach, because that is exactly who needs one.

async function contextFor(sb, userId, profile, q) {
  const p = profile || {};
  const path = paths.get(p.path) || paths.get(q && q.founder_path) || null;
  // subpathOf() returns a slug; the label is what the prompt wants to read.
  const subSlug = p.subpath || paths.subpathOf(q) || null;
  const sub = subSlug
    ? (paths.subpathsOf(path ? path.slug : null) || []).find(s => s.slug === subSlug) || null
    : null;

  const [ladder, ideaRow, planRow, checkins] = await Promise.all([
    require('./xp').ladderStatus(sb, userId, p).catch(() => null),
    sb.from('generated_ideas')
      // fit_results is NOT a column. The graded results live inside the
      // `advisor` jsonb — src/routes/compass.js writes patch.advisor.fit_results
      // — and asking for a column that does not exist makes PostgREST reject the
      // whole select with a 400. supabase-js resolves rather than rejects, so
      // ideaRow came back null and the coach has been answering without the
      // member's idea, fit test or fit results in front of it. Every reply,
      // every weekly plan, every proof review.
      .select('name, tagline, draft, fit_test, advisor, success_likelihood, cut_at')
      .eq('user_id', userId).is('cut_at', null)
      .order('is_favorited', { ascending: false }).order('position').limit(1)
      .maybeSingle().then(r => r.data, () => null),
    sb.from('weekly_plans').select('*')
      .eq('user_id', userId).eq('week_of', lastMonday())
      .maybeSingle().then(r => r.data, () => null),
    sb.from('daily_checkins').select('checkin_date, progress_note, blockers')
      .eq('user_id', userId).gte('checkin_date', lastMonday())
      .order('checkin_date', { ascending: false }).limit(7)
      .then(r => r.data || [], () => [])
  ]);

  const rungs = ladders.ladderFor(p.path);
  const current = rungs.find(r => r.level === (p.current_level || 1)) || rungs[0];

  let bar = null;
  try { bar = traction.tractionFor(q, fitLib.founderFacts(q || {})); } catch (_) { bar = null; }

  const lastWeek = planRow && Array.isArray(planRow.items)
    ? {
        weekOf: planRow.week_of,
        items: planRow.items,
        done: planRow.items.filter(i => i && i.done).length,
        total: planRow.items.length
      }
    : null;

  return {
    userId,
    name: (q && q.founder_name) || p.display_name || p.username || 'there',
    plan: p,
    q: q || null,
    path, pathLabel: path ? path.label : 'not chosen yet',
    subpath: subSlug, subpathLabel: sub ? sub.label : null,
    level: p.current_level || 1,
    topLevel: rungs.reduce((m, r) => Math.max(m, r.level), 1),
    rungTitle: current ? current.title : '',
    rungEmoji: current ? current.emoji : '',
    next: ladder ? ladder.next : null,
    quests: ladder ? ladder.quests : [],
    needMin: ladder ? ladder.needMin : 0,
    xpNeeded: ladder ? ladder.xpNeeded : 0,
    blocker: ladder ? ladder.blocker : null,
    hours: (q && q.hours_per_week) || null,
    runway: (q && q.runway) || null,
    budget: (q && q.launch_budget) || null,
    dealBreakers: (q && q.deal_breakers) || null,
    idea: ideaRow || null,
    fitTest: (ideaRow && Array.isArray(ideaRow.fit_test) && ideaRow.fit_test) || [],
    fitResults: (ideaRow && ideaRow.advisor && Array.isArray(ideaRow.advisor.fit_results)
      && ideaRow.advisor.fit_results) || [],
    bar,
    streak: p.streak_days || 0,
    lastWeek,
    checkins: checkins || []
  };
}

// The context as the model reads it. Written as short labelled lines rather
// than prose because every one of them is a fact the answer must respect, and a
// paragraph invites the model to average them out.
function brief(ctx) {
  const L = [];
  const add = (k, v) => { if (v !== null && v !== undefined && String(v).trim()) L.push(k + ': ' + v); };

  add('Name', ctx.name);
  add('Path', ctx.pathLabel);
  add('Specifically', ctx.subpathLabel);
  L.push('Rung: Level ' + ctx.level + ' — ' + ctx.rungTitle);

  if (ctx.next) {
    L.push('Next rung: Level ' + ctx.next.level + ' — ' + ctx.next.title);
    const open = ctx.quests.filter(x => !x.done).map(x => x.title);
    const done = ctx.quests.filter(x => x.done).map(x => x.title);
    if (done.length) add('Already cleared for it', done.join('; '));
    if (open.length) {
      L.push('STILL BLOCKING the next rung' + (ctx.needMin && ctx.needMin < ctx.quests.length
        ? ' (any ' + ctx.needMin + ' of these will do)' : '') + ': ' + open.join('; '));
    }
    if (ctx.xpNeeded > 0) add('XP still needed', ctx.xpNeeded);
  } else if (ctx.topLevel && ctx.level >= ctx.topLevel) {
    L.push('At the top of their ladder — there is no next rung.');
  }

  add('Hours a week they actually have', ctx.hours);
  add('Runway without this earning', ctx.runway);
  add('Money to start', ctx.budget);
  add('Will not do, under any circumstances', ctx.dealBreakers);
  add('Check-in streak', ctx.streak ? ctx.streak + ' days' : null);

  if (ctx.bar) {
    add('The number this path turns on', ctx.bar.label + ' — at ' +
      (ctx.bar.current != null ? ctx.bar.current : 'unknown') + ', target ' + ctx.bar.target);
  }

  if (ctx.idea) {
    const d = ctx.idea.draft || {};
    L.push('Their idea: ' + ctx.idea.name + (ctx.idea.tagline ? ' — ' + ctx.idea.tagline : ''));
    add('  What it is', d.description);
    add('  Problem', d.problem);
    add('  First customer', d.customer);
    add('  How it makes money', d.monetization);
  } else {
    L.push('No idea drafted yet.');
  }

  const failing = ctx.fitResults.filter(f => f && f.pass === false).map(f => f.criterion);
  if (failing.length) add('Their own fit test is failing on', failing.join('; '));

  if (ctx.lastWeek) {
    L.push('LAST WEEK they were given ' + ctx.lastWeek.total + ' things and finished ' + ctx.lastWeek.done + ':');
    ctx.lastWeek.items.forEach(i => L.push('  [' + (i.done ? 'x' : ' ') + '] ' + (i.title || '')));
  }
  if (ctx.checkins.length) {
    const notes = ctx.checkins.map(c => c.progress_note).filter(Boolean).slice(0, 3);
    const blocks = ctx.checkins.map(c => c.blockers).filter(Boolean).slice(0, 3);
    if (notes.length) add('Recent check-in notes', notes.join(' | '));
    if (blocks.length) add('Blockers they named themselves', blocks.join(' | '));
  }

  return L.join('\n');
}

// The rule every one of these calls shares. Written once because the failure
// mode is the same in all of them: generic startup advice that would be true
// for anyone, which is exactly what the member can already get for free
// somewhere else.
const HOUSE_RULES =
  'You are the NoBossly coach. You are talking to someone who still has a job and is '
  + 'building a way out of it in the hours after work. '
  + 'Rules you never break: '
  + '(1) Everything you suggest must fit the hours and the money they told you they have — '
  + 'advice that needs them to go full time is worthless to them and they will not come back. '
  + '(2) Never suggest anything on their deal-breaker list. '
  + '(3) Be specific to their path and their subpath. A plumber and a podcaster do not get '
  + 'the same next step, and if your answer would read the same for both, it is wrong. '
  + '(4) Aim at the gate that is actually blocking their next rung. That is the one thing '
  + 'you know and a generic adviser does not. '
  + '(5) Short, plain, and concrete. No preamble, no encouragement padding, no bullet lists '
  + 'of things they already know. They have one evening.';

// --- the weekly plan --------------------------------------------------------

async function weeklyPlan(sb, token, ctx) {
  const out = await credits.run(sb, 'weekly_plan', () => ask(token, HOUSE_RULES,
    brief(ctx) + '\n\n'
    + 'Write THIS WEEK. Three things, no more — they have ' + (ctx.hours || 'a few hours') + '.\n'
    + 'If they were given a plan last week, open by naming what actually moved and what did not, '
    + 'in one sentence, without praise or scolding. Carry over anything unfinished that still matters '
    + 'and drop anything that no longer does — say which, if so.\n'
    + 'Every item must be finishable in one sitting on a weeknight or one block at the weekend, '
    + 'and must move them toward the gate that is blocking their next rung.\n\n'
    + 'Return JSON: { "intro": "one or two sentences, second person", '
    + '"items": [ { "title": "the action, imperative, under 90 characters", '
    + '"why": "one sentence on what it unlocks — name the rung or the gate", '
    + '"day": "Tue" | "Thu" | "Sat" or similar, "minutes": 45 } ] }',
    1400));

  const items = (Array.isArray(out.items) ? out.items : []).slice(0, 3).map(i => ({
    title: String((i && i.title) || '').slice(0, 140),
    why: String((i && i.why) || '').slice(0, 300),
    day: String((i && i.day) || '').slice(0, 12),
    minutes: Math.max(10, Math.min(480, parseInt(i && i.minutes, 10) || 45)),
    done: false
  })).filter(i => i.title);

  if (!items.length) throw new Error('the plan came back empty');
  return { intro: String(out.intro || '').slice(0, 600), items };
}

// Reads the plan back, so the next one can be written against what happened
// rather than against what was asked for.
async function savePlan(sb, userId, ctx, plan) {
  const gateSummary = ctx.next
    ? 'Level ' + ctx.next.level + ' — ' + ctx.next.title + ': '
      + (ctx.quests.filter(x => !x.done).map(x => x.title).join('; ') || 'XP only')
    : 'At the top of the ladder';
  const row = {
    user_id: userId, week_of: thisMonday(),
    level: ctx.level, rung_title: ctx.rungTitle,
    gate_summary: gateSummary.slice(0, 500),
    hours: ctx.hours || null,
    intro: plan.intro, items: plan.items,
    updated_at: new Date().toISOString()
  };
  const { data } = await sb.from('weekly_plans')
    .upsert(row, { onConflict: 'user_id,week_of' }).select('*').maybeSingle();
  return data;
}

// --- the coach chat ---------------------------------------------------------
//
// Prose, not JSON. History is capped at the last twelve turns because the
// context block above is where the value is — a long backlog of chat crowds out
// the facts and costs tokens to make the answer worse.

async function reply(sb, token, ctx, history, question) {
  const turns = (history || []).slice(-12)
    .map(m => (m.role === 'user' ? 'THEM: ' : 'YOU: ') + m.content).join('\n\n');
  return credits.run(sb, 'coach', () => ask(token, HOUSE_RULES
    + ' Answer in at most 180 words. If the honest answer is that they are asking the wrong '
    + 'question for where they are on the ladder, say so first, briefly, and then answer the '
    + 'right one. Never invent facts about their business you were not given.',
    'WHO YOU ARE TALKING TO:\n' + brief(ctx)
    + (turns ? '\n\nTHE CONVERSATION SO FAR:\n' + turns : '')
    + '\n\nTHEY SAY:\n' + question,
    700, { json: false }));
}

// --- proof review -----------------------------------------------------------
//
// The ladder's gates are cleared by real-world proof. This reads the note
// before it is posted to the Wins wall and says whether it actually clears the
// gate — which is both the most useful thing the AI can do here and the thing
// that welds it to the game instead of sitting beside it.

async function reviewProof(sb, token, ctx, gateTitle, note) {
  const out = await credits.run(sb, 'proof_review', () => ask(token, HOUSE_RULES
    + ' You are checking evidence, not encouraging. A generous review is worth nothing to them: '
    + 'the rung is supposed to mean something, and the Wins wall is public.',
    brief(ctx)
    + '\n\nTHE GATE THEY ARE CLAIMING: ' + gateTitle
    + '\n\nWHAT THEY WROTE AS PROOF:\n"""\n' + String(note || '').slice(0, 2000) + '\n"""\n\n'
    + 'Does that actually clear that gate? Return JSON: '
    + '{ "clears": true|false, '
    + '"verdict": "one sentence, direct, second person", '
    + '"missing": ["what the proof would need to be beyond doubt — empty if it already is"], '
    + '"stronger": "one sentence on how to say it on the Wins wall so it reads as real" }',
    800));
  return {
    clears: !!out.clears,
    verdict: String(out.verdict || '').slice(0, 400),
    missing: (Array.isArray(out.missing) ? out.missing : []).slice(0, 4).map(x => String(x).slice(0, 200)),
    stronger: String(out.stronger || '').slice(0, 400)
  };
}

// --- the reading list -------------------------------------------------------
//
// Free, deliberately. It costs one credit, it makes the hundred-and-twenty-nine
// published guides compound instead of only serving search traffic, and it is
// the cheapest way to show a free member that the AI here knows who they are.

async function readingList(sb, token, ctx, guides) {
  const menu = (guides || []).map((g, i) => i + '. ' + g.title + (g.excerpt ? ' — ' + String(g.excerpt).slice(0, 140) : ''));
  if (!menu.length) return null;
  const out = await credits.run(sb, 'reading_list', () => ask(token, HOUSE_RULES,
    brief(ctx) + '\n\nTHE LIBRARY (index. title — excerpt):\n' + menu.join('\n')
    + '\n\nPick the 3 guides that are most use to them THIS WEEK, given the gate blocking their '
    + 'next rung. Do not pick a guide because it is generally good; pick it because of where they '
    + 'are standing. If fewer than 3 are genuinely relevant, return fewer.\n\n'
    + 'Return JSON: { "picks": [ { "index": 0, "why": "one sentence, second person" } ] }',
    700));
  const picks = (Array.isArray(out.picks) ? out.picks : []).slice(0, 3)
    .map(p => ({ guide: guides[parseInt(p && p.index, 10)], why: String((p && p.why) || '').slice(0, 240) }))
    .filter(p => p.guide);
  return picks.length ? picks : null;
}

module.exports = {
  contextFor, brief, weeklyPlan, savePlan, reply, reviewProof, readingList,
  thisMonday, lastMonday, mondayOf, HOUSE_RULES
};
