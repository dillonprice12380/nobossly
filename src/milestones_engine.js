// Auto-award engine for milestone trophies.
//
// Every active definition in predefined_milestones carries a measurable
// criterion (auto_kind + auto_target). The sweep computes the member's real
// numbers and awards anything newly satisfied. It runs after task completions
// (dashboard toggle), after daily check-ins, and on every /trophies visit — so
// the trophy case is self-healing: whatever the member did, the next look at
// the page reflects it.
//
// The counting used to happen here, and the insert with it — under the member's
// own credentials, against a user_milestones INSERT policy that only checked
// `auth.uid() = user_id`. So the row that says you earned a trophy could be
// written without earning it, and level_reached() reads exactly those rows to
// decide your rung. sweep_trophies_for() owns both halves now.
//
// The counting followed the insert deliberately. Leaving computeMetrics() here
// would have meant two implementations of the same fifteen numbers, and a
// trophy case whose progress bars disagree with what it actually awards is the
// drift this codebase keeps finding. The RPC returns the metrics it used, and
// this file renders those rather than counting anything itself.
const { awardXP } = require('./xp');
const { notifySocial } = require('./notify');
const activity = require('./activity');

const { quiet } = require('./db');

// Returns { fresh, metrics }: fresh = definitions awarded during this sweep,
// metrics = current counts per kind (the page uses these for progress bars).
async function sweepMilestones(sb, userId, profile, paid) {
  const { data: res, error } = await sb.rpc('sweep_trophies_for');
  if (error) { console.error('[db] sweep_trophies_for failed:', error.message); return { fresh: [], metrics: {} }; }
  if (!res) return { fresh: [], metrics: {} };

  const metrics = res.metrics || {};
  const ids = res.fresh || [];
  if (!ids.length) return { fresh: [], metrics };

  // Everything below is what was always safe: telling the member, and telling
  // the people following them.
  const { data: defs } = await sb.from('predefined_milestones').select('*').in('id', ids);
  const fresh = defs || [];

  for (const def of fresh) {
    await awardXP(sb, userId, profile, 'trophy', 'Trophy: ' + def.title, 'predefined_milestones', def.id);
    await sb.rpc('push_notification', {
      target_user: userId, ntype: 'milestone',
      nmessage: '🏆 Trophy unlocked: ' + (def.emoji || '') + ' ' + def.title + ' (+' + (def.xp_reward || 50) + ' XP)',
      nentity_type: 'predefined_milestones', nentity_id: def.id
    }).then(...quiet('push_notification:milestone'));
    if (paid) {
      const who = profile.display_name || profile.username || 'A member';
      await notifySocial(sb, userId, who + ' unlocked the trophy ' + (def.emoji || '🏆') + ' “' + def.title + '”', 'predefined_milestones', def.id);
      await activity.record(sb, userId, 'milestone', 'unlocked “' + def.title + '”', { emoji: def.emoji || '🏆', entityType: 'predefined_milestones', entityId: def.id });
      if (def.badge_id) {
        const { data: hasBadge } = await sb.from('user_badges').select('id').eq('user_id', userId).eq('badge_id', def.badge_id).maybeSingle();
        if (!hasBadge) {
          await sb.from('user_badges').insert({ user_id: userId, badge_id: def.badge_id });
          const { data: b } = await sb.from('badges').select('name, emoji').eq('id', def.badge_id).maybeSingle();
          if (b) {
            await notifySocial(sb, userId, who + ' earned the ' + b.emoji + ' “' + b.name + '” badge', 'badges', def.badge_id).then(...quiet('badges.insert'));
            await activity.record(sb, userId, 'badge', 'earned the “' + b.name + '” badge', { emoji: b.emoji, entityType: 'badges', entityId: def.badge_id });
          }
        }
      }
    }
  }
  return { fresh, metrics };
}

module.exports = { sweepMilestones };
