// The social feed: members post updates, questions, resources and results;
// others react and comment. Shared results (wins on the wall, challenges
// completed) sit in the same timeline. See src/posts.js.
//
// Free, and stays free: the community is the product.
const router = require('express').Router();
const posts = require('../posts');
const paths = require('../paths');
const pi = require('../personal_info_filter');
const { fetchOg, firstUrl } = require('../notify');
const { quiet } = require('../db');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

const back = (req, fallback) => {
  const to = String(req.body.back || '');
  // Only back to the feed, a post, or a profile — never an arbitrary URL.
  return /^\/(feed(\/p\/[0-9a-f-]{36})?|members\/[a-z0-9_]{3,24})$/i.test(to) ? to : fallback;
};
const notify = (req, target, ntype, message, postId) => {
  if (!target || target === req.user.id) return Promise.resolve();
  return req.sb.rpc('push_notification', {
    target_user: target, ntype, nmessage: message, nentity_type: 'posts', nentity_id: postId
  }).then(...quiet('push_notification:' + ntype));
};
const nameOf = req => req.profile.display_name || req.profile.username || 'Someone';

router.get('/', async (req, res, next) => {
  try {
    const scope = req.query.scope === 'following' ? 'following' : 'everyone';
    const { items, following } = await posts.timeline(req.sb, req.user.id, { scope, limit: 50 });

    // Someone new to the feed is shown people to follow.
    let suggestions = [];
    if (!following) {
      const { data } = await req.sb.from('profiles')
        .select('id, username, display_name, avatar_url, path')
        .eq('account_status', 'active').eq('profile_is_public', true).neq('id', req.user.id)
        .order('last_active_at', { ascending: false, nullsFirst: false }).limit(6);
      suggestions = data || [];
    }

    res.render('feed', {
      title: 'Feed', items, following, suggestions, scope,
      types: posts.TYPES, maxPost: posts.MAX_POST, maxComment: posts.MAX_COMMENT,
      msg: req.query.msg || null,
      pathLabel: slug => { const p = paths.get(slug); return p ? p.label : ''; }
    });
  } catch (e) { next(e); }
});

router.get('/p/:id', async (req, res, next) => {
  try {
    const post = await posts.one(req.sb, req.user.id, req.params.id);
    if (!post) return res.status(404).render('error', { title: 'Not found', message: 'That post is gone, or you cannot see it.' });
    res.render('post', { title: post.type.label + ' from ' + (post.who.display_name || post.who.username), post, maxComment: posts.MAX_COMMENT });
  } catch (e) { next(e); }
});

router.post('/post', async (req, res, next) => {
  try {
    const content = String(req.body.content || '').trim().slice(0, posts.MAX_POST);
    const type = posts.TYPES[req.body.post_type] ? req.body.post_type : 'insight';
    if (content.length < 2) return res.redirect('/feed?msg=' + encodeURIComponent('Write something first.'));
    const found = pi.check(content);
    if (found) return pi.refuse(req, res, '/feed', found, 'post');

    // A link in the post gets a title card, the way messages do.
    let link = {};
    const url = firstUrl(content);
    if (url) {
      const og = await fetchOg(url);
      link = og ? { link_url: og.url, link_title: (og.title || '').slice(0, 200) || null } : { link_url: url };
    }
    const { error } = await req.sb.from('posts').insert({ user_id: req.user.id, post_type: type, content, ...link });
    if (error) return res.redirect('/feed?msg=' + encodeURIComponent('Could not post that. Please try again.'));
    res.redirect('/feed');
  } catch (e) { next(e); }
});

router.post('/p/:id/delete', async (req, res, next) => {
  try {
    // Row policy: your own post, or an admin.
    await req.sb.from('posts').delete().eq('id', req.params.id).then(...quiet('posts.delete'));
    res.redirect(back(req, '/feed'));
  } catch (e) { next(e); }
});

// One reaction per member per post; posting again takes it back.
router.post('/p/:id/react', async (req, res, next) => {
  try {
    const id = req.params.id;
    const { data: had } = await req.sb.from('post_reactions').select('id').eq('post_id', id).eq('user_id', req.user.id).maybeSingle();
    if (had) {
      await req.sb.from('post_reactions').delete().eq('id', had.id).then(...quiet('post_reactions.delete'));
    } else {
      const { data: post } = await req.sb.from('posts').select('user_id').eq('id', id).maybeSingle();
      if (post) {
        await req.sb.from('post_reactions').insert({ post_id: id, user_id: req.user.id }).then(...quiet('post_reactions.insert'));
        notify(req, post.user_id, 'like', nameOf(req) + ' liked your post', id);
      }
    }
    res.redirect(back(req, '/feed') + '#p-' + id);
  } catch (e) { next(e); }
});

router.post('/p/:id/comment', async (req, res, next) => {
  try {
    const id = req.params.id;
    const to = back(req, '/feed/p/' + id);
    const content = String(req.body.content || '').trim().slice(0, posts.MAX_COMMENT);
    if (!content) return res.redirect(to);
    const found = pi.check(content);
    if (found) return pi.refuse(req, res, to, found, 'post_comment');
    const { data: post } = await req.sb.from('posts').select('user_id').eq('id', id).maybeSingle();
    if (!post) return res.redirect('/feed');
    // Neither side of a block can comment on the other's post.
    const b = await posts.blockSets(req.sb, req.user.id);
    if (b.iBlocked.has(post.user_id) || b.blockedMe.has(post.user_id)) return res.redirect('/feed');
    await req.sb.from('post_comments').insert({ post_id: id, user_id: req.user.id, content }).then(...quiet('post_comments.insert'));
    notify(req, post.user_id, 'comment', nameOf(req) + ' commented on your post', id);
    res.redirect(to + '#p-' + id);
  } catch (e) { next(e); }
});

router.post('/c/:id/delete', async (req, res, next) => {
  try {
    await req.sb.from('post_comments').delete().eq('id', req.params.id).then(...quiet('post_comments.delete'));
    res.redirect(back(req, '/feed'));
  } catch (e) { next(e); }
});

module.exports = router;
