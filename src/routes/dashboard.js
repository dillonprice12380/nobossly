const router = require('express').Router();
const ai = require('../ai');
const { awardXP, bumpStreak } = require('../xp');

router.get('/', async (req, res, next) => {
  try {
    const p = req.profile || {};
    if (!p.onboarding_completed) return res.redirect('/questionnaire');

    const [{ data: sprint }, { data: ideas }, { data: levels }, { data: acc }] = await Promise.all([
      req.sb.from('sprints').select('*').eq('user_id', req.user.id).eq('status', 'active').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      req.sb.from('generated_ideas').select('id,name,tagline,status,is_favorited,success_likelihood').eq('user_id', req.user.id).order('position'),
      req.sb.from('founder_levels').select('*').order('xp_required'),
      req.sb.from('challenge_acceptances').select('*').eq('user_id', req.user.id).eq('status', 'active').order('due_date')
    ]);
    let pinned = [];
    if (acc && acc.length) {
      const { data: chs } = await req.sb.from('challenges').select('id, title, emoji, xp_reward').in('id', acc.map(a => a.challenge_id));
      const chMap = {}; (chs || []).forEach(c => chMap[c.id] = c);
      pinned = acc.map(a => ({ ...a, challenge: chMap[a.challenge_id] || {} }));
    }

    let tasks = [];
    let checkinToday = null;
    if (sprint) {
      const [{ data: t }, { data: c }] = await Promise.all([
        req.sb.from('sprint_tasks').select('*').eq('sprint_id', sprint.id).order('position'),
        req.sb.from('daily_checkins').select('id').eq('user_id', req.user.id).eq('checkin_date', new Date().toISOString().slice(0, 10)).maybeSingle()
      ]);
      tasks = t || [];
      checkinToday = c;
    }

    const lvls = levels || [];
    const cur = lvls.find(l => l.level === (p.current_level || 1)) || { title: 'Dreamer', xp_required: 0, emoji: '🌱' };
    const next = lvls.find(l => l.level === (p.current_level || 1) + 1);

    // progress analytics (paid)
    let analytics = null;
    if (res.locals.plan === 'paid') {
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
      analytics = {
        weeks,
        maxTasks: Math.max(1, ...weeks.map(w => w.tasksDone)),
        maxXp: Math.max(1, ...weeks.map(w => w.xp)),
        totalDone: (doneTasks || []).length,
        totalXp: (xpEvents || []).reduce((s, e) => s + (e.amount || 0), 0),
        openTasks: openCount || 0
      };
    }

    res.render('dashboard', {
      title: 'Dashboard', sprint, tasks, ideas: ideas || [], checkinToday: !!checkinToday,
      levelInfo: { current: cur, next }, aiReady: ai.hasKey(), pinned, analytics
    });
  } catch (e) { next(e); }
});

// Start a sprint from a blueprint
router.get('/sprint/start/:blueprintId', async (req, res, next) => {
  try {
    const { data: bp } = await req.sb.from('blueprints').select('*').eq('id', req.params.blueprintId).eq('user_id', req.user.id).maybeSingle();
    if (!bp) return res.redirect('/ideas');
    res.render('generating', { title: 'Planning sprint', action: '/dashboard/sprint/start/' + bp.id, label: 'Planning your first 7-day sprint…' });
  } catch (e) { next(e); }
});

router.post('/sprint/start/:blueprintId', async (req, res) => {
  try {
    const { data: bp } = await req.sb.from('blueprints').select('*').eq('id', req.params.blueprintId).eq('user_id', req.user.id).maybeSingle();
    if (!bp) return res.json({ redirect: '/ideas' });
    

    const { count } = await req.sb.from('sprints').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id);
    const sprintNumber = (count || 0) + 1;
    const plan = await ai.generateSprintTasks(req.accessToken, bp, sprintNumber);

    const start = new Date();
    const end = new Date(Date.now() + 6 * 86400000);
    const { data: sprint, error } = await req.sb.from('sprints').insert({
      user_id: req.user.id, blueprint_id: bp.id, idea_id: bp.idea_id, sprint_number: sprintNumber,
      theme: plan.theme || 'Launch sprint', days_label: 'Days ' + ((sprintNumber - 1) * 7 + 1) + '-' + (sprintNumber * 7),
      goal: plan.goal || '', status: 'active',
      start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10),
      tasks_total: (plan.tasks || []).length, tasks_done: 0, velocity_pct: 0
    }).select().maybeSingle();
    if (error) throw error;

    const taskRows = (plan.tasks || []).map((t, i) => ({
      user_id: req.user.id, sprint_id: sprint.id, title: t.title, description: t.description || '',
      priority: ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium',
      status: 'todo', position: i, ai_generated: true
    }));
    if (taskRows.length) await req.sb.from('sprint_tasks').insert(taskRows);
    await awardXP(req.sb, req.user.id, req.profile, 30, 'Started a sprint', 'sprints', sprint.id);
    res.json({ redirect: '/dashboard' });
  } catch (e) {
    console.error('sprint start', e);
    res.json({ error: 'Sprint planning failed: ' + e.message });
  }
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
    if (done) {
      await req.sb.from('profiles').update({ tasks_completed: (req.profile.tasks_completed || 0) + 1 }).eq('id', req.user.id);
      xp = await awardXP(req.sb, req.user.id, req.profile, 10, 'Completed task: ' + task.title, 'sprint_tasks', task.id);
    }
    res.json({ ok: true, done, doneCount, total, xp });
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
    await awardXP(req.sb, req.user.id, req.profile, 15, 'Daily check-in (streak ' + streak + ')', 'daily_checkins', null);
    res.redirect('/dashboard');
  } catch (e) { next(e); }
});

module.exports = router;
