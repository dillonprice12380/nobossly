// The Compass page renders whatever the model returned.
//
// Everything on it comes out of a language model as JSON, so a field's MEANING
// is fixed by the prompt but its TYPE is not. The page went down on exactly
// that: compass_ai.js asks for honest_notes as "2-3 full sentences of straight
// talk", the model correctly returned a string, and the view called .forEach on
// it. `(x || [])` is no defence — a non-empty string is truthy AND has a
// .length, so the guard passed and the loop threw:
//
//     TypeError: lo.honest_notes.forEach is not a function
//     at views/compass.ejs:52
//
// The whole Compass was a 500 for anyone whose loadout came back that way. It
// was found only because the error handler started writing to app_errors — up
// to then it was "Oops. Something went wrong."
//
// So: the view must survive every shape the model can plausibly return for a
// field, and must not silently drop content when it guesses wrong. Prose where
// a list was expected is still the member's Compass.
//
//   node test/compass-view.js

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'views/compass.ejs'), 'utf8');

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

const BASE = {
  currentPath: '/compass', user: { id: 'u' }, settings: {}, notifications: [],
  profile: { username: 'me' }, plan: 'free', unreadCount: 0, unreadMsgs: 0
};

const render = data => ejs.render(SRC, Object.assign({}, BASE, {
  title: 'Your Compass', canDeepen: false, msg: null,
  ideas: [], groups: [], showRunHeadings: false
}, data), { filename: path.join(ROOT, 'views/compass.ejs') });

const compassOf = data => ({ id: 'c', created_at: new Date().toISOString(), data });

// A well-formed Compass, every list a real list.
const GOOD = {
  archetype: { name: 'The Operator', emoji: '🛠', tagline: 't', description: 'd' },
  loadout: {
    strengths: ['Live web app with actual users'],
    advantages: ['Direct access to users'],
    constraints: ['5-10 hours a week'],
    honest_notes: ['One note', 'Another note']
  },
  toolkit: [{ name: 'k', purpose: 'p', cost: '$0' }],
  fit_test: [{ criterion: 'c', why: 'w' }],
  avoid_list: [{ territory: 't', reason: 'r' }],
  territories: [{ name: 'n', why_you: 'w', watch_out: 'o', temperature: 'warm', example_plays: ['p1', 'p2'] }]
};

const clone = o => JSON.parse(JSON.stringify(o));
const tryRender = data => {
  try { return { html: render({ compass: compassOf(data) }) }; }
  catch (e) { return { err: e.message.split('\n').filter(l => /is not a function|undefined|null/.test(l))[0] || e.message.split('\n')[0] }; }
};

// ---------------------------------------------------------------------------
console.log('\nThe shape production actually had:');

// honest_notes as prose. This is what the prompt asks for, and what took the
// page down. It must render, and the prose must survive.
const real = clone(GOOD);
real.loadout.honest_notes = "You have 60-120 total hours before the clock runs out, and you're spending them on a product that doesn't yet have a business model.";
const r = tryRender(real);
ok('a string honest_notes renders instead of throwing', !r.err, r.err || 'ok');
ok('...and the straight talk is still on the page', !!r.html && r.html.includes('Straight talk'));
ok('...with the prose itself, not an empty section',
   !!r.html && r.html.includes('60-120 total hours'), 'a wrong guess must not silently drop content');

// ---------------------------------------------------------------------------
console.log('\nEvery list the model writes, in every shape it might arrive as:');

// The fields the view iterates. A model can return any of these as prose, as
// null, or omit them; none may take the page down.
const LISTS = [
  ['loadout.strengths', d => d.loadout, 'strengths'],
  ['loadout.advantages', d => d.loadout, 'advantages'],
  ['loadout.constraints', d => d.loadout, 'constraints'],
  ['loadout.honest_notes', d => d.loadout, 'honest_notes'],
  ['territories[0].example_plays', d => d.territories[0], 'example_plays'],
  ['territories', d => d, 'territories'],
  ['fit_test', d => d, 'fit_test'],
  ['avoid_list', d => d, 'avoid_list'],
  ['toolkit', d => d, 'toolkit']
];
const SHAPES = [
  ['prose', 'the model wrote sentences'],
  ['null', null],
  ['missing', undefined],
  ['empty array', []],
  ['object', { a: 'one', b: 'two' }],
  ['number', 42]
];

for (const [label, pick, key] of LISTS) {
  const broken = SHAPES.filter(([, value]) => {
    const d = clone(GOOD);
    const target = pick(d);
    if (value === undefined) delete target[key]; else target[key] = value;
    return !!tryRender(d).err;
  }).map(([name]) => name);
  ok(`${label} survives every shape`, broken.length === 0,
     broken.length ? 'throws on: ' + broken.join(', ') : SHAPES.length + ' shapes');
}

// The whole loadout, or the whole data blob, arriving as something else.
for (const [label, data] of [
  ['loadout is a string', Object.assign(clone(GOOD), { loadout: 'all of it as prose' })],
  ['loadout is missing', (() => { const d = clone(GOOD); delete d.loadout; return d; })()],
  ['archetype is missing', (() => { const d = clone(GOOD); delete d.archetype; return d; })()],
  ['data is empty', {}]
]) {
  ok(label + ' still renders', !tryRender(data).err, tryRender(data).err || 'ok');
}

// ---------------------------------------------------------------------------
console.log('\nNothing iterates a model field without normalising it first:');

// `(x || [])` reads like a guard and is not one: a non-empty string passes it
// and then throws. Any that come back are the next outage.
const naive = [...SRC.matchAll(/\(([a-z]+\.[a-z_]+|[a-z_]+) \|\| \[\]\)\s*\.\s*(forEach|map|join)/g)]
  .map(m => m[0]);
ok('no `(x || []).forEach` style guards remain', naive.length === 0,
   naive.join(' ; ') || 'clean');
ok('the view defines the normaliser it uses', /var list = function \(v\)/.test(SRC));
const iterated = [...SRC.matchAll(/<%[^%]*?([a-z]+\.[a-z_]+)\.(forEach|map|join)\(/g)].map(m => m[1]);
ok('no model field is iterated directly', iterated.length === 0,
   iterated.join(', ') || 'all go through list()');

console.log(fail ? `\n${fail} failing` : '\nAll good');
process.exit(fail ? 1 : 0);
