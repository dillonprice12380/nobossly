// 🧭 Still figuring it out (docs/path-dashboards.md). The goal is to leave this
// path: know yourself, compare a few options, run small tests, pick one. The
// number that matters is experiments finished, so the north star is the
// experiments board rather than a logged metric.
const { registry } = require('../engines');
const { defineWorksheet } = require('../workspace/worksheets');

registry.defineBoard({
  key: 'ex_experiments', label: 'Two-week experiments', emoji: '🧪', itemLabel: 'experiment',
  help: 'Small, cheap tests of an option: "post five times", "sell to three friends", "price one quote". Finish each one with keep or drop.',
  stages: [
    { key: 'planned', label: 'Planned' },
    { key: 'running', label: 'Running' },
    { key: 'keep', label: 'Keep going', done: true },
    { key: 'drop', label: 'Dropped', done: true }
  ],
  dueLabel: 'Ends on',
  fields: [
    { key: 'option', label: 'Which option it tests', type: 'text' },
    { key: 'hypothesis', label: 'What you think will happen', type: 'longtext' },
    { key: 'test', label: 'The smallest test', type: 'longtext' },
    { key: 'result', label: 'What actually happened', type: 'longtext' }
  ]
});

defineWorksheet('ex_inventory', {
  label: 'Self-inventory', emoji: '🪞', layout: 'form',
  blurb: 'What you are good at, what gives you energy, and what you can put in. The raw material for choosing a path.',
  titleLabel: 'Name', titlePlaceholder: 'e.g. Autumn 2026',
  sections: [
    { key: 'skills', label: 'Skills people already ask you for', type: 'list' },
    { key: 'energy', label: 'Work that gives you energy', type: 'list' },
    { key: 'drain', label: 'Work that drains you', type: 'list' },
    { key: 'problems', label: 'Problems you keep noticing', type: 'list' },
    { key: 'people', label: 'People you can already reach', type: 'list', help: 'A group, a workplace, a community, an audience.' },
    { key: 'hours', label: 'Hours a week you can give it', type: 'number' },
    { key: 'money', label: 'Money you can put in to start', type: 'money' },
    { key: 'deal_breakers', label: 'Deal-breakers', type: 'list', help: 'e.g. no selling face to face, nothing that needs a shop.' },
    { key: 'win', label: 'What a win looks like in a year', type: 'longtext' }
  ]
});

defineWorksheet('ex_options', {
  label: 'Options matrix', emoji: '⚖️', layout: 'matrix',
  blurb: 'Score two to five ideas or paths against what matters to you, weighted. The top one is your next experiment.',
  titleLabel: 'What you are deciding', titlePlaceholder: 'e.g. Which side business to start',
  optionsLabel: 'Ideas or paths', optionsHelp: 'Two to five things you are choosing between.',
  defaultCriteria: ['Uses my skills', 'Gives me energy', 'Fits my hours', 'People will pay for it', 'Low cost to start', 'I can reach the customers']
});

registry.defineChecklist({
  key: 'ex_choose', label: 'Choosing a path',
  help: 'Six steps from "no idea" to "this one". Most people take three to six weeks.',
  items: [
    { key: 'inventory', label: 'Fill in your self-inventory', link: '/workspace/docs/ex_inventory' },
    { key: 'options', label: 'Write down three options, even rough ones', link: '/workspace/docs/ex_options' },
    { key: 'score', label: 'Score them against what matters to you', link: '/workspace/docs/ex_options' },
    { key: 'talk', label: 'Talk to five people who do or buy one of them', link: '/tools/interviews' },
    { key: 'experiment', label: 'Run one two-week experiment on the top option', link: '/workspace/boards/ex_experiments' },
    { key: 'commit', label: 'Pick a path and switch your dashboard to it', link: '/choose-path' }
  ]
});

module.exports = {
  slug: 'exploring',
  intro: 'Find the business that fits you — then leave this path for it.',
  stages: [
    { answer: 'Just curious' },
    { answer: 'Serious, but no idea yet' },
    { answer: 'Weighing up a few options' },
    { answer: 'Ready to commit once I pick' }
  ],
  northStar: () => null,
  northStarBoard: 'ex_experiments',
  supporting: () => [],
  boards: () => ['ex_experiments'],
  checklists: () => ['ex_choose'],
  worksheets: ['ex_inventory', 'ex_options']
};
