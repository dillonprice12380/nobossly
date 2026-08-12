const router = require('express').Router();
const { anonClient } = require('../supabase');
const { awardXP } = require('../xp');

const enc = encodeURIComponent;
const CATS = {
  first_dollar: '💵 First dollar',
  first_customer: '🤝 First customer',
  launched: '🚀 Launched',
  quit_job: '🕊️ Quit my job',
  other: '🌱 Progress win'
};

// Public wins wall. Approved wins are visible to everyone (including logged-out
// visitors — this page is an acquisition asset); members also see their own
// submissions with status, and admins see the pending review queue inline.
router.get('/', async (req, res, next) => {
  try {
    const sb = req.sb || anonClient();
    const cat = CATS[req.query.cat] ? req.query.cat : null;
    let q = sb.from('wins').select('*, profiles(username, display_name, avatar_url)')
      .eq('approved', true).order('approved_at', { ascending: false }).limit(100);
    if (cat) q = q.eq('category', cat);
    const { data: wins } = await q;
    let mine = [];
    if (req.user) {
      const { data } = await req.sb.from('wins').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
      mine = data || [];
    }
    let pending = [];
    if (req.profile && req.profile.is_admin) {
      const { data } = await req.sb.from('wins').select('*, profiles(username, display_name)')
        .eq('approved', false).is('rejected_at', null).order('created_at', { ascending: true });
      pending = data || [];
    }
    res.render('wins', {
      title: 'Member wins', wins: wins || [], mine, pending, cats: CATS, cat,
      isAdmin: !!(req.profile && req.profile.is_admin), msg: req.query.msg || null,
      bodyTheme: req.user ? undefined : 'theme-dark',
      metaDescription: 'Real wins from real NoBossly members — first dollars, first customers, launches, and resignation letters. Modest, honest, and growing.'
    });
  } catch (e) { next(e); }
});

router.get('/new', (req, res) => {
  if (!req.user) return res.redirect('/login');
  res.render('win_new', { title: 'Share a win', cats: CATS, msg: req.query.msg || null });
});

router.post('/', async (req, res, next) => {
  try {
    if (!req.user) return res.redirect('/login');
    const title = String(req.body.title || '').trim().slice(0, 120);
    const story = String(req.body.story || '').trim().slice(0, 1000);
    const category = CATS[req.body.category] ? req.body.category : 'other';
    let amount = parseInt(req.body.amount_usd, 10);
    if (!Number.isFinite(amount) || amount <= 0) amount = null;
    if (amount) amount = Math.min(amount, 10000000);
    if (!title || !story) return res.redirect('/wins/new?msg=' + enc('Please add both a title and a short story.'));
    await req.sb.from('wins').insert({ user_id: req.user.id, title, story, category, amount_usd: amount });
    res.redirect('/wins?msg=' + enc('Win submitted 🎉 It will appear on the wall once approved.'));
  } catch (e) { next(e); }
});

// ---------- Admin review ----------
router.post('/:id/approve', async (req, res, next) => {
  try {
    if (!req.profile || !req.profile.is_admin) return res.redirect('/wins');
    const { data: win } = await req.sb.from('wins').select('*').eq('id', req.params.id).maybeSingle();
    if (win) {
      await req.sb.from('wins').update({ approved: true, approved_at: new Date().toISOString(), rejected_at: null }).eq('id', win.id);
      // Award XP to the winner + notify. Non-fatal if RLS blocks cross-user writes.
      try {
        const { data: wp } = await req.sb.from('profiles').select('*').eq('id', win.user_id).maybeSingle();
        if (wp) await awardXP(req.sb, win.user_id, wp, 25, 'Win featured on the wall: ' + win.title, 'wins', win.id);
      } catch (e2) { console.error('win xp', e2.message); }
      await req.sb.rpc('push_notification', { target_user: win.user_id, ntype: 'wins', nmessage: 'Your win “' + win.title + '” is now live on the Wins wall 🎉', nentity_type: null, nentity_id: null }).then(() => {}, () => {});
    }
    res.redirect('/wins');
  } catch (e) { next(e); }
});

router.post('/:id/reject', async (req, res, next) => {
  try {
    if (!req.profile || !req.profile.is_admin) return res.redirect('/wins');
    await req.sb.from('wins').update({ rejected_at: new Date().toISOString() }).eq('id', req.params.id);
    res.redirect('/wins');
  } catch (e) { next(e); }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    if (!req.user) return res.redirect('/login');
    await req.sb.from('wins').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    res.redirect('/wins');
  } catch (e) { next(e); }
});

module.exports = router;
