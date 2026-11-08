const router = require('express').Router();
const dashboards = require('../path_dashboards');
const news = require('../news');
const { awardXP, bumpStreak, ladderStatus } = require('../xp');
const ladders = require('../ladders');
const paths = require('../paths');
const { sweepMilestones } = require('../milestones_engine');
const { forLevel } = require('../unlocks');
const { claimFeedbackGate } = require('./reviews');
const activity = require('../activity');
const { firstWeek } = require('../first_week');
const starter = require('../starter_tasks');
const dashData = require('../dashboard_data');
const dashLayout = require('../dashboard_layout');
const { FLAGS } = require('../features');

router.get('/', async (req, res, next) => {
  try {
    const p = req.profile || {};
    // Choosing a path is the only onboarding step left. Until it's done, the
    // dashboard nudges toward /choose-path instead of hiding the rest of the
    // app — a member can look around either way.
    const needsPath = !p.path;

    // Three peers may have reviewed this founder's work while they were away.
    try { await claimFeedbackGate(req); } catch (_) { /* self-heals on /reviews */ }

    const [{ data: sprint }, { data: acc }, { data: customAcc }] = await Promise.all([
      req.sb.from('sprints').select('*').eq('user_id', req.user.id).eq('status', 'active').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      req.sb.from('challenge_acceptances').select('*').eq('user_id', req.user.id).eq('status', 'active').order('due_date'),
      req.sb.from('user_custom_challenges').select('*').eq('user_id', req.user.id).eq('status', 'active').order('due_date')
    ]);
    let pinned = [];
    if (acc && acc.length) {
      const { data: chs } = await req.sb.from('challenges').select('id, title, emoji, xp_reward, requires_proof').in('id', acc.map(a => a.challenge_id));
      const chMap = {}; (chs || []).forEach(c => chMap[c.id] = c);
      pinned = acc.map(a => ({ ...a, challenge: chMap[a.challenge_id] || {} }));
    }
    // Accepted electives pin alongside curated quests — an accepted commitment
    // is an accepted commitment, whichever table it lives in.
    (customAcc || []).forEach(c => {
      pinned.push({
        custom: true, id: c.id, challenge_id: c.id,
        duration_days: c.duration_days, due_date: c.due_date,
        challenge: { title: c.title, emoji: c.emoji || '🏁', xp_reward: c.xp_reward || 0 }
      });
    });
    pinned.sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));

    // The check-in is the daily loop, and it stands on its own: anyone who has
    // finished onboarding can check in, sprint or no sprint.
    const { data: checkinRow } = await req.sb.from('daily_checkins')
      .select('id').eq('user_id', req.user.id)
      .eq('checkin_date', new Date().toISOString().slice(0, 10)).maybeSingle();
    const checkinToday = checkinRow;

    let tasks = [];
    if (sprint) {
      const { data: t } = await req.sb.from('sprint_tasks').select('*').eq('sprint_id', sprint.id).order('position');
      tasks = t || [];
    }

    const lvls = ladders.ladderFor(p.path);
    const pathDef = paths.get(p.path);
    const yourPath = pathDef ? { label: pathDef.label, emoji: pathDef.emoji } : null;
    const cur = lvls.find(l => l.level === (p.current_level || 1)) || { title: 'Dreamer', xp_required: 0, emoji: '🌱' };
    const next = lvls.find(l => l.level === (p.current_level || 1) + 1);

    const ladder = await ladderStatus(req.sb, req.user.id, p);
    if (ladder) ladder.unlocks = forLevel(ladder.next.level);

    // Progress analytics — free for everyone.
    const since = new Date(Date.now() - 8 * 7 * 86400000).toISOString();
    const [{ data: doneTasks }, { data: xpEvents }, { count: openCount }] = await Promise.all([
      req.sb.from('tasks').select('completed_at').eq('user_id', req.user.id).eq('status', 'done').gte('completed_at', since).limit(1000),
      req.sb.from('xp_events').select('amount, created_at').eq('user_id', req.user.id).gte('created_at', since).limit(2000),
      req.sb.from('tasks').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id).neq('status', 'done')
    ]);
    const weeks = [];
    for (let i = 7; i >= 0; i--) {
      const start = new Date(Date.now() - (i + 1) * 7 * 86400000);
      const end = new Date(Date.now() - i * 7 * 86400000);
      const label = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const tasksDone = (doneTasks || []).filter(t => t.completed_at && new Date(t.completed_at) >= start && new Date(t.completed_at) < end).length;
      const xp = (xpEvents || []).reduce((s, e) => (new Date(e.created_at) >= start && new Date(e.created_at) < end) ? s + (e.amount || 0) : s, 0);
      weeks.push({ label, tasksDone, xp });
    }
    const analytics = {
      weeks,
      maxTasks: Math.max(1, ...weeks.map(w => w.tasksDone)),
      maxXp: Math.max(1, ...weeks.map(w => w.xp)),
      totalDone: (doneTasks || []).length,
      totalXp: (xpEvents || []).reduce((s, e) => s + (e.amount || 0), 0),
      openTasks: openCount || 0
    };

    // A peek at the feed — what people you follow are working on. Cheap to read
    // and the reason the dashboard is where people actually land.
    const feed = await activity.feedFor(req.sb, req.user.id, { limit: 5 });
    const checklist = await firstWeek(req.sb, req.user, p).catch(() => null);
    // The path's own dashboard: stage, number, boards, checklists.
    const pathPanel = await dashboards.panelFor(req.sb, req.user.id, p).catch(e => { console.error('[path panel]', e.message || e); return null; });
    // The latest headlines for the member's path (src/news.js).
    const pathNews = await news.forMember(req.sb, p, { limit: 4 }).then(r => r.items, () => []);
    // The cards across the top: this month's money and the week ahead.
    const layout = dashLayout.resolve(p.dashboard_layout, FLAGS);
    const shows = k => layout.top.includes(k);
    const [money, upcoming] = await Promise.all([
      shows('money') ? dashData.moneyGlance(req).catch(e => { console.error('[dash money]', e.message || e); return null; }) : null,
      shows('upcoming') ? dashData.upcoming(req.sb, req.user.id, { pinned }).catch(e => { console.error('[dash upcoming]', e.message || e); return null; }) : null
    ]);

    res.render('dashboard', {
      title: 'Dashboard', sprint, tasks, checkinToday: !!checkinToday,
      msg: req.query.msg || null, today: new Date().toISOString().slice(0, 10),
      // The path's featured workspace tools (src/path_dashboards).
      needsSetup: dashboards.needsSetup(p), pathTools: dashboards.featuredFor(p.path), pathPanel,
      pathNews, newsAgo: news.ago,
      layout, money, upcoming, whenLabel: d => dashData.whenLabel(d),
      levelInfo: { current: cur, next }, ladder, yourPath, pinned, analytics,
      needsPath, checklist,
      // Suggested first tasks for a new sprint, matched to the member's path.
      sprintSuggestions: sprint ? [] : starter.forPath(p.path).slice(0, 5),
      feedPeek: feed.events, following: feed.following,
      // A follower's rung has to come from THEIR ladder: Level 4 is "Regular"
      // for a creator and "Quoting" for a plumber.
      rungTitle: (path, level) => {
        const r = (ladders.ladderFor(path) || []).find(x => x.level === level);
        return r ? r.title : '';
      }
    });
  } catch (e) { next(e); }
});

// Customize: reorder and hide the dashboard's sections. Plain forms, one
// change per press, so it works without JavaScript.
const layoutReady = p => Object.prototype.hasOwnProperty.call(p || {}, 'dashboard_layout');

router.get('/customize', (req, res) => {
  const p = req.profile || {};
  const layout = dashLayout.resolve(p.dashboard_layout, FLAGS);
  const cols = { top: 'Across the top', main: 'Left column', side: 'Right column' };
  res.render('dashboard_customize', {
    title: 'Customize your dashboard', layout, cols, ready: layoutReady(p),
    msg: req.query.msg || null
  });
});

router.post('/layout', async (req, res, next) => {
  try {
    const back = '/dashboard/customize';
    if (!layoutReady(req.profile)) return res.redirect(back + '?msg=' + encodeURIComponent('Customizing is being switched on. Check back shortly.'));
    const value = dashLayout.apply(req.profile.dashboard_layout, req.body || {}, FLAGS);
    if (value === undefined) return res.redirect(back);
    const { error } = await req.sb.from('profiles').update({ dashboard_layout: value }).eq('id', req.user.id);
    if (error) return res.redirect(back + '?msg=' + encodeURIComponent('That did not save. Try again.'));
    const key = String((req.body || {}).key || '');
    res.redirect(back + (value === null ? '?msg=' + encodeURIComponent('Back to the standard layout.') : (key ? '#sec-' + encodeURIComponent(key) : '')));
  } catch (e) { next(e); }
});

// Start a sprint — manual now: name it, set a goal, add your own tasks. No
// more AI planning from a blueprint (blueprints are gone).
router.post('/sprint/start', async (req, res, next) => {
  try {
    const { data: existing } = await req.sb.from('sprints').select('id').eq('user_id', req.user.id).eq('status', 'active').limit(1).maybeSingle();
    if (existing) return res.redirect('/dashboard');
    const { count } = await req.sb.from('sprints').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id);
    const sprintNumber = (count || 0) + 1;
    const theme = String(req.body.theme || '').trim().slice(0, 120) || 'Sprint ' + sprintNumber;
    const goal = String(req.body.goal || '').trim().slice(0, 400);
    const start = new Date();
    const end = new Date(Date.now() + 6 * 86400000);
    const { data: sprint, error } = await req.sb.from('sprints').insert({
      user_id: req.user.id, sprint_number: sprintNumber,
      theme, days_label: 'Days ' + ((sprintNumber - 1) * 7 + 1) + '-' + (sprintNumber * 7),
      goal, status: 'active',
      start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10),
      tasks_total: 0, tasks_done: 0, velocity_pct: 0
    }).select().maybeSingle();
    if (error) throw error;
    // Any suggested tasks the member kept ticked go straight onto the sprint.
    const offered = starter.forPath(req.profile.path);
    const picked = [].concat(req.body.task || []).map(String).filter(t => offered.includes(t)).slice(0, 7);
    for (let i = 0; i < picked.length; i++) {
      await req.sb.from('sprint_tasks').insert({
        user_id: req.user.id, sprint_id: sprint.id, title: picked[i],
        priority: 'medium', status: 'todo', position: i
      });
    }
    if (picked.length) await req.sb.from('sprints').update({ tasks_total: picked.length }).eq('id', sprint.id);
    await awardXP(req.sb, req.user.id, req.profile, 'sprint_started', 'Started a sprint', 'sprints', sprint.id);
    try { await sweepMilestones(req.sb, req.user.id, req.profile, res.locals.plan === 'paid'); } catch (_) { /* trophies self-heal on the milestones page */ }
    res.redirect('/dashboard');
  } catch (e) { next(e); }
});

// Add a task to the active sprint — manual.
router.post('/sprint/task/add', async (req, res, next) => {
  try {
    const { data: sprint } = await req.sb.from('sprints').select('id').eq('user_id', req.user.id).eq('status', 'active').maybeSingle();
    if (!sprint) return res.redirect('/dashboard');
    const title = String(req.body.title || '').trim().slice(0, 200);
    if (title) {
      const { count } = await req.sb.from('sprint_tasks').select('id', { count: 'exact', head: true }).eq('sprint_id', sprint.id);
      await req.sb.from('sprint_tasks').insert({
        user_id: req.user.id, sprint_id: sprint.id, title,
        priority: ['high', 'medium', 'low'].includes(req.body.priority) ? req.body.priority : 'medium',
        status: 'todo', position: count || 0
      });
      const { data: all } = await req.sb.from('sprint_tasks').select('status').eq('sprint_id', sprint.id);
      await req.sb.from('sprints').update({ tasks_total: (all || []).length }).eq('id', sprint.id);
    }
    res.redirect('/dashboard');
  } catch (e) { next(e); }
});

// End the active sprint early, or once its week is up.
router.post('/sprint/end', async (req, res, next) => {
  try {
    await req.sb.from('sprints').update({ status: 'completed' }).eq('user_id', req.user.id).eq('status', 'active');
    res.redirect('/dashboard');
  } catch (e) { next(e); }
});

// Toggle task done
router.post('/task/:id/toggle', async (req, res) => {
  try {
    const { data: task } = await req.sb.from('sprint_tasks').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (!task) return res.json({ error: 'Not found' });
    const done = task.status !== 'done';
    await req.sb.from('sprint_tasks').update({
      status: done ? 'done' : 'todo',
      completed_at: done ? new Date().toISOString() : null
    }).eq('id', task.id);

    const { data: all } = await req.sb.from('sprint_tasks').select('status').eq('sprint_id', task.sprint_id);
    const doneCount = (all || []).filter(t => t.status === 'done').length;
    const total = (all || []).length;
    await req.sb.from('sprints').update({
      tasks_done: doneCount,
      velocity_pct: total ? Math.round(100 * doneCount / total) : 0
    }).eq('id', task.sprint_id);

    let xp = null;
    let trophies = [];
    if (done) {
      await req.sb.from('profiles').update({ tasks_completed: (req.profile.tasks_completed || 0) + 1 }).eq('id', req.user.id);
      xp = await awardXP(req.sb, req.user.id, req.profile, 'sprint_task_done', 'Completed task: ' + task.title, 'sprint_tasks', task.id);
      try {
        const { fresh } = await sweepMilestones(req.sb, req.user.id, req.profile, res.locals.plan === 'paid');
        trophies = fresh.map(d => ({ emoji: d.emoji, title: d.title }));
      } catch (_) { /* trophies self-heal on the milestones page */ }
    }
    res.json({ ok: true, done, doneCount, total, xp, trophies });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Daily check-in
router.get('/checkin', async (req, res, next) => {
  try {
    const { data: sprint } = await req.sb.from('sprints').select('id, theme, goal').eq('user_id', req.user.id).eq('status', 'active').limit(1).maybeSingle();
    res.render('checkin', { title: 'Daily check-in', sprint });
  } catch (e) { next(e); }
});

router.post('/checkin', async (req, res, next) => {
  try {
    const b = req.body;
    const today = new Date().toISOString().slice(0, 10);
    const { data: existing } = await req.sb.from('daily_checkins').select('id').eq('user_id', req.user.id).eq('checkin_date', today).maybeSingle();
    if (existing) return res.redirect('/dashboard');
    await req.sb.from('daily_checkins').insert({
      user_id: req.user.id, sprint_id: b.sprint_id || null, checkin_date: today,
      mood_score: parseInt(b.mood_score, 10) || 3,
      progress_note: b.progress_note || '', blockers: b.blockers || '',
      wins_today: b.wins_today || '', tomorrow_plan: b.tomorrow_plan || '', xp_awarded: 15
    });
    const streak = await bumpStreak(req.sb, req.user.id, req.profile);
    await awardXP(req.sb, req.user.id, req.profile, 'daily_checkin', 'Daily check-in (streak ' + streak + ')', 'daily_checkins', null);
    try {
      await sweepMilestones(req.sb, req.user.id, { ...req.profile, streak_days: Math.max(streak || 0, req.profile.streak_days || 0) }, res.locals.plan === 'paid');
    } catch (_) { /* trophies self-heal on the milestones page */ }
    res.redirect('/dashboard');
  } catch (e) { next(e); }
});

module.exports = router;
