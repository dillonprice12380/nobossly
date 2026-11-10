// What the home page (views/home.ejs) needs beyond the paths: each path's
// dashboard preview for the "What are you building?" picker, the FAQ, and the
// structured data search engines read (the site, the organisation, the FAQ).

const paths = require('./paths');
const dashboards = require('./path_dashboards');

const SITE = (process.env.SITE_URL || 'https://nobossly.com').replace(/\/$/, '');

const FAQ = [
  { q: 'Is it really free?', a: 'Yes. Every member gets the workspace, the money tools and the community, with no card and no trial that runs out.' },
  { q: 'Do I have to quit my job?', a: 'No. NoBossly is built for people who still have one: a few evenings a week, a commute, a lunch break. Nothing assumes you are full time.' },
  { q: 'Is my data private?', a: 'Your workspace, numbers and money are yours alone. Other members see only your profile, and you choose what is on it. You share a document only when you decide to.' },
  { q: 'Can NoBossly touch my Stripe or Shopify account?', a: 'No. Connections are read-only: NoBossly can read payments to log them, and cannot refund, pay out or change anything. You can disconnect at any time.' },
  { q: 'Does it replace an accelerator or a course?', a: 'No. NoBossly is a workspace and a community, not a program. If you are in an accelerator or a course, your program can run its private cohort here, and you do the work in the same place.' },
  { q: 'What kinds of business is it for?', a: 'Content creators, freelancers, coaches and consultants, local services, shops and cafés, online stores, product makers and app builders. If you are still deciding, there is a path for that too.' }
];

function previews() {
  const out = {};
  paths.MARKETED.forEach(p => { const v = dashboards.previewFor(p.slug); if (v) out[p.slug] = v; });
  return out;
}

function structuredData() {
  return [
    { '@context': 'https://schema.org', '@type': 'Organization', name: 'NoBossly', url: SITE, logo: 'https://pub-95ede4ca0cce4b26aa322170b1a5b9f1.r2.dev/Site%20Images/N_i8pl8n.png' },
    { '@context': 'https://schema.org', '@type': 'WebSite', name: 'NoBossly', url: SITE },
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: FAQ.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) }
  ];
}

module.exports = { FAQ, previews, structuredData, SITE };
