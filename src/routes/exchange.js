// Help & exchange: members post an ASK ("review my landing page") or an OFFER
// ("I'll audit your SEO"), for free or as a swap. Others respond; the author
// accepts one; the two work it out in messages; whoever received the help
// says thanks, which closes the post and gives the helper a little karma.
//
// The rules live in the database (migrations/2026-11-01_phase1_public_side.sql):
// guards on every insert, and help_accept / help_close / help_thank for every
// change of state. This file only asks for them.
const router = require('express').Router();
const cats = require('../help_categories');
const pi = require('../personal_info_filter');
const { quiet } = require('../db');

const KINDS = { ask: 'Ask', offer: 'Offer' };
const EXCHANGES = { free: 'Free', swap: 'Swap' };
const enc = encodeURIComponent;

// Messages we raise ourselves are safe to show; anything else is not.
const OUR_MESSAGE = /^(Pick your path|You can only post|You can post up to|Please remove|This post is|You cannot respond|You can send up to|Only the|That response|There is no accepted|Post not found|Response not found|Rating must)/;
const say = err => (err && OUR_MESSAGE.test(err.message || '') ? err.message : 'Something went wrong. Please try again.');

// Until the migration is applied the tables are not there; say so instead of
// failing the page.
const missing = err => !!err && (err.code === '42P01' || /relation .*help_posts.* does not exist|Could not find the table/i.test(err.message || ''));

async function people(sb, ids) {
  if (!ids.length) return {};
  const { data } = await sb.from('profiles').select('id, username, display_name, avatar_url').in('id', [...new Set(ids)]);
  const by = {}; (data || []).forEach(p => { by[p.id] = p; }); return by;
}

router.get('/', async (req, res, next) => {
  try {
    const f = {
      kind: KINDS[req.query.kind] ? req.query.kind : '',
      category: cats.KEYS.includes(req.query.category) ? req.query.category : '',
      exchange: EXCHANGES[req.query.exchange] ? req.query.exchange : '',
      mine: req.query.mine === '1'
    };
    let q = req.sb.from('help_posts').select('id, author_id, kind, title, body, category, exchange, status, created_at')
      .is('group_id', null).order('created_at', { ascending: false }).limit(60);
    if (f.mine) q = q.or(`author_id.eq.${req.user.id},partner_id.eq.${req.user.id}`);
    else q = q.eq('status', 'open');
    if (f.kind) q = q.eq('kind', f.kind);
    if (f.category) q = q.eq('category', f.category);
    if (f.exchange) q = q.eq('exchange', f.exchange);
    const { data, error } = await q;
    if (missing(error)) return res.render('exchange/index', { title: 'Help & exchange', notReady: true, posts: [], who: {}, f, cats, KINDS, EXCHANGES, msg: null });
    const posts = data || [];
    res.render('exchange/index', {
      title: 'Help & exchange', notReady: false, posts, who: await people(req.sb, posts.map(p => p.author_id)),
      f, cats, KINDS, EXCHANGES, msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

router.get('/new', (req, res) => {
  res.render('exchange/new', {
    title: 'Ask or offer help', cats, KINDS, EXCHANGES,
    kind: KINDS[req.query.kind] ? req.query.kind : 'ask', needsPath: !req.profile.onboarding_completed
  });
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body;
    const row = {
      author_id: req.user.id,
      kind: KINDS[b.kind] ? b.kind : 'ask',
      title: String(b.title || '').trim().slice(0, 120),
      body: String(b.body || '').trim().slice(0, 2000),
      category: cats.KEYS.includes(b.category) ? b.category : 'other',
      exchange: EXCHANGES[b.exchange] ? b.exchange : 'free'
    };
    if (row.title.length < 5 || row.body.length < 10) {
      return res.redirect('/exchange/new?kind=' + row.kind + '&err=' + enc('Give it a title (5+ characters) and say a little more about it (10+).'));
    }
    const found = pi.check(row.title, row.body);
    if (found) return pi.refuse(req, res, '/exchange/new?kind=' + row.kind, found, 'help_post');
    const { data: post, error } = await req.sb.from('help_posts').insert(row).select('id').maybeSingle();
    if (error || !post) return res.redirect('/exchange/new?kind=' + row.kind + '&err=' + enc(say(error)));

    // Tell up to five members who said they can help (or are looking for it).
    const { data: matches } = await req.sb.rpc('help_matches_for', { p_post: post.id });
    const who = req.profile.display_name || req.profile.username || 'A member';
    (matches || []).forEach(m => {
      req.sb.rpc('push_notification', {
        target_user: m.member_id, ntype: 'help',
        nmessage: who + (row.kind === 'ask' ? ' is asking for help with ' : ' is offering help with ') + cats.label(row.category).toLowerCase() + ': "' + row.title.slice(0, 60) + '"',
        nentity_type: 'help_posts', nentity_id: post.id
      }).then(...quiet('push_notification:help'));
    });
    res.redirect('/exchange/' + post.id);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { data: post, error } = await req.sb.from('help_posts').select('*').eq('id', req.params.id).maybeSingle();
    if (missing(error)) return res.redirect('/exchange');
    if (!post) return res.status(404).render('error', { title: 'Not found', message: 'That post is gone, or you cannot see it.' });
    const isAuthor = post.author_id === req.user.id;
    const [{ data: responses }, { data: thanks }] = await Promise.all([
      // Row policy: the author sees every response, a responder only their own.
      req.sb.from('help_responses').select('id, responder_id, message, status, created_at').eq('post_id', post.id).order('created_at'),
      req.sb.from('help_thanks').select('helper_id, thanker_id, note, rating, is_public, created_at').eq('post_id', post.id).maybeSingle()
    ]);
    const rs = responses || [];
    const who = await people(req.sb, [post.author_id, post.partner_id].concat(rs.map(r => r.responder_id)).filter(Boolean));
    // Who received the help: the author of an ask, or the partner on an offer.
    const thanker = post.kind === 'ask' ? post.author_id : post.partner_id;
    res.render('exchange/show', {
      title: post.title, post, responses: rs, thanks: thanks || null, who, cats, KINDS, EXCHANGES,
      isAuthor, isPartner: post.partner_id === req.user.id, canThank: post.status === 'in_progress' && thanker === req.user.id,
      myResponse: rs.find(r => r.responder_id === req.user.id) || null, msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

router.post('/:id/respond', async (req, res, next) => {
  try {
    const to = '/exchange/' + req.params.id;
    const message = String(req.body.message || '').trim().slice(0, 600);
    if (!message) return res.redirect(to);
    const found = pi.check(message);
    if (found) return pi.refuse(req, res, to, found, 'help_response');
    const { error } = await req.sb.from('help_responses').insert({ post_id: req.params.id, responder_id: req.user.id, message });
    if (error) return res.redirect(to + '?err=' + enc(/duplicate key/.test(error.message) ? 'You have already responded to this one.' : say(error)));
    const { data: post } = await req.sb.from('help_posts').select('author_id, title').eq('id', req.params.id).maybeSingle();
    if (post) {
      req.sb.rpc('push_notification', {
        target_user: post.author_id, ntype: 'help',
        nmessage: (req.profile.display_name || req.profile.username || 'A member') + ' responded to "' + String(post.title).slice(0, 60) + '"',
        nentity_type: 'help_posts', nentity_id: req.params.id
      }).then(...quiet('push_notification:help'));
    }
    res.redirect(to + '?msg=' + enc('Response sent. You will get a notification if it is accepted.'));
  } catch (e) { next(e); }
});

router.post('/responses/:id/accept', async (req, res, next) => {
  try {
    const { data: postId, error } = await req.sb.rpc('help_accept', { p_response: req.params.id });
    if (error) return res.redirect('/exchange?err=' + enc(say(error)));
    res.redirect('/exchange/' + postId + '?msg=' + enc('Accepted. Message them to get started.'));
  } catch (e) { next(e); }
});

router.post('/responses/:id/withdraw', async (req, res, next) => {
  try {
    const { data: r } = await req.sb.from('help_responses').select('post_id').eq('id', req.params.id).maybeSingle();
    await req.sb.from('help_responses').update({ status: 'withdrawn' }).eq('id', req.params.id).then(...quiet('help_responses.withdraw'));
    res.redirect(r ? '/exchange/' + r.post_id : '/exchange');
  } catch (e) { next(e); }
});

router.post('/:id/close', async (req, res, next) => {
  try {
    const { error } = await req.sb.rpc('help_close', { p_post: req.params.id });
    res.redirect('/exchange/' + req.params.id + (error ? '?err=' + enc(say(error)) : '?msg=' + enc('Closed.')));
  } catch (e) { next(e); }
});

router.post('/:id/thank', async (req, res, next) => {
  try {
    const to = '/exchange/' + req.params.id;
    const note = String(req.body.note || '').trim().slice(0, 500) || null;
    const found = pi.check(note);
    if (found) return pi.refuse(req, res, to, found, 'help_thanks');
    const rating = parseInt(req.body.rating, 10);
    const { error } = await req.sb.rpc('help_thank', {
      p_post: req.params.id, p_note: note,
      p_rating: rating >= 1 && rating <= 5 ? rating : null, p_public: req.body.is_public !== 'off'
    });
    res.redirect(to + (error ? '?err=' + enc(say(error)) : '?msg=' + enc('Thanks sent. This one is closed.')));
  } catch (e) { next(e); }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    // Row policy: the author, while nobody has been accepted.
    await req.sb.from('help_posts').delete().eq('id', req.params.id).then(...quiet('help_posts.delete'));
    res.redirect('/exchange?mine=1');
  } catch (e) { next(e); }
});

module.exports = router;
