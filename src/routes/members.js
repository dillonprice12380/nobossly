const router = require('express').Router();
const pi = require('../personal_info_filter');
const posts = require('../posts');
const helpCats = require('../help_categories');
const { on } = require('../features');
const ladders = require('../ladders');
const { showsBuild, SHOWCASE_LEVEL, isMentor, MENTOR_LEVEL } = require('../unlocks');
const activity = require('../activity');
const paths = require('../paths');
const prof = require('../profile');
const { quiet } = require('../db');
const multer = require('multer');
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: prof.AVATAR_MAX, files: 1, fields: 5 } });

// Helper: backfill any profiles that have no username yet (bare OAuth sign-ups).
// Uses the service role key so it bypasses RLS entirely. Fast no-op once every
// profile has been seeded; only calls auth.admin.listUsers when bare rows exist.
async function backfillBareProfiles() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const { serviceClient } = require('../supabase');
    const sc = serviceClient();
    const { data: bare } = await sc.from('profiles').select('id').is('username', null).limit(20);
    if (!bare || bare.length === 0) return;

    const { data: authData } = await sc.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const authMap = {};
    for (const u of (authData && authData.users) || []) authMap[u.id] = u;

    for (const b of bare) {
      const u = authMap[b.id];
      if (!u) continue;
      const meta = u.user_metadata || {};
      const fullName = meta.full_name || meta.name || meta.display_name || '';
      const emailBase = ((u.email || 'founder').split('@')[0]
        .replace(/[^a-z0-9_]/gi, '').toLowerCase().slice(0, 20)) || 'founder';
      let finalUsername = null;
      for (let attempt = 0; attempt < 3 && !finalUsername; attempt++) {
        const tryName = attempt === 0
          ? emailBase
          : (emailBase.slice(0, 18) + '_' + u.id.slice(0, 3 + attempt));
        const { data: clash } = await sc.from('profiles')
          .select('id').eq('username', tryName).neq('id', u.id).maybeSingle();
        if (!clash) finalUsername = tryName;
      }
      if (!finalUsername) finalUsername = emailBase.slice(0, 12) + '_' + u.id.slice(0, 8);
      await sc.from('profiles').update({
        username: finalUsername,
        display_name: fullName || finalUsername,
        needs_username: true,
        account_status: 'active'
      }).eq('id', u.id).is('username', null);
    }
  } catch (_) { /* non-fatal: service role not configured or transient error */ }
}

// Member directory
router.get('/', async (req, res, next) => {
  try {
    // Auto-fix any bare OAuth profiles before rendering the list so they show up
    // immediately without requiring a manual admin action.
    await backfillBareProfiles();

    // '*' so headline and the help lists come along once they exist. Most
    // recently active first, unless levels are switched on.
    const { data: rows } = await req.sb.from('profiles').select('*')
      .eq('account_status', 'active')
      .not('username', 'is', null)
      .order(on('ladder') ? 'xp_total' : 'last_active_at', { ascending: false, nullsFirst: false })
      .limit(200);
    const help = helpCats.KEYS.includes(req.query.help) ? req.query.help : '';
    // "On my path": other members building the same kind of business.
    const myPath = req.query.path === 'mine' && req.profile.path && req.profile.path !== 'default' ? req.profile.path : null;
    const members = (rows || []).filter(m => (!help || (m.profile_is_public !== false && (m.help_offer || []).includes(help)))
      && (!myPath || (m.path === myPath && m.profile_is_public !== false)));
    // A rung is named differently on every path, so each member's title has to
    // be read from THEIR ladder. One shared lookup would show a plumber a
    // creator's word for the level they reached.
    const withRung = (members || []).map(m => {
      const r = ladders.rungAt(m.path, m.current_level || 1);
      return { ...m, rung: r || { title: 'Dreamer', emoji: '\uD83C\uDF31' }, mentor: isMentor(m) };
    });
    // Mentors first. The Level 7 unlock is "anyone on a lower rung can find
    // you", and 200 members ordered by XP is not findable — it is a wall.
    const mentors = withRung.filter(m => m.mentor);
    const pathDef = req.profile.path && req.profile.path !== 'default' ? paths.get(req.profile.path) : null;
    res.render('members', { title: 'Members', members: withRung, mentors, mentorLevel: MENTOR_LEVEL, help, helpCats,
      myPath, myPathLabel: pathDef ? pathDef.label : null, pathOf: slug => { const p = slug && slug !== 'default' ? paths.get(slug) : null; return p ? p.emoji + ' ' + p.label : ''; } });
  } catch (e) { next(e); }
});

// Edit own profile
// headline, working_on and help_offer / help_need arrive with
// migrations/2026-11-01_phase1_public_side.sql. Until it is applied the form
// leaves them out rather than writing columns that are not there.
const hasNetworkFields = p => !!p && Object.prototype.hasOwnProperty.call(p, 'headline');

// business_name, offers, links and privacy arrive with migrations/2026-11-10_profile_showcase.sql.
const hasShowcase = p => !!p && Object.prototype.hasOwnProperty.call(p, 'business_name');

router.get('/me/edit', (req, res) => {
  const p = req.profile;
  res.render('profile_edit', { title: 'Edit profile', p, saved: req.query.saved, err: req.query.err || null, msg: req.query.msg || null,
    isMentor: isMentor(p), mentorLevel: MENTOR_LEVEL,
    networkFields: hasNetworkFields(p), showcaseFields: hasShowcase(p), helpCats,
    LINK_KINDS: prof.LINK_KINDS, PRIVACY: prof.PRIVACY, shows: k => prof.shows(p, k), complete: prof.completeness(p),
    avatar: prof.ownAvatar(p.avatar_url), maxRows: prof.MAX,
    pathDef: p.path && p.path !== 'default' ? paths.get(p.path) : null });
});

// A profile photo: the browser crops it square and shrinks it first
// (public/js/app.js); the server checks what the file really is, puts it in the
// member's own folder of the avatars bucket and removes the old one.
router.post('/me/photo', (req, res, next) => photoUpload.single('photo')(req, res, err => savePhoto(req, res, next, err)));
async function savePhoto(req, res, next, err) {
  const back = m => res.redirect('/members/me/edit?' + (m.ok ? 'msg=' : 'err=') + encodeURIComponent(m.text) + '#photo');
  try {
    if (err) return back({ text: err.code === 'LIMIT_FILE_SIZE' ? 'That photo is over 2 MB. Try a smaller one.' : 'That upload did not work. Try again.' });
    if (!req.file) return back({ text: 'Choose a photo first.' });
    const kind = prof.imageType(req.file.buffer);
    if (!kind) return back({ text: 'That is not a photo NoBossly can use. Use a JPG, PNG, WebP or GIF.' });
    const folder = req.user.id;
    const name = folder + '/' + Date.now() + '.' + kind.ext;
    const store = req.sb.storage.from('avatars');
    const { error } = await store.upload(name, req.file.buffer, { contentType: kind.type, upsert: false, cacheControl: '31536000' });
    if (error) return back({ text: 'That photo did not save. Try again.' });
    const url = store.getPublicUrl(name).data.publicUrl;
    await req.sb.from('profiles').update({ avatar_url: url }).eq('id', req.user.id);
    // Old photos go, so a replaced one is not left public.
    const { data: old } = await store.list(folder, { limit: 50 }).then(r => r, () => ({ data: [] }));
    const stale = (old || []).map(o => folder + '/' + o.name).filter(n => n !== name);
    if (stale.length) await store.remove(stale).then(...quiet('avatars.remove'));
    back({ ok: true, text: 'Photo updated.' });
  } catch (e) { next(e); }
}

router.post('/me/photo/remove', async (req, res, next) => {
  try {
    const store = req.sb.storage.from('avatars');
    const { data: old } = await store.list(req.user.id, { limit: 50 }).then(r => r, () => ({ data: [] }));
    if ((old || []).length) await store.remove(old.map(o => req.user.id + '/' + o.name)).then(...quiet('avatars.remove'));
    await req.sb.from('profiles').update({ avatar_url: null }).eq('id', req.user.id);
    res.redirect('/members/me/edit?msg=' + encodeURIComponent('Photo removed.') + '#photo');
  } catch (e) { next(e); }
});

router.post('/me/edit', async (req, res, next) => {
  try {
    const b = req.body;
    // Public by default: none of the free-text fields may carry contact details.
    // (website_url is a link field, and links are allowed.)
    const offers = prof.cleanOffers(b.offer_title, b.offer_price);
    const found = pi.check(b.display_name, b.bio, b.location, b.occupation, b.headline, b.working_on, b.business_name, ...offers.map(o => o.title + ' ' + (o.price || '')));
    if (found) return pi.refuse(req, res, '/members/me/edit', found, 'profile');
    const links = prof.cleanLinks(b.link_kind, b.link_url);
    const website = String(b.website_url || '').trim() ? prof.cleanUrl(b.website_url) : null;
    if ((String(b.website_url || '').trim() && !website) || links.bad.length) {
      return res.redirect('/members/me/edit?err=' + encodeURIComponent('That link does not look right: ' + (links.bad[0] || b.website_url) + '. Nothing was saved.'));
    }
    await req.sb.from('profiles').update({
      display_name: (b.display_name || '').slice(0, 60) || req.profile.username,
      bio: (b.bio || '').slice(0, 600),
      location: (b.location || '').slice(0, 80),
      website_url: website || '',
      occupation: (b.occupation || '').slice(0, 80),
      ...(b.visibility ? { profile_is_public: b.visibility !== 'private' } : {}),
      ...(hasShowcase(req.profile) ? {
        business_name: String(b.business_name || '').replace(/\s+/g, ' ').trim().slice(0, 80) || null,
        offers: offers.length ? offers : null,
        links: links.links.length ? links.links : null,
        privacy: prof.cleanPrivacy(b)
      } : {}),
      notification_emails_enabled: b.notification_emails_enabled === 'on',
      ...(hasNetworkFields(req.profile) ? {
        headline: String(b.headline || '').trim().slice(0, 120) || null,
        working_on: String(b.working_on || '').trim().slice(0, 200) || null,
        help_offer: helpCats.pick(b.help_offer),
        help_need: helpCats.pick(b.help_need)
      } : {}),
      // Only writable once the rung is reached; below it the checkbox is not
      // rendered, and a hand-rolled POST must not be able to set the flag that
      // decides whether someone is advertised as available to help.
      ...(isMentor({ ...req.profile, mentor_available: true })
        ? { mentor_available: b.mentor_available === 'on' } : {})
    }).eq('id', req.user.id);
    res.redirect('/members/me/edit?saved=1');
  } catch (e) { next(e); }
});

router.get('/:username', async (req, res, next) => {
  try {
    // '*': headline, working_on and the help lists may not exist yet (see above).
    const { data: p } = await req.sb.from('profiles').select('*')
      .eq('username', req.params.username).maybeSingle();
    if (!p || (p.account_status !== 'active' && p.id !== req.user.id)) return res.status(404).render('error', { title: 'Not found', message: 'Member not found.' });
    const [{ data: ub }, { data: um }, { data: customM }] = await Promise.all([
      req.sb.from('user_badges').select('badge_id, earned_at').eq('user_id', p.id),
      req.sb.from('user_milestones').select('predefined_milestone_id, earned_at').eq('user_id', p.id).eq('pinned', true).order('earned_at', { ascending: false }),
      req.sb.from('user_custom_milestones').select('title, emoji, achieved_at').eq('user_id', p.id).eq('achieved', true).order('achieved_at', { ascending: false })
    ]);
    const badgeIds = (ub || []).map(b => b.badge_id);
    const milestoneIds = (um || []).map(m => m.predefined_milestone_id);
    const [{ data: badges }, { data: preMilestones }] = await Promise.all([
      badgeIds.length ? req.sb.from('badges').select('id, name, emoji, tier, description').in('id', badgeIds) : { data: [] },
      milestoneIds.length ? req.sb.from('predefined_milestones').select('id, title, emoji').in('id', milestoneIds) : { data: [] }
    ]);
    const milestones = [...(preMilestones || []), ...((customM || []).map(c => ({ emoji: c.emoji, title: c.title })))];
    const lvl = ladders.rungAt(p.path, p.current_level || 1) || { title: 'Dreamer', emoji: '\uD83C\uDF31' };
    // "View as a member": your own profile as others see it.
    const asMember = p.id === req.user.id && req.query.as === 'member';
    const isMe = p.id === req.user.id && !asMember;

    // Level 3 — Builder promises "your business name and link now show on your
    // public profile". The link used to show from Level 1, so the rung unlocked
    // nothing. It is withheld until Level 3 now, and the business name comes
    // from their active blueprint.
    // With levels switched off (FLAGS.ladder) the link is simply theirs to show.
    const canShowcase = !on('ladder') || showsBuild(p);
    let showcase = null;
    if (canShowcase) {
      // The business name came from an AI blueprint; that table is being
      // dropped, so the showcase is the member's own link.
      showcase = { businessName: null, url: p.website_url || null };
      if (!showcase.businessName && !showcase.url) showcase = null;
    }
    const isPrivate = p.profile_is_public === false && !isMe;
    // What this member chose to show others. They always see all of it.
    const show = k => isMe || prof.shows(p, k);
    const [{ data: followRows }, { count: followerCount }, { count: followingCount }, { data: friendship }, { data: blockRow }, { data: blockedMeRow }, { count: friendCount }] = await Promise.all([
      req.sb.from('follows').select('follower_id').eq('follower_id', req.user.id).eq('following_id', p.id),
      req.sb.from('follows').select('follower_id', { count: 'exact', head: true }).eq('following_id', p.id),
      req.sb.from('follows').select('following_id', { count: 'exact', head: true }).eq('follower_id', p.id),
      req.sb.from('friendships').select('*').or(`and(requester_id.eq.${req.user.id},addressee_id.eq.${p.id}),and(requester_id.eq.${p.id},addressee_id.eq.${req.user.id})`).maybeSingle(),
      req.sb.from('user_blocks').select('blocked_id').eq('blocker_id', req.user.id).eq('blocked_id', p.id),
      req.sb.from('user_blocks').select('blocker_id').eq('blocker_id', p.id).eq('blocked_id', req.user.id),
      req.sb.from('friendships').select('id', { count: 'exact', head: true }).eq('status', 'accepted').or(`requester_id.eq.${p.id},addressee_id.eq.${p.id}`)
    ]);
    const social = {
      isFollowing: !!(followRows && followRows.length),
      followers: followerCount || 0,
      following: followingCount || 0,
      friends: friendCount || 0,
      friendship: friendship || null,
      iBlocked: !!(blockRow && blockRow.length),
      blockedMe: !!(blockedMeRow && blockedMeRow.length)
    };
    // What they have actually done lately. This is the payoff for following
    // someone: a Follow button is only worth pressing if there is something on
    // the other side of it. RLS decides what is readable, so a private profile
    // simply returns nothing here rather than needing a second rule.
    const recent = await activity.forUser(req.sb, p.id, 8);
    const memberPosts = isPrivate || !show('posts') ? [] : await posts.byMember(req.sb, req.user.id, p.id, 10);
    const community = isPrivate || !show('activity') ? null : await prof.activityOf(req.sb, p.id).catch(() => null);
    // Their Proof Page, if they have published one.
    const proof = isPrivate || !show('business') ? null : await req.sb.rpc('proof_page', { p_username: p.username }).then(r => (r.data ? '/proof/' + p.username : null), () => null);
    // Public thank-yous from the help board. The table arrives with the same
    // migration; until then there are simply none.
    const { data: thanksRows } = await req.sb.from('help_thanks')
      .select('note, rating, created_at, thanker_id').eq('helper_id', p.id).eq('is_public', true)
      .order('created_at', { ascending: false }).limit(5).then(r => r, () => ({ data: [] }));
    const thankers = {};
    if ((thanksRows || []).length) {
      const { data: tp } = await req.sb.from('profiles').select('id, username, display_name').in('id', thanksRows.map(t => t.thanker_id));
      (tp || []).forEach(x => { thankers[x.id] = x; });
    }
    const thanks = (thanksRows || []).map(t => ({ ...t, who: thankers[t.thanker_id] || null }));
    res.render('profile', {
      memberPosts, thanks, helpCats, community, show, asMember, links: show('links') ? prof.linksOf(p) : [],
      proof, avatar: prof.ownAvatar(p.avatar_url), complete: isMe ? prof.completeness(p) : null,
      business: show('business') && (p.business_name || (p.offers || []).length) ? { name: p.business_name || null, offers: p.offers || [] } : null, pathDef: p.path ? require('../paths').get(p.path) : null, title: isPrivate ? p.username : (p.display_name || p.username), p, badges: badges || [], milestones: milestones || [], lvl, isMe, isPrivate, social, showcase, canShowcase, showcaseLevel: SHOWCASE_LEVEL, recent, mentor: isMentor(p), mentorLevel: MENTOR_LEVEL });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.savePhoto = savePhoto;
