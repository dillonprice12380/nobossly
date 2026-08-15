const router = require('express').Router();

// Where a notification takes you when tapped. Anything unmapped falls through to
// the notifications page rather than risking a 404 on a guessed URL.
const LINKS = {
  conversations: id => '/messages/c/' + id,
  messages: () => '/messages',
  tasks: () => '/tasks',
  task: () => '/tasks',
  ideas: () => '/ideas',
  generated_ideas: id => '/ideas/' + id,
  blueprints: id => '/blueprint/' + id,
  blueprint: id => '/blueprint/' + id,
  forum_threads: id => '/community/t/' + id,
  threads: id => '/community/t/' + id,
  thread: id => '/community/t/' + id,
  challenges: () => '/challenges',
  milestones: () => '/milestones',
  collab_projects: () => '/collaborations',
  collaborations: () => '/collaborations',
  wins: () => '/wins'
};

function hrefFor(n) {
  if (!n) return '/notifications';
  const build = n.entity_type ? LINKS[n.entity_type] : null;
  if (build && n.entity_id) {
    try {
      const href = build(n.entity_id);
      if (href) return href;
    } catch (_) { /* fall through */ }
  }
  switch (n.type) {
    case 'message': return '/messages';
    case 'task_due':
    case 'task_assigned':
    case 'tasks': return '/tasks';
    case 'ideas': return '/ideas';
    default: return '/notifications';
  }
}

// Feeds the nav bell dropdown. Deliberately does NOT mark anything read — that
// only happens when the founder acts on a notification or clears them.
router.get('/recent', async (req, res) => {
  try {
    const [{ data: notifs }, { count }] = await Promise.all([
      req.sb.from('notifications').select('id, type, message, entity_type, entity_id, is_read, created_at')
        .eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(10),
      req.sb.from('notifications').select('id', { count: 'exact', head: true })
        .eq('user_id', req.user.id).eq('is_read', false)
    ]);
    res.json({
      unread: count || 0,
      items: (notifs || []).map(n => ({
        id: n.id,
        type: n.type,
        message: n.message,
        is_read: !!n.is_read,
        created_at: n.created_at,
        href: '/notifications/go/' + n.id
      }))
    });
  } catch (e) {
    res.json({ unread: 0, items: [], error: 'Could not load notifications.' });
  }
});

router.post('/read-all', async (req, res) => {
  try {
    await req.sb.from('notifications').update({ is_read: true })
      .eq('user_id', req.user.id).eq('is_read', false);
    if (req.accepts(['html', 'json']) === 'json') return res.json({ ok: true });
    res.redirect('/notifications');
  } catch (e) {
    if (req.accepts(['html', 'json']) === 'json') return res.json({ ok: false });
    res.redirect('/notifications');
  }
});

// Tapping a notification marks that one read, then forwards to whatever it's about.
router.get('/go/:id', async (req, res, next) => {
  try {
    const { data: n } = await req.sb.from('notifications').select('*')
      .eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (!n) return res.redirect('/notifications');
    if (!n.is_read) {
      await req.sb.from('notifications').update({ is_read: true }).eq('id', n.id);
    }
    res.redirect(hrefFor(n));
  } catch (e) { next(e); }
});

router.get('/', async (req, res, next) => {
  try {
    const { data: notifs } = await req.sb.from('notifications').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(60);
    req.sb.from('notifications').update({ is_read: true }).eq('user_id', req.user.id).eq('is_read', false).then(() => {});
    res.render('notifications', { title: 'Notifications', notifs: notifs || [] });
  } catch (e) { next(e); }
});

module.exports = router;
