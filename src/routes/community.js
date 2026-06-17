const router = require('express').Router();
const { awardXP } = require('../xp');
const { notifySocial } = require('../notify');
const { sanitizeForumHtml, addLinkCards } = require('../richtext');
const { requireAuth } = require('../middleware/auth');
const { anonClient } = require('../supabase');
const db = req => req.sb || anonClient();

const REACTIONS = [
  { key: 'thumbs_up', emoji: '\ud83d\udc4d', label: 'Thumbs up' },
  { key: 'heart', emoji: '\u2764\ufe0f', label: 'Heart' },
  { key: 'clap', emoji: '\ud83d\udc4f', label: 'Clapping' },
  { key: 'laugh', emoji: '\ud83d\ude02', label: 'Laugh' },
  { key: 'inspired', emoji: '\u2728', label: 'Inspired' }
];

const parseTags = raw => [...new Set(String(raw || '').split(',').map(t => t.trim().toLowerCase().replace(/[^a-z0-9 -]/g, '').slice(0, 24)).filter(Boolean))].slice(0, 5);

async function loadForumSidebar(req) {
  const [{ data: latestPosts }, { data: popularPosts }] = await Promise.all([
    db(req).from('forum_threads').select('id, title, created_at, reply_count').order('created_at', { ascending: false }).limit(5),
    db(req).from('forum_threads').select('id, title, created_at, reply_count').order('reply_count', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(5)
  ]);
  return { latestPosts: latestPosts || [], popularPosts: popularPosts || [] };
}

async function loadReactions(req, threadId, replyIds) {
  let qy = db(req).from('forum_reactions').select('user_id, entity_type, entity_id, reaction');
  const { data } = await qy.or('and(entity_type.eq.thread,entity_id.eq.' + threadId + ')' + (replyIds.length ? ',and(entity_type.eq.reply,entity_id.in.(' + replyIds.join(',') + '))' : ''));
  const counts = {}; const mine = {};
  (data || []).forEach(r => {
    const k = r.entity_type + ':' + r.entity_id;
    counts[k] = counts[k] || {};
    counts[k][r.reaction] = (counts[k][r.reaction] || 0) + 1;
    if (req.user && r.user_id === req.user.id) { mine[k] = mine[k] || new Set(); mine[k].add(r.reaction); }
  });
  return { counts, mine };
}

// Forum home: categories with thread counts
router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim().slice(0, 80);
    const filterCat = (req.query.cat || '').trim();
    const filterTag = (req.query.tag || '').trim().toLowerCase().slice(0, 24);
    const [{ data: cats }, { data: threads }, sidebar] = await Promise.all([
      db(req).from('forum_categories').select('*').order('position'),
      db(req).from('forum_threads').select('id, category_id, title, created_at, user_id').order('created_at', { ascending: false }).limit(200),
      loadForumSidebar(req)
    ]);
    const counts = {}, latest = {};
    (threads || []).forEach(t => {
      counts[t.category_id] = (counts[t.category_id] || 0) + 1;
      if (!latest[t.category_id]) latest[t.category_id] = t;
    });
    // search results
    let results = null;
    if (q || filterTag) {
      let qy = db(req).from('forum_threads').select('id, category_id, title, body, tags, created_at, reply_count').order('created_at', { ascending: false }).limit(50);
      if (q) {
        const safe = q.replace(/[%_,()]/g, ' ').trim();
        if (safe) qy = qy.or('title.ilike.%' + safe + '%,body.ilike.%' + safe + '%');
      }
      if (filterTag) qy = qy.contains('tags', [filterTag]);
      if (filterCat) {
        const c = (cats || []).find(x => x.slug === filterCat);
        if (c) qy = qy.eq('category_id', c.id);
      }
      const { data } = await qy;
      results = data || [];
    }
    res.render('community/forum', { title: 'Community', cats: cats || [], counts, latest, sidebar, q, filterCat, filterTag, results });
  } catch (e) { next(e); }
});

router.get('/c/:slug', async (req, res, next) => {
  try {
    const { data: cat } = await db(req).from('forum_categories').select('*').eq('slug', req.params.slug).maybeSingle();
    if (!cat) return res.redirect('/community');
    const { data: threads } = await db(req).from('forum_threads').select('*')
      .eq('category_id', cat.id).order('is_pinned', { ascending: false }).order('last_reply_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(100);
    const userIds = [...new Set((threads || []).map(t => t.user_id))];
    const { data: profiles } = userIds.length ? await db(req).from('profiles').select('id, display_name, username').in('id', userIds) : { data: [] };
    const pmap = {}; (profiles || []).forEach(p => pmap[p.id] = p);
    res.render('community/category', { title: cat.name, cat, threads: threads || [], pmap });
  } catch (e) { next(e); }
});

router.post('/c/:slug/thread', requireAuth, async (req, res, next) => {
  try {
    const { data: cat } = await req.sb.from('forum_categories').select('id, slug, is_locked').eq('slug', req.params.slug).maybeSingle();
    if (!cat || cat.is_locked) return res.redirect('/community');
    const title = (req.body.title || '').trim();
    const rawHtml = (req.body.body_html || '').trim();
    let body = (req.body.body || '').trim();
    let bodyHtml = null;
    if (rawHtml) {
      bodyHtml = await addLinkCards(sanitizeForumHtml(rawHtml));
      body = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000) || '(rich post)';
    }
    if (!title || (!body && !bodyHtml)) return res.redirect('/community/c/' + cat.slug);
    const tags = parseTags(req.body.tags);
    const { data: thread, error } = await req.sb.from('forum_threads').insert({
      category_id: cat.id, user_id: req.user.id, title, body, body_html: bodyHtml, tags, last_reply_at: new Date().toISOString()
    }).select().maybeSingle();
    if (error) throw error;
    await awardXP(req.sb, req.user.id, req.profile, 10, 'Started a forum thread', 'forum_threads', thread.id);
    await notifySocial(req.sb, req.user.id, (req.profile.display_name || req.profile.username || 'A founder') + ' posted in the forum: "' + title.slice(0, 60) + '"', 'forum_threads', thread.id);
    res.redirect('/community/t/' + thread.id);
  } catch (e) { next(e); }
});

router.get('/t/:id', async (req, res, next) => {
  try {
    const { data: thread } = await db(req).from('forum_threads').select('*').eq('id', req.params.id).maybeSingle();
    if (!thread) return res.redirect('/community');
    const [{ data: cat }, { data: replies }] = await Promise.all([
      db(req).from('forum_categories').select('name, slug').eq('id', thread.category_id).maybeSingle(),
      db(req).from('forum_replies').select('*').eq('thread_id', thread.id).order('created_at')
    ]);
    let visibleReplies = replies || [];
    if (req.user && req.sb) {
      const { data: blocks } = await req.sb.from('user_blocks').select('blocked_id').eq('blocker_id', req.user.id);
      const blocked = new Set((blocks || []).map(b => b.blocked_id));
      if (blocked.size) visibleReplies = visibleReplies.filter(r => !blocked.has(r.user_id));
    }
    const userIds = [...new Set([thread.user_id, ...visibleReplies.map(r => r.user_id)])];
    const { data: profiles } = req.sb ? await req.sb.from('profiles').select('id, display_name, username, current_level').in('id', userIds) : { data: [] };
    const pmap = {}; (profiles || []).forEach(p => pmap[p.id] = p);
    if (req.sb) req.sb.from('forum_threads').update({ view_count: (thread.view_count || 0) + 1 }).eq('id', thread.id).then(() => {});
    const reactions = await loadReactions(req, thread.id, visibleReplies.map(r => r.id));
    res.render('community/thread', { title: thread.title, thread, cat, replies: visibleReplies, pmap, reactions, REACTIONS });
  } catch (e) { next(e); }
});

router.post('/t/:id/reply', requireAuth, async (req, res, next) => {
  try {
    const { data: thread } = await req.sb.from('forum_threads').select('id, is_locked, reply_count').eq('id', req.params.id).maybeSingle();
    if (!thread || thread.is_locked) return res.redirect('/community');
    const rawHtml = (req.body.body_html || '').trim();
    let body = (req.body.body || '').trim();
    let bodyHtml = null;
    if (rawHtml) {
      bodyHtml = await addLinkCards(sanitizeForumHtml(rawHtml));
      body = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000) || '(rich reply)';
    }
    if (body || bodyHtml) {
      await req.sb.from('forum_replies').insert({ thread_id: thread.id, user_id: req.user.id, body, body_html: bodyHtml });
      await req.sb.from('forum_threads').update({ reply_count: (thread.reply_count || 0) + 1, last_reply_at: new Date().toISOString() }).eq('id', thread.id);
      await awardXP(req.sb, req.user.id, req.profile, 5, 'Replied in the forum', 'forum_replies', null);
      const { data: full } = await req.sb.from('forum_threads').select('user_id, title').eq('id', thread.id).maybeSingle();
      if (full && full.user_id !== req.user.id) {
        await req.sb.rpc('push_notification', { target_user: full.user_id, ntype: 'forum_reply', nmessage: (req.profile.display_name || 'Someone') + ' replied to your thread "' + (full.title || '').slice(0, 60) + '"', nentity_type: 'forum_threads', nentity_id: thread.id }).then(() => {}, () => {});
      }
    }
    res.redirect('/community/t/' + thread.id);
  } catch (e) { next(e); }
});

// ----- Edit / delete threads & replies (own content; RLS enforces too) -----
router.get('/t/:id/edit', requireAuth, async (req, res, next) => {
  try {
    const { data: thread } = await req.sb.from('forum_threads').select('*').eq('id', req.params.id).maybeSingle();
    if (!thread || (thread.user_id !== req.user.id && !req.profile.is_admin)) return res.redirect('/community/t/' + req.params.id);
    const { data: cat } = await req.sb.from('forum_categories').select('name, slug').eq('id', thread.category_id).maybeSingle();
    res.render('community/thread_edit', { title: 'Edit: ' + thread.title, thread, cat });
  } catch (e) { next(e); }
});

router.post('/t/:id/edit', requireAuth, async (req, res, next) => {
  try {
    const { data: thread } = await req.sb.from('forum_threads').select('id, user_id').eq('id', req.params.id).maybeSingle();
    if (!thread || (thread.user_id !== req.user.id && !req.profile.is_admin)) return res.redirect('/community/t/' + req.params.id);
    const title = (req.body.title || '').trim().slice(0, 200);
    const rawHtml = (req.body.body_html || '').trim();
    let body = (req.body.body || '').trim();
    let bodyHtml = null;
    if (rawHtml) {
      bodyHtml = await addLinkCards(sanitizeForumHtml(rawHtml));
      body = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000) || '(rich post)';
    }
    if (title && (body || bodyHtml)) {
      await req.sb.from('forum_threads').update({ title, body, body_html: bodyHtml, tags: parseTags(req.body.tags), edited_at: new Date().toISOString() }).eq('id', thread.id);
    }
    res.redirect('/community/t/' + thread.id);
  } catch (e) { next(e); }
});

router.post('/t/:id/delete', requireAuth, async (req, res, next) => {
  try {
    const { data: thread } = await req.sb.from('forum_threads').select('id, user_id, category_id').eq('id', req.params.id).maybeSingle();
    if (thread && (thread.user_id === req.user.id || req.profile.is_admin)) {
      await req.sb.from('forum_replies').delete().eq('thread_id', thread.id);
      await req.sb.from('forum_threads').delete().eq('id', thread.id);
      const { data: cat } = await req.sb.from('forum_categories').select('slug').eq('id', thread.category_id).maybeSingle();
      return res.redirect(cat ? '/community/c/' + cat.slug : '/community');
    }
    res.redirect('/community');
  } catch (e) { next(e); }
});

router.post('/r/:id/edit', requireAuth, async (req, res, next) => {
  try {
    const { data: reply } = await req.sb.from('forum_replies').select('id, user_id, thread_id').eq('id', req.params.id).maybeSingle();
    if (reply && (reply.user_id === req.user.id || req.profile.is_admin)) {
      const rawHtml = (req.body.body_html || '').trim();
      let body = (req.body.body || '').trim();
      let bodyHtml = null;
      if (rawHtml) {
        bodyHtml = await addLinkCards(sanitizeForumHtml(rawHtml));
        body = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000) || '(rich reply)';
      }
      if (body || bodyHtml) await req.sb.from('forum_replies').update({ body, body_html: bodyHtml, edited_at: new Date().toISOString() }).eq('id', reply.id);
      return res.redirect('/community/t/' + reply.thread_id);
    }
    res.redirect('/community');
  } catch (e) { next(e); }
});

router.post('/r/:id/delete', requireAuth, async (req, res, next) => {
  try {
    const { data: reply } = await req.sb.from('forum_replies').select('id, user_id, thread_id').eq('id', req.params.id).maybeSingle();
    if (reply && (reply.user_id === req.user.id || req.profile.is_admin)) {
      await req.sb.from('forum_replies').delete().eq('id', reply.id);
      const { data: th } = await req.sb.from('forum_threads').select('reply_count').eq('id', reply.thread_id).maybeSingle();
      if (th) await req.sb.from('forum_threads').update({ reply_count: Math.max(0, (th.reply_count || 1) - 1) }).eq('id', reply.thread_id);
      return res.redirect('/community/t/' + reply.thread_id);
    }
    res.redirect('/community');
  } catch (e) { next(e); }
});

// ----- Reactions (toggle) -----
router.post('/react', requireAuth, async (req, res, next) => {
  try {
    const entityType = req.body.entity_type === 'reply' ? 'reply' : 'thread';
    const entityId = req.body.entity_id;
    const reaction = String(req.body.reaction || '');
    const back = req.body.back || '/community';
    if (!entityId || !REACTIONS.some(r => r.key === reaction)) return res.redirect(back);
    const { data: existing } = await req.sb.from('forum_reactions').select('id')
      .eq('user_id', req.user.id).eq('entity_type', entityType).eq('entity_id', entityId).eq('reaction', reaction).maybeSingle();
    if (existing) {
      await req.sb.from('forum_reactions').delete().eq('id', existing.id);
    } else {
      await req.sb.from('forum_reactions').insert({ user_id: req.user.id, entity_type: entityType, entity_id: entityId, reaction });
    }
    res.redirect(back);
  } catch (e) { next(e); }
});

// ----- Collaboration hub -----
router.get('/collab', requireAuth, async (req, res, next) => {
  try {
    const [{ data: collabs }, { data: betas }, { data: myEnrollments }] = await Promise.all([
      req.sb.from('collab_requests').select('*').eq('is_public', true).eq('status', 'open').order('created_at', { ascending: false }).limit(50),
      req.sb.from('beta_programs').select('*').eq('status', 'open').order('created_at', { ascending: false }).limit(50),
      req.sb.from('beta_testers').select('program_id').eq('tester_id', req.user.id)
    ]);
    const enrolled = new Set((myEnrollments || []).map(e => e.program_id));
    const userIds = [...new Set([...(collabs || []).map(c => c.requester_id), ...(betas || []).map(b => b.owner_id)])];
    const { data: profiles } = userIds.length ? await req.sb.from('profiles').select('id, display_name, username').in('id', userIds) : { data: [] };
    const pmap = {}; (profiles || []).forEach(p => pmap[p.id] = p);
    res.render('community/collab', { title: 'Collaborate', collabs: collabs || [], betas: betas || [], enrolled, pmap });
  } catch (e) { next(e); }
});

router.post('/collab', requireAuth, async (req, res, next) => {
  try {
    const b = req.body;
    if ((b.title || '').trim()) {
      await req.sb.from('collab_requests').insert({
        requester_id: req.user.id, recipient_id: null,
        role_type: b.role_type || 'collaborator', title: b.title.trim(), description: b.description || '',
        skills_needed: (b.skills_needed || '').split(',').map(s => s.trim()).filter(Boolean),
        offering: b.offering || '', is_public: true, status: 'open'
      });
    }
    res.redirect('/community/collab');
  } catch (e) { next(e); }
});

router.post('/beta', requireAuth, async (req, res, next) => {
  try {
    const b = req.body;
    if ((b.title || '').trim()) {
      await req.sb.from('beta_programs').insert({
        owner_id: req.user.id, title: b.title.trim(), description: b.description || '',
        what_testing: b.what_testing || '', ideal_tester: b.ideal_tester || '',
        feedback_format: b.feedback_format || 'Written feedback', max_testers: parseInt(b.max_testers, 10) || 10,
        status: 'open'
      });
    }
    res.redirect('/community/collab');
  } catch (e) { next(e); }
});

router.post('/beta/:id/join', requireAuth, async (req, res, next) => {
  try {
    const { data: prog } = await req.sb.from('beta_programs').select('id, tester_count, max_testers, owner_id, status').eq('id', req.params.id).maybeSingle();
    if (prog && prog.status === 'open' && prog.owner_id !== req.user.id && (prog.tester_count || 0) < (prog.max_testers || 10)) {
      const { data: existing } = await req.sb.from('beta_testers').select('id').eq('program_id', prog.id).eq('tester_id', req.user.id).maybeSingle();
      if (!existing) {
        await req.sb.from('beta_testers').insert({ program_id: prog.id, tester_id: req.user.id, status: 'enrolled' });
        await req.sb.from('beta_programs').update({ tester_count: (prog.tester_count || 0) + 1 }).eq('id', prog.id);
        await awardXP(req.sb, req.user.id, req.profile, 15, 'Joined a beta program', 'beta_programs', prog.id);
      }
    }
    res.redirect('/community/collab');
  } catch (e) { next(e); }
});

module.exports = router;
