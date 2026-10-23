// The first-week checklist on the dashboard. A new member used to land on four
// empty widgets with no obvious first move; this gives them five small ones,
// each of which also puts something into the community for the next person.
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

  const [checkins, intros, follows, sprints, tasks, sprintTasks] = await Promise.all([
    head(sb.from('daily_checkins').select('id', { count: 'exact', head: true }).eq('user_id', user.id)),
    intro ? head(sb.from('forum_threads').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('category_id', intro.id)) : 0,
    head(sb.from('follows').select('follower_id', { count: 'exact', head: true }).eq('follower_id', user.id)),
    head(sb.from('sprints').select('id', { count: 'exact', head: true }).eq('user_id', user.id)),
    head(sb.from('tasks').select('id', { count: 'exact', head: true }).eq('user_id', user.id)),
    head(sb.from('sprint_tasks').select('id', { count: 'exact', head: true }).eq('user_id', user.id))
  ]);

  const steps = [
    { done: checkins > 0, label: 'Do your first daily check-in', href: '/dashboard/checkin', cta: 'Check in' },
    { done: intros > 0, label: 'Introduce yourself to the community', href: '/community/c/introductions', cta: 'Say hello' },
    { done: follows >= 3, label: 'Follow three people on the same climb', href: '/members', cta: 'Find people', note: follows ? follows + ' of 3' : null },
    { done: sprints > 0, label: 'Start your first 7-day sprint', href: '#sprint', cta: 'Start one' },
    { done: tasks + sprintTasks >= 3, label: 'Add three tasks', href: '/tasks', cta: 'Add tasks', note: (tasks + sprintTasks) ? Math.min(3, tasks + sprintTasks) + ' of 3' : null }
  ];
  const done = steps.filter(s => s.done).length;
  if (done === steps.length) return null;
  return { steps, done, total: steps.length };
}

module.exports = { firstWeek };
