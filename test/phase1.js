// Phase 1: the public side, like a professional network.
//
//  - Members post updates, questions, resources and results to a feed, and
//    react and comment.
//  - Help & exchange: asks, offers and skill swaps, closed by a thank-you.
//  - Profiles say who you are, what you are working on, and what you can help
//    with; the directory filters by it.
//  - Challenges, public cohorts and the results wall are on; XP and levels
//    stay off.
//
//   node test/phase1.js

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

const { FLAGS } = require('../src/features');

// A tiny stand-in for the Express request/response, enough to drive a route.
function run(router, method, url, { body = {}, query = {}, sb } = {}) {
  return new Promise((resolve) => {
    const req = { method, url, body, query, params: {}, sb, user: { id: 'me' }, profile: { id: 'me', username: 'me', display_name: 'Me', onboarding_completed: true } };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      redirect(to) { resolve({ redirect: to }); },
      render(view, data) { resolve({ view, data }); },
      json(d) { resolve({ json: d }); }
    };
    router.handle(req, res, (e) => resolve({ error: e || 'next' }));
  });
}

// A recorder that answers every query with what `answers` says for the table.
function fakeSb(answers = {}) {
  const writes = [];
  const q = (table) => {
    const state = { table, op: 'select', payload: null };
    const chain = new Proxy({}, {
      get(_, k) {
        if (k === 'then') {
          const a = answers[table];
          const out = typeof a === 'function' ? a(state) : (a || { data: [], error: null });
          return (res, rej) => Promise.resolve(out).then(res, rej);
        }
        if (['insert', 'update', 'delete', 'upsert'].includes(k)) {
          return (p) => { state.op = k; state.payload = p; writes.push({ table, op: k, payload: p }); return chain; };
        }
        return () => chain;
      }
    });
    return chain;
  };
  return { from: q, rpc: (fn, args) => { writes.push({ rpc: fn, args }); return Promise.resolve({ data: null, error: null }); }, writes };
}

(async () => {
  // -------------------------------------------------------------------------
  console.log('\nThe flags match the decisions:');
  ok('challenges, results, collaborators and the help board are on', FLAGS.quests && FLAGS.wins && FLAGS.collabs && FLAGS.helpBoard);
  ok('XP and levels, trophies, sprints and Premium stay off', !FLAGS.ladder && !FLAGS.trophies && !FLAGS.sprints && !FLAGS.premium);

  // -------------------------------------------------------------------------
  console.log('\nThe feed:');
  const feed = require('../src/routes/feed');
  {
    const sb = fakeSb();
    const r = await run(feed, 'POST', '/post', { body: { content: 'Reach me at bob@gmail.com', post_type: 'question' }, sb });
    ok('a post with an email is refused', /err=/.test(r.redirect || '') && !sb.writes.some(w => w.table === 'posts'), r.redirect);
  }
  {
    const sb = fakeSb();
    const r = await run(feed, 'POST', '/post', { body: { content: 'Shipped my first landing page today.', post_type: 'nonsense' }, sb });
    const w = sb.writes.find(x => x.table === 'posts');
    ok('a post is written as the member, with a known type', !!w && w.payload.user_id === 'me' && w.payload.post_type === 'insight', JSON.stringify(w && w.payload));
    ok('...and the member goes back to the feed', r.redirect === '/feed');
  }
  {
    const sb = fakeSb({ posts: { data: { user_id: 'them' }, error: null } });
    const r = await run(feed, 'POST', '/p/11111111-1111-1111-1111-111111111111/comment', { body: { content: 'Call me on 555 123 4567', back: '/feed' }, sb });
    ok('a comment with a phone number is refused', /err=/.test(r.redirect || '') && !sb.writes.some(w => w.table === 'post_comments'));
  }
  {
    const sb = fakeSb({ posts: { data: { user_id: 'them' }, error: null } });
    const r = await run(feed, 'POST', '/p/11111111-1111-1111-1111-111111111111/comment', { body: { content: 'Nice work', back: 'https://evil.example/' }, sb });
    ok('a form cannot send the member to another site afterwards', /^\/feed\/p\//.test(r.redirect || ''), r.redirect);
  }
  {
    const card = read('views/partials/post_card.ejs');
    ok('a post card has like, comment and delete-own', /\/react"/.test(card) && /\/comment"/.test(card) && /p\.mine/.test(card));
  }
  ok('the feed hides people across a block, both ways', /iBlocked\.has\(id\) \|\| b\.blockedMe\.has\(id\)/.test(read('src/posts.js')));

  // -------------------------------------------------------------------------
  console.log('\nHelp & exchange:');
  const exchange = require('../src/routes/exchange');
  {
    const sb = fakeSb({ help_posts: { data: null, error: { code: '42P01', message: 'relation "public.help_posts" does not exist' } } });
    const r = await run(exchange, 'GET', '/', { sb });
    ok('before its migration, the board says it is opening soon instead of failing', r.view === 'exchange/index' && r.data.notReady === true);
  }
  {
    const sb = fakeSb();
    const r = await run(exchange, 'POST', '/', { body: { kind: 'ask', title: 'Website review', body: 'Text me at 555.123.4567 please', category: 'website' }, sb });
    ok('an ask with a phone number is refused', /err=/.test(r.redirect || '') && !sb.writes.some(w => w.table === 'help_posts'));
  }
  {
    const sb = fakeSb({ help_posts: { data: { id: 'p1' }, error: null } });
    const r = await run(exchange, 'POST', '/', { body: { kind: 'offer', title: 'I will review your SEO', body: 'Two pages, written notes, this week.', category: 'nonsense', exchange: 'swap' }, sb });
    const w = sb.writes.find(x => x.table === 'help_posts');
    ok('a post is written with a known category and exchange', !!w && w.payload.category === 'other' && w.payload.exchange === 'swap' && w.payload.kind === 'offer');
    ok('...matching members are looked up to be told', sb.writes.some(x => x.rpc === 'help_matches_for'));
    ok('...and the member lands on their post', r.redirect === '/exchange/p1');
  }
  {
    const src = read('src/routes/exchange.js');
    ok('accepting, closing and thanking go through the database functions',
       /rpc\('help_accept'/.test(src) && /rpc\('help_close'/.test(src) && /rpc\('help_thank'/.test(src));
    ok('only messages the database raised on purpose are shown to members', /OUR_MESSAGE\.test/.test(src));
  }
  ok('the board is mounted behind its flag at /exchange (/help is the Help Center)',
     /app\.use\('\/exchange', requireAuth, requireFlag\('helpBoard'\)/.test(read('server.js')));

  // -------------------------------------------------------------------------
  console.log('\nThe migration (written for review):');
  {
    const sql = read('migrations/2026-11-01_phase1_public_side.sql');
    ok('it is marked NOT APPLIED', /^-- NOT APPLIED, written for review\./.test(sql));
    ok('it does not redefine contains_personal_info (the Phase 0 one is stronger)', !/create or replace function public\.contains_personal_info/.test(sql));
    ok('it allows the help notification type, or accepting would always fail', /'system','help'\]/.test(sql.replace(/\s+/g, '')));
    ok('members can no longer write their own karma', /drop policy if exists karma_insert on public\.karma_transactions/.test(sql));
    ok('members can no longer edit like or comment counts', /revoke update on public\.posts from anon, authenticated;/.test(sql) && /grant update \(post_type, content, link_url, link_title\) on public\.posts to authenticated;/.test(sql));
    ok('group posts are visible only to that group', /group_id is null or exists \(\s*select 1 from public\.group_members gm where gm\.group_id = help_posts\.group_id and gm\.user_id = auth\.uid\(\)\)/.test(sql));
    const fns = ['help_accept(uuid)', 'help_close(uuid)', 'help_thank(uuid, text, smallint, boolean)', 'help_matches_for(uuid)'];
    ok('every help function is revoked from anon and granted to members',
       fns.every(f => sql.includes(`revoke all on function public.${f}`) && sql.includes(`grant execute on function public.${f}`)));
    ok('it is ordered after the Phase 0 filter it relies on', /REQUIRES 2026-11-01_personal_info_filter\.sql first/.test(sql));
  }

  // -------------------------------------------------------------------------
  console.log('\nProfiles read like a professional network:');
  {
    const V = f => path.join(ROOT, 'views', f);
    const base = {
      title: 'T', user: { id: 'me' }, profile: { id: 'me', username: 'me' }, plan: 'paid', currentPath: '/members/ana', canonicalUrl: 'x',
      unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: '', settings: {}, pendingDeletion: null, reactivated: false,
      isPremium: true, flags: FLAGS, flashErr: null, premiumTools: [],
      affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false }
    };
    const p = { id: 'ana', username: 'ana', display_name: 'Ana', headline: 'Nurse by day, building a meal-prep business',
      working_on: 'Pre-sales for a 4-week plan', bio: 'Night shifts.', help_offer: ['design'], help_need: ['marketing_seo'],
      location: 'Lowell, MA', website_url: 'https://ana.example', created_at: '2026-10-01T00:00:00Z', current_level: 3, xp_total: 400, path: 'online_store' };
    const html = ejs.render(read('views/profile.ejs'), Object.assign({}, base, {
      p, isMe: false, isPrivate: false, lvl: { title: 'Builder', emoji: '🔨' }, mentor: false, mentorLevel: 7,
      social: { followers: 3, following: 2, friends: 0, isFollowing: false, friendship: null, iBlocked: false, blockedMe: false },
      showcase: { url: p.website_url }, canShowcase: true, showcaseLevel: 3, recent: [], badges: [], milestones: [],
      memberPosts: [], thanks: [{ note: 'Fixed my logo in an evening.', who: { username: 'bo', display_name: 'Bo' } }],
      helpCats: require('../src/help_categories'), pathDef: require('../src/paths').get('online_store')
    }), { filename: V('profile.ejs') });
    ok('the headline, what they are working on and their link show', html.includes('Nurse by day') && html.includes('Pre-sales for a 4-week plan') && html.includes('ana.example'));
    ok('what they can help with links to the help board', html.includes('/exchange?kind=ask&amp;category=design') || html.includes('/exchange?kind=ask&category=design'));
    ok('public thank-yous show', html.includes('Fixed my logo in an evening.'));
    const text = html.replace(/<[^>]+>/g, ' ');
    ok('no XP or level is shown', !/\bXP\b|Level \d/.test(text));
    ok('friend requests stay off; follow and message are there', !/Add friend/.test(text) && /Follow/.test(text) && /Message/.test(text));
  }
  {
    const src = read('src/routes/members.js');
    ok('the new profile fields are only written once their columns exist', /\.\.\.\(hasNetworkFields\(req\.profile\) \? \{/.test(src));
    ok('the directory filters by what members can help with', /\(m\.help_offer \|\| \[\]\)\.includes\(help\)/.test(src));
  }

  // -------------------------------------------------------------------------
  console.log('\nOne name per thing:');
  ok('the challenges page is called Challenges', /<\/svg> Challenges<\/h1>/.test(read('views/challenges.ejs')));
  ok('the forum is Q&A, inside Community', /<\/svg> Q&amp;A<\/h1>/.test(read('views/community/forum.ejs')));
  ok('the wins wall is Results', /<h1>🏁 Results<\/h1>/.test(read('views/wins.ejs')));

  console.log(fail ? `\n${fail} failing\n` : '\nAll good\n');
  process.exit(fail ? 1 : 0);
})();
