// Auto-award engine for milestone trophies.
//
// Milestones are no longer self-claimed. Every active definition in
// predefined_milestones carries a measurable criterion (auto_kind +
// auto_target); this engine computes the founder's real numbers and awards
// anything newly satisfied. It runs after task completions (dashboard
// toggle), after daily check-ins, and on every /milestones visit — so the
// trophy case is self-healing: whatever the founder did, the next look at
// the page reflects it.
const { awardXP } = require('./xp');
const { notifySocial } = require('./notify');

const n = async q => { const { count } = await q; return count || 0; };

async function computeMetrics(sb, userId, profile, kinds) {
  const m = {};
  const want = k => kinds.has(k);
  const jobs = [];
  if (want('ideas')) jobs.push(n(sb.from('generated_ideas').select('id', { count: 'exact', head: true }).eq('user_id', userId)).then(v => m.ideas = v));
  // Only completed runs count: a half-answered questionnaire has not produced
  // the answers the Compass needs, and this trophy gates leaving Level 1.
  if (want('questionnaire')) jobs.push(n(sb.from('questionnaire_responses').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('completed', true)).then(v => m.questionnaire = v));
  if (want('blueprints')) jobs.push(n(sb.from('blueprints').select('id', { count: 'exact', head: true }).eq('user_id', userId)).then(v => m.blueprints = v));
  // The Level 1 refinement loop. idea_fit is the best score reached on ANY of
  // the founder's ideas, so revising into a worse score never takes back a
  // trophy already earned, and a threshold can only ever be crossed once.
  if (want('idea_fit')) jobs.push(
    sb.from('generated_ideas').select('best_fit_passed').eq('user_id', userId).then(({ data }) =>
      m.idea_fit = (data || []).reduce((best, r) => Math.max(best, r.best_fit_passed || 0), 0), () => { m.idea_fit = 0; })
  );
  if (want('ideas_cut')) jobs.push(n(sb.from('generated_ideas').select('id', { count: 'exact', head: true }).eq('user_id', userId).not('cut_at', 'is', null)).then(v => m.ideas_cut = v));
  // Signals are counted per idea, not summed across them: the quest is three
  // pieces of evidence for ONE idea, and one signal each on three ideas is not
  // the same thing.
  if (want('signals')) jobs.push(
    sb.from('idea_signals').select('idea_id').eq('user_id', userId).then(({ data }) => {
      const per = {};
      (data || []).forEach(r => { per[r.idea_id] = (per[r.idea_id] || 0) + 1; });
      m.signals = Object.keys(per).reduce((best, k) => Math.max(best, per[k]), 0);
    }, () => { m.signals = 0; })
  );
  if (want('tasks')) jobs.push(n(sb.from('sprint_tasks').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'done')).then(v => m.tasks = v));
  if (want('checkins')) jobs.push(n(sb.from('daily_checkins').select('id', { count: 'exact', head: true }).eq('user_id', userId)).then(v => m.checkins = v));
  if (want('followers')) jobs.push(n(sb.from('follows').select('id', { count: 'exact', head: true }).eq('following_id', userId)).then(v => m.followers = v));
  if (want('challenges')) jobs.push(n(sb.from('challenge_completions').select('id', { count: 'exact', head: true }).eq('user_id', userId)).then(v => m.challenges = v));
  if (want('posts')) jobs.push(Promise.all([
    n(sb.from('forum_threads').select('id', { count: 'exact', head: true }).eq('user_id', userId)),
    n(sb.from('forum_replies').select('id', { count: 'exact', head: true }).eq('user_id', userId))
  ]).then(([a, b]) => m.posts = a + b));
  if (want('sprints_started') || want('sprints_done')) jobs.push(
    sb.from('sprints').select('status, tasks_total, tasks_done').eq('user_id', userId).then(({ data }) => {
      const rows = data || [];
      m.sprints_started = rows.length;
      // Nothing flips a sprint to 'completed' automatically yet, so a sprint
      // with every task done counts as done — the honest reading either way.
      m.sprints_done = rows.filter(s => s.status === 'completed' || ((s.tasks_total || 0) > 0 && (s.tasks_done || 0) >= s.tasks_total)).length;
    })
  );
  if (want('streak')) m.streak = Math.max(profile.streak_days || 0, profile.longest_streak || 0);
  if (want('profile')) m.profile = (profile.display_name && profile.bio) ? 1 : 0;
  await Promise.all(jobs);
  return m;
}

// Returns { fresh, metrics }: fresh = definitions awarded during this sweep,
// metrics = current counts per kind (the page uses these for progress bars).
async function sweepMilestones(sb, userId, profile, paid) {
  const [{ data: defs }, { data: mine }] = await Promise.all([
    sb.from('predefined_milestones').select('*').eq('is_active', true).not('auto_kind', 'is', null),
    sb.from('user_milestones').select('predefined_milestone_id').eq('user_id', userId)
  ]);
  const earned = new Set((mine || []).map(r => r.predefined_milestone_id));
  const kinds = new Set((defs || []).map(d => d.auto_kind));
  const metrics = await computeMetrics(sb, userId, profile, kinds);

  const fresh = [];
  for (const def of (defs || [])) {
    if (earned.has(def.id)) continue;
    const have = metrics[def.auto_kind] || 0;
    if (have < (def.auto_target || 1)) continue;
    const { error } = await sb.from('user_milestones').insert({
      user_id: userId, predefined_milestone_id: def.id, emoji: def.emoji,
      date_achieved: new Date().toISOString().slice(0, 10), pinned: paid
    });
    if (error) continue; // e.g. raced with another request — skip quietly
    fresh.push(def);
    await awardXP(sb, userId, profile, def.xp_reward || 50, 'Trophy: ' + def.title, 'predefined_milestones', def.id);
    await sb.rpc('push_notification', {
      target_user: userId, ntype: 'milestone',
      nmessage: '\ud83c\udfc6 Trophy unlocked: ' + (def.emoji || '') + ' ' + def.title + ' (+' + (def.xp_reward || 50) + ' XP)',
      nentity_type: 'predefined_milestones', nentity_id: def.id
    }).then(() => {}, () => {});
    if (paid) {
      const who = profile.display_name || profile.username || 'A founder';
      await notifySocial(sb, userId, who + ' unlocked the trophy ' + (def.emoji || '\ud83c\udfc6') + ' \u201c' + def.title + '\u201d', 'predefined_milestones', def.id).then(() => {}, () => {});
      if (def.badge_id) {
        const { data: hasBadge } = await sb.from('user_badges').select('id').eq('user_id', userId).eq('badge_id', def.badge_id).maybeSingle();
        if (!hasBadge) {
          await sb.from('user_badges').insert({ user_id: userId, badge_id: def.badge_id });
          const { data: b } = await sb.from('badges').select('name, emoji').eq('id', def.badge_id).maybeSingle();
          if (b) await notifySocial(sb, userId, who + ' earned the ' + b.emoji + ' \u201c' + b.name + '\u201d badge', 'badges', def.badge_id).then(() => {}, () => {});
        }
      }
    }
  }
  return { fresh, metrics };
}

module.exports = { sweepMilestones };
