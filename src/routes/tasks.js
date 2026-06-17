const router = require('express').Router();
const { planOf } = require('../middleware/auth');

const STATUSES = ['todo', 'in_progress', 'blocked', 'done'];
const PRIORITIES = ['urgent', 'high', 'medium', 'low'];

// All accepted teammates across projects I own or belong to (plus owners)
async function getTeam(sb, userId) {
  const { data: owned } = await sb.from('collab_projects').select('id, owner_id').eq('owner_id', userId);
  const { data: mine } = await sb.from('collab_members').select('project_id').eq('user_id', userId).eq('status', 'accepted');
  const projectIds = [...new Set([...(owned || []).map(p => p.id), ...(mine || []).map(m => m.project_id)])];
  if (!projectIds.length) return [];
  const [{ data: members }, { data: projects }] = await Promise.all([
    sb.from('collab_members').select('user_id').in('project_id', projectIds).eq('status', 'accepted'),
    sb.from('collab_projects').select('owner_id').in('id', projectIds)
  ]);
  const ids = [...new Set([...(members || []).map(m => m.user_id), ...(projects || []).map(p => p.owner_id)])].filter(id => id !== userId);
  if (!ids.length) return [];
  const { data: profiles } = await sb.from('profiles').select('id, username, display_name').in('id', ids);
  return profiles || [];
}

router.get('/', async (req, res, next) => {
  try {
    const listFilter = req.query.list || '';
    let q = req.sb.from('tasks').select('*').is('parent_id', null)
      .or(`user_id.eq.${req.user.id},assigned_to.eq.${req.user.id}`)
      .order('position');
    if (listFilter) q = q.eq('list_id', listFilter);
    const [{ data: lists }, { data: tasks }, team] = await Promise.all([
      req.sb.from('task_lists').select('*').eq('user_id', req.user.id).order('created_at'),
      q,
      getTeam(req.sb, req.user.id)
    ]);
    const ids = (tasks || []).map(t => t.id);
    const { data: subsRaw } = ids.length
      ? await req.sb.from('tasks').select('*').in('parent_id', ids).order('created_at')
      : { data: [] };
    const subs = {};
    (subsRaw || []).forEach(s => { (subs[s.parent_id] = subs[s.parent_id] || []).push(s); });
    const byStatus = {};
    STATUSES.forEach(st => byStatus[st] = (tasks || []).filter(t => t.status === st));
    const pmap = { [req.user.id]: req.profile };
    team.forEach(p => pmap[p.id] = p);
    res.render('tasks', {
      title: 'Tasks', lists: lists || [], byStatus, subs,
      statuses: STATUSES, priorities: PRIORITIES, listFilter, team, pmap, me: req.user.id
    });
  } catch (e) { next(e); }
});

router.post('/list', async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim().slice(0, 60);
    if (name) await req.sb.from('task_lists').insert({ user_id: req.user.id, name });
    res.redirect('/tasks');
  } catch (e) { next(e); }
});

router.post('/list/:id/delete', async (req, res, next) => {
  try {
    await req.sb.from('task_lists').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    res.redirect('/tasks');
  } catch (e) { next(e); }
});

router.post('/create', async (req, res, next) => {
  try {
    const b = req.body;
    const title = (b.title || '').trim().slice(0, 200);
    if (!title) return res.json({ error: 'Title required' });
    if (planOf(req.profile) === 'free') {
      const { count } = await req.sb.from('tasks').select('id', { count: 'exact', head: true })
        .eq('user_id', req.user.id).neq('status', 'done');
      if ((count || 0) >= 8) return res.json({ error: 'The free plan lets you manage up to 8 open tasks at a time. Complete some tasks or upgrade for unlimited tasks + AI roadmaps → nobossly.com/pricing' });
    }
    let assignee = b.assigned_to || req.user.id;
    if (assignee !== req.user.id) {
      const team = await getTeam(req.sb, req.user.id);
      if (!team.some(p => p.id === assignee)) assignee = req.user.id;
    }
    const row = {
      user_id: req.user.id,
      title,
      description: (b.description || '').slice(0, 2000),
      priority: PRIORITIES.includes(b.priority) ? b.priority : 'medium',
      status: STATUSES.includes(b.status) ? b.status : 'todo',
      list_id: b.list_id || null,
      parent_id: b.parent_id || null,
      due_date: b.due_date || null,
      due_time: b.due_time || null,
      assigned_to: assignee,
      labels: typeof b.labels === 'string' && b.labels.trim() ? b.labels.split(',').map(x => x.trim()).filter(Boolean).slice(0, 8) : (Array.isArray(b.labels) ? b.labels : [])
    };
    const { data, error } = await req.sb.from('tasks').insert(row).select().maybeSingle();
    if (error) return res.json({ error: error.message });
    if (assignee !== req.user.id) {
      await req.sb.rpc('push_notification', {
        target_user: assignee, ntype: 'task_assigned',
        nmessage: (req.profile.display_name || 'A teammate') + ' assigned you a task: "' + title.slice(0, 60) + '"',
        nentity_type: null, nentity_id: null
      }).then(() => {}, () => {});
    }
    res.json({ ok: true, task: data });
  } catch (e) { next(e); }
});

router.post('/:id/update', async (req, res, next) => {
  try {
    const b = req.body;
    const patch = {};
    if (b.status && STATUSES.includes(b.status)) {
      patch.status = b.status;
      patch.completed_at = b.status === 'done' ? new Date().toISOString() : null;
    }
    if (b.priority && PRIORITIES.includes(b.priority)) patch.priority = b.priority;
    if (b.title) patch.title = String(b.title).slice(0, 200);
    if ('description' in b) patch.description = String(b.description || '').slice(0, 2000);
    if ('due_date' in b) patch.due_date = b.due_date || null;
    if ('due_time' in b) patch.due_time = b.due_time || null;
    if ('list_id' in b) patch.list_id = b.list_id || null;
    if ('labels' in b) patch.labels = typeof b.labels === 'string'
      ? b.labels.split(',').map(x => x.trim()).filter(Boolean).slice(0, 8)
      : (Array.isArray(b.labels) ? b.labels : []);
    if ('assigned_to' in b && b.assigned_to) {
      if (b.assigned_to === req.user.id) patch.assigned_to = b.assigned_to;
      else {
        const team = await getTeam(req.sb, req.user.id);
        if (team.some(p => p.id === b.assigned_to)) {
          patch.assigned_to = b.assigned_to;
          await req.sb.rpc('push_notification', {
            target_user: b.assigned_to, ntype: 'task_assigned',
            nmessage: (req.profile.display_name || 'A teammate') + ' assigned you a task' + (b.title ? ': "' + String(b.title).slice(0, 60) + '"' : ''),
            nentity_type: null, nentity_id: null
          }).then(() => {}, () => {});
        }
      }
    }
    const { error } = await req.sb.from('tasks').update(patch).eq('id', req.params.id);
    if (error) return res.json({ error: error.message });
    if (patch.status === 'done') {
      const { awardXP } = require('../xp');
      await awardXP(req.sb, req.user.id, req.profile, 10, 'Completed a task', 'tasks', req.params.id);
      await req.sb.from('profiles').update({ tasks_completed: (req.profile.tasks_completed || 0) + 1 }).eq('id', req.user.id);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    const { error } = await req.sb.from('tasks').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    if (error) return res.json({ error: error.message });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
