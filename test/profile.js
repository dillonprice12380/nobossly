// Profiles (src/profile.js, src/routes/members.js, views/profile*.ejs): the
// photo, the regrouped editor, the business showcase, community activity and
// what a member chooses to show.
//
//   node test/profile.js        (PROFILE_OUT=dir also writes the pages as HTML)

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
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://proj.supabase.co';
const SB = process.env.SUPABASE_URL;
const prof = require('../src/profile');
const { FLAGS } = require('../src/features');

function fakeSb(answers = {}, rpcs = {}, storage = {}) {
  const writes = [], calls = [], files = [];
  const q = (table) => {
    const state = { table, op: 'select', payload: null, eq: {}, in: {}, single: false };
    const chain = new Proxy({}, {
      get(_, k) {
        if (k === 'then') {
          const a = answers[table];
          let out = typeof a === 'function' ? a(state) : (a || { data: [], error: null, count: 0 });
          if (state.single && out && Array.isArray(out.data)) out = Object.assign({}, out, { data: out.data[0] || null });
          return (res, rej) => Promise.resolve(out).then(res, rej);
        }
        if (k === 'maybeSingle') return () => { state.single = true; return chain; };
        if (['eq', 'in', 'lt', 'gte', 'is', 'neq', 'or'].includes(k)) return (c, v) => { (state[k] = state[k] || {})[c] = v; return chain; };
        if (['insert', 'update', 'delete', 'upsert'].includes(k)) return (p) => { state.op = k; state.payload = p; writes.push({ table, op: k, payload: p, state }); return chain; };
        return () => chain;
      }
    });
    return chain;
  };
  const bucket = name => ({
    upload: async (p, buf, o) => { files.push({ op: 'upload', bucket: name, path: p, type: o.contentType, size: buf.length }); return { error: null }; },
    getPublicUrl: p => ({ data: { publicUrl: SB + '/storage/v1/object/public/' + name + '/' + p } }),
    list: async () => ({ data: storage.list || [] }),
    remove: async paths => { files.push({ op: 'remove', bucket: name, paths }); return { error: null }; }
  });
  return { from: q, writes, calls, files, storage: { from: bucket }, rpc: (n, a) => { calls.push({ name: n, args: a }); const r = rpcs[n]; return Promise.resolve(typeof r === 'function' ? r(a) : (r || { data: null, error: null })); } };
}

(async () => {
  console.log('The pieces:');
  ok('offers: up to six, a title each, a price if given', JSON.stringify(prof.cleanOffers(['Logo', '', 'Brand kit', 'a', 'b', 'c', 'd', 'e'], ['$300', 'x', '', '', '', '', '', ''])) === JSON.stringify([{ title: 'Logo', price: '$300' }, { title: 'Brand kit' }, { title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }]));
  const L = prof.cleanLinks(['instagram', 'nonsense', 'x'], ['instagram.com/ana', 'https://shop.example.com', 'not a url']);
  ok('links: https added, unknown kinds become "Link", bad ones reported', L.links[0].url === 'https://instagram.com/ana' && L.links[1].kind === 'other' && L.bad.join() === 'not a url');
  ok('...and nothing but http(s)', prof.cleanUrl('javascript:alert(1)') === null && prof.cleanUrl('ftp://x.com') === null);
  ok('privacy: anything not ticked is hidden; missing means shown', JSON.stringify(prof.cleanPrivacy({ show: ['links', 'posts'] })) === JSON.stringify({ location: false, business: false, results: false, activity: false, follows: false }) && prof.shows({}, 'location') && !prof.shows({ privacy: { location: false } }, 'location'));
  const c = prof.completeness({ headline: 'x', bio: 'y', help_offer: ['marketing'], website_url: 'https://a.com' });
  ok('completeness counts what helps people find you', c.done === 4 && c.total === 7 && c.missing.map(m => m.key).join() === 'photo,working_on,business');
  ok('photos are judged by their bytes, not their name', prof.imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])).type === 'image/jpeg' && prof.imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')) === null && prof.imageType(Buffer.from('RIFF0000WEBPVP8 ')).ext === 'webp');
  ok('only a photo from our own bucket is ever shown', prof.ownAvatar(SB + '/storage/v1/object/public/avatars/u1/1.jpg') && !prof.ownAvatar('https://tracker.example/pixel.gif') && !prof.ownAvatar(SB + '/storage/v1/object/public/uploads/u1/x.jpg'));
  ok('the website comes first among links, with no repeats', prof.linksOf({ website_url: 'https://ana.example', links: [{ kind: 'instagram', url: 'https://instagram.com/ana' }, { kind: 'other', url: 'https://ana.example/' }] }).map(l => l.kind).join() === 'website,instagram');

  const mr = require('../src/routes/members');
  const run = (method, url, { body = {}, query = {}, sb, profile = {}, file } = {}) => new Promise((resolve) => {
    const req = { method, url, body, query, params: {}, sb, user: { id: 'me' }, headers: {}, get: () => '',
      profile: Object.assign({ id: 'me', username: 'dana', display_name: 'Dana', path: 'freelancer', headline: null, business_name: null }, profile) };
    if (file) req.file = file;
    Object.keys(req.profile).forEach(k => { if (req.profile[k] === undefined) delete req.profile[k]; });
    const res = { statusCode: 200, locals: {}, status(c) { this.statusCode = c; return this; }, redirect(to) { resolve({ redirect: to }); }, render(view, data) { resolve({ view, data }); } };
    mr.handle(req, res, (e) => resolve({ error: e || 'next' }));
  });

  console.log('\nSaving the profile:');
  {
    const sb = fakeSb();
    const r = await run('POST', '/me/edit', { sb, body: {
      display_name: 'Dana', headline: 'Designer by night', working_on: 'A logo pack', bio: 'Hi', business_name: 'Bloom Studio',
      offer_title: ['Logo design', 'Brand kit', ''], offer_price: ['from $300', '', ''], website_url: 'bloom.example',
      link_kind: ['instagram', 'linkedin'], link_url: ['instagram.com/bloom', ''], show: ['links', 'business', 'posts'], visibility: 'public'
    } });
    const w = sb.writes.find(x => x.table === 'profiles');
    ok('the showcase, links and privacy save in one go', !!w && w.payload.business_name === 'Bloom Studio' && w.payload.offers.length === 2 && w.payload.website_url === 'https://bloom.example/' && w.payload.links.length === 1 && w.payload.privacy.location === false && w.payload.privacy.links === undefined && w.payload.profile_is_public === true && r.redirect === '/members/me/edit?saved=1', JSON.stringify(w && w.payload));
    ok('...and the old journey stage is left alone', !('founder_stage' in w.payload));
    const sb2 = fakeSb();
    const r2 = await run('POST', '/me/edit', { sb: sb2, body: { display_name: 'Dana', link_kind: ['x'], link_url: ['not a url'] } });
    ok('a link that does not work saves nothing and says which', !sb2.writes.length && /not%20a%20url/.test(r2.redirect));
    const sb3 = fakeSb();
    await run('POST', '/me/edit', { sb: sb3, body: { display_name: 'Dana', offer_title: ['Call me on 555-123-4567'] } });
    ok('contact details in what you offer are refused', !sb3.writes.some(x => x.table === 'profiles'));
    const sb4 = fakeSb();
    await run('POST', '/me/edit', { sb: sb4, profile: { business_name: undefined, headline: null }, body: { display_name: 'Dana', business_name: 'X' } });
    const w4 = sb4.writes.find(x => x.table === 'profiles');
    ok('before the migration, the new fields are not written', !!w4 && !('business_name' in w4.payload) && !('privacy' in w4.payload));
  }

  console.log('\nThe photo:');
  {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400)]);
    const photo = (file, sb, err) => new Promise(resolve => {
      const req = { sb, user: { id: 'me' }, profile: { id: 'me' }, file };
      mr.savePhoto(req, { redirect: to => resolve(to) }, e => resolve('ERR ' + e), err);
    });
    const sb = fakeSb({}, {}, { list: [{ name: '100.jpg' }, { name: '200.jpg' }] });
    const to = await photo({ buffer: jpeg, originalname: 'me.png' }, sb);
    const up = sb.files.find(f => f.op === 'upload');
    ok('a photo goes to your own folder in the avatars bucket, typed by its bytes', !!up && up.bucket === 'avatars' && /^me\/\d+\.jpg$/.test(up.path) && up.type === 'image/jpeg' && /Photo%20updated/.test(to));
    ok('...the profile points at it, and the old photos are removed', sb.writes.some(w => w.payload.avatar_url === SB + '/storage/v1/object/public/avatars/' + up.path) && sb.files.some(f => f.op === 'remove' && f.paths.join() === 'me/100.jpg,me/200.jpg'));
    const sb2 = fakeSb();
    const to2 = await photo({ buffer: Buffer.from('<svg onload="alert(1)"></svg>'), originalname: 'cat.jpg' }, sb2);
    ok('a file that is not really a photo is refused', !sb2.files.length && /not%20a%20photo/.test(to2));
    const to3 = await photo(null, fakeSb(), { code: 'LIMIT_FILE_SIZE' });
    ok('...and so is one over 2 MB', /over%202%20MB/.test(to3));
    ok('the browser crops and shrinks the photo before sending it', read('views/profile_edit.ejs').includes("c.toBlob(") && read('views/profile_edit.ejs').includes('Math.min(512, side)'));
    const sbR = fakeSb({}, {}, { list: [{ name: '100.jpg' }] });
    const rr = await run('POST', '/me/photo/remove', { sb: sbR });
    ok('removing the photo deletes the file and clears the profile', sbR.files.some(f => f.op === 'remove' && f.paths.join() === 'me/100.jpg') && sbR.writes.some(w => w.payload.avatar_url === null) && /Photo%20removed/.test(rr.redirect));
  }

  console.log('\nThe profile page:');
  const ana = {
    id: 'u2', username: 'ana', display_name: 'Ana', account_status: 'active', profile_is_public: true, path: 'freelancer', created_at: '2026-10-01T00:00:00Z',
    headline: 'Nurse by day, logos by night', working_on: 'A brand kit', bio: 'Hello', location: 'Lowell, MA', website_url: 'https://ana.example',
    avatar_url: SB + '/storage/v1/object/public/avatars/u2/1.jpg', business_name: 'Ana Draws', offers: [{ title: 'Logo', price: '$300' }],
    links: [{ kind: 'instagram', url: 'https://instagram.com/anadraws' }], privacy: { location: false, posts: false }, help_offer: ['design'], help_need: []
  };
  const viewSb = (p) => fakeSb({
    profiles: { data: [p], error: null }, follows: { data: [], count: 3, error: null }, friendships: { data: null, count: 0, error: null }, user_blocks: { data: [], error: null },
    forum_replies: { data: [{ id: 'r1', thread_id: 't1' }, { id: 'r2', thread_id: 't2' }], error: null },
    forum_threads: s => ({ data: s.in && s.in.accepted_reply_id ? [{ id: 't1', title: 'How do you price a logo?', accepted_reply_id: 'r1' }] : [], count: 1, error: null }),
    coworking_sessions: s => ({ data: s.gte ? [{ id: 'cw1', title: 'Tuesday focus hour', starts_at: '2026-11-17T00:00:00Z' }] : [], count: 2, error: null }),
    group_members: { data: [{ group: { name: 'Designers', slug: 'designers', visibility: 'public' } }], error: null },
    help_thanks: { data: [], count: 1, error: null }, wins: { data: [], count: 1, error: null }, activity_events: { data: [], error: null }
  }, { proof_page: { data: { username: 'ana', page: {} }, error: null } });
  const V = f => path.join(ROOT, 'views', f);
  const base = { title: 'T', user: { id: 'me' }, profile: { id: 'me', username: 'dana' }, plan: 'free', currentPath: '/members/ana', canonicalUrl: 'x', unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: 'theme-light', settings: {}, pendingDeletion: null, reactivated: false, isPremium: false, flags: FLAGS, flashErr: null, premiumTools: [], msg: null, affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false } };
  const render = (f, data) => { try { return ejs.render(read('views/' + f), Object.assign({}, base, data), { filename: V(f) }); } catch (e) { return 'ERR ' + e.message; } };
  const out = {};
  const params = r => r;
  {
    const r = await run('GET', '/ana', { sb: viewSb(ana) });
    if (r.error) console.log(r.error);
    out.profile = render('profile.ejs', r.data);
    const h = out.profile;
    ok('it renders with the photo, the links and the business card', r.view === 'profile' && !h.startsWith('ERR') && h.includes('avatars/u2/1.jpg') && h.includes('📸 Instagram') && h.includes('Ana Draws') && h.includes('$300') && h.includes('/proof/ana'), h.startsWith('ERR') ? h.slice(0, 300) : undefined);
    ok('what they hid stays hidden: location and posts', !h.includes('Lowell, MA') && !h.includes('<h3 style="margin:1.2rem 0 .5rem">Posts</h3>'));
    ok('their community activity shows: a helpful answer, replies, co-working, groups', ['1</strong><span class="muted small">answer marked helpful', '2</strong><span class="muted small">replies in Q&amp;A', 'How do you price a logo?', 'Tuesday focus hour', 'Designers'].every(x => h.includes(x)));
    ok('...with a way to ask about what they offer', h.includes('Ask about it'));
  }
  {
    const me = Object.assign({}, ana, { id: 'me', username: 'dana', working_on: null });
    const r = await run('GET', '/dana', { sb: viewSb(me) });
    const h = render('profile.ejs', r.data);
    ok('on your own profile you see everything, plus how complete it is', h.includes('Lowell, MA') && h.includes('View as a member') && h.includes('% done'));
    const r2 = await run('GET', '/dana', { sb: viewSb(me), query: { as: 'member' } });
    out.asMember = render('profile.ejs', r2.data);
    ok('"View as a member" shows it the way others do', !out.asMember.includes('Lowell, MA') && out.asMember.includes('This is how other members see your profile') && !out.asMember.includes('% done'));
  }
  {
    const r = await run('GET', '/ana', { sb: viewSb(Object.assign({}, ana, { privacy: { business: false, activity: false, links: false } })) });
    const h = render('profile.ejs', r.data);
    ok('hiding the business, links and activity hides them all', !h.includes('Ana Draws') && !h.includes('instagram.com') && !h.includes('In the community') && !h.includes('/proof/ana'));
  }
  {
    const r = await run('GET', '/ana', { sb: viewSb(Object.assign({}, ana, { avatar_url: 'https://tracker.example/pixel.gif' })) });
    ok('a photo address from anywhere else is never shown', !render('profile.ejs', r.data).includes('tracker.example'));
  }
  {
    const r = await run('GET', '/me/edit', { profile: Object.assign({}, ana, { id: 'me', username: 'dana' }) });
    out.edit = render('profile_edit.ejs', r.data);
    const h = out.edit;
    ok('the editor is grouped: photo, about you, business, help, privacy', !h.startsWith('ERR') && ['>Photo<', '>About you<', '>Your business<', '>Help<', '>Privacy<'].every(x => h.includes(x)) && h.indexOf('>Photo<') < h.indexOf('>Privacy<'), h.startsWith('ERR') ? h.slice(0, 300) : undefined);
    ok('...shows how complete it is, and keeps what you saved', h.includes('% done') && h.includes('value="Ana Draws"') && h.includes('value="https://instagram.com/anadraws"') && !/name="show" value="location" checked/.test(h) && /name="show" value="links" checked/.test(h));
    ok('...and no longer asks for a journey stage', !h.includes('Journey stage'));
  }

  if (process.env.PROFILE_OUT) {
    const css = x => x.replace(/href="\/css\/style\.css\?v=\d+"/, 'href="' + path.join(ROOT, 'public/css/style.css') + '"');
    for (const [k, v] of Object.entries(out)) fs.writeFileSync(path.join(process.env.PROFILE_OUT, k + '.html'), css(v));
  }
  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
