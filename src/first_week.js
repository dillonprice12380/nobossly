// The first-week checklist on the dashboard: five small ways into the
// workspace and the community, so a new member does not land on empty widgets.
//
// Counts only, read with the member's own client, and never allowed to break
// the dashboard: any failed read just leaves that step unticked.

const SHOW_FOR_DAYS = 30;

async function firstWeek(sb, user, profile) {
  const created = profile && profile.created_at ? new Date(profile.created_at).getTime() : Date.now();
  if (Date.now() - created > SHOW_FOR_DAYS * 86400000) return null;

  const head = q => q.then(r => r.count || 0, () => 0);
  const { data: intro } = await sb.from('forum_categories').select('id').eq('slug', 'introductions').maybeSingle()
    .then(r => r, () => ({ data: null }));

  const [intros, threads, replies, follows, numbers, cards] = await Promise.all([
    intro ? head(sb.from('forum_threads').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('category_id', intro.id)) : 0,
    head(sb.from('forum_threads').select('id', { count: 'exact', head: true }).eq('user_id', user.id)),
    head(sb.from('forum_replies').select('id', { count: 'exact', head: true }).eq('user_id', user.id)),
    head(sb.from('follows').select('follower_id', { count: 'exact', head: true }).eq('follower_id', user.id)),
    head(sb.from('metric_entries').select('id', { count: 'exact', head: true }).eq('user_id', user.id)),
    head(sb.from('pipeline_items').select('id', { count: 'exact', head: true }).eq('user_id', user.id))
  ]);
  const answers = profile && profile.path_answers && typeof profile.path_answers === 'object' ? profile.path_answers : {};

  // Setting up the workspace and meeting the community. None of these tell a
  // member how to run their business; they just open the parts of NoBossly.
  const steps = [
    { done: Object.keys(answers).length > 0, label: 'Set up your dashboard', href: '/choose-path/setup', cta: 'Set up' },
    { done: numbers + cards > 0, label: 'Log a number or add a card to a board', href: '/workspace', cta: 'Open workspace' },
    { done: intros > 0, label: 'Introduce yourself to the community', href: '/community/c/introductions', cta: 'Say hello' },
    { done: replies > 0 || threads > intros, label: 'Ask or answer a question in Q&A', href: '/community/qa', cta: 'Open Q&A' },
    { done: follows >= 3, label: 'Follow three members', href: '/members', cta: 'Find people', note: follows ? follows + ' of 3' : null }
  ];
  const done = steps.filter(s => s.done).length;
  if (done === steps.length) return null;
  return { steps, done, total: steps.length };
}

module.exports = { firstWeek };
