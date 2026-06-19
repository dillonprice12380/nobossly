const router = require('express').Router();
const { planOf } = require('../middleware/auth');

const isPaid = req => planOf(req.profile) === 'paid';

router.get('/', async (req, res, next) => {
  try {
    const [{ data: owned }, { data: memberships }] = await Promise.all([
      req.sb.from('collab_projects').select('*').eq('owner_id', req.user.id).order('created_at', { ascending: false }),
      req.sb.from('collab_members').select('*, project:collab_projects(id, name, description, owner_id)').eq('user_id', req.user.id)
    ]);
    const invites = (memberships || []).filter(m => m.status === 'invited');
    const joined = (memberships || []).filter(m => m.status === 'accepted');
    const allProjects = [...(owned || []), ...joined.map(m => m.project).filter(Boolean)];
    const projIds = allProjects.map(p => p.id);
    let membersByProject = {}, pmap = {};
    if (projIds.length) {
      const { data: members } = await req.sb.from('collab_members').select('*').in('project_id', projIds);
      const userIds = [...new Set([...(members || []).map(m => m.user_id), ...allProjects.map(p => p.owner_id)])];
      const { data: profiles } = userIds.length ? await req.sb.from('profiles').select('id, username, display_name').in('id', userIds) : { data: [] };
      (profiles || []).forEach(p => pmap[p.id] = p);
      (members || []).forEach(m => { (membersByProject[m.project_id] = membersByProject[m.project_id] || []).push(m); });
    }
    res.render('collaborations', {
      title: 'Collaborations', owned: owned || [], joined, invites,
      membersByProject, pmap, me: req.user.id, paid: isPaid(req),
      msg: req.query.msg || null, err: req.query.err || null
    });
  } catch (e) { next(e); }
});

router.post('/create', async (req, res, next) => {
  try {
    if (!isPaid(req)) return res.redirect('/pricing?upgrade=1');
    const name = (req.body.name || '').trim().slice(0, 80);
    if (!name) return res.redirect('/collaborations?err=' + encodeURIComponent('Project name is required.'));
    await req.sb.from('collab_projects').insert({
      owner_id: req.user.id, name, description: (req.body.description || '').slice(0, 500)
    });
    res.redirect('/collaborations?msg=' + encodeURIComponent('Project created. Invite your first member!'));
  } catch (e) { next(e); }
});

router.post('/:id/invite', async (req, res, next) => {
  try {
    if (!isPaid(req)) return res.redirect('/pricing?upgrade=1');
    const username = (req.body.username || '').trim().replace(/^@/, '');
    const { data: project } = await req.sb.from('collab_projects').select('*').eq('id', req.params.id).eq('owner_id', req.user.id).maybeSingle();
    if (!project) return res.redirect('/collaborations?err=' + encodeURIComponent('Project not found.'));
    const { data: person } = await req.sb.from('profiles').select('id, username, display_name').eq('username', username).maybeSingle();
    if (!person) return res.redirect('/collaborations?err=' + encodeURIComponent('No member found with username "' + username + '".'));
    if (person.id === req.user.id) return res.redirect('/collaborations?err=' + encodeURIComponent('That is you!'));
    const { error } = await req.sb.from('collab_members').insert({
      project_id: project.id, user_id: person.id, invited_by: req.user.id
    });
    if (error) return res.redirect('/collaborations?err=' + encodeURIComponent(error.code === '23505' ? 'Already invited.' : error.message));
    await req.sb.rpc('push_notification', {
      target_user: person.id, ntype: 'collab_invite',
      nmessage: (req.profile.display_name || 'Someone') + ' invited you to collaborate on "' + project.name + '"',
      nentity_type: 'collab_projects', nentity_id: project.id
    }).then(() => {}, () => {});
    res.redirect('/collaborations?msg=' + encodeURIComponent('Invite sent to ' + (person.display_name || person.username) + '.'));
  } catch (e) { next(e); }
});

router.post('/invite/:id/respond', async (req, res, next) => {
  try {
    const status = req.body.action === 'accept' ? 'accepted' : 'declined';
    const { data: invite } = await req.sb.from('collab_members').select('*, project:collab_projects(name, owner_id)').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (invite) {
      await req.sb.from('collab_members').update({ status }).eq('id', invite.id);
      if (invite.project) {
        await req.sb.rpc('push_notification', {
          target_user: invite.project.owner_id, ntype: 'collab_response',
          nmessage: (req.profile.display_name || 'Someone') + (status === 'accepted' ? ' joined ' : ' declined ') + '"' + invite.project.name + '"',
          nentity_type: 'collab_projects', nentity_id: invite.project_id
        }).then(() => {}, () => {});
      }
    }
    res.redirect('/collaborations');
  } catch (e) { next(e); }
});

router.post('/:id/remove/:memberId', async (req, res, next) => {
  try {
    await req.sb.from('collab_members').delete().eq('id', req.params.memberId).eq('project_id', req.params.id);
    res.redirect('/collaborations');
  } catch (e) { next(e); }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    await req.sb.from('collab_projects').delete().eq('id', req.params.id).eq('owner_id', req.user.id);
    res.redirect('/collaborations');
  } catch (e) { next(e); }
});

module.exports = router;
