// The Coach: a rule-based guidance engine. Computes a real-time snapshot of
// where the founder is in their journey (Compass, sprint, streak, tasks,
// challenges, rung, recency) and matches it against guidance_rules in the
// database. Deliberately ZERO AI calls — every tip is deterministic, instant,
// and free. Rules live in SQL so the library can grow without a deploy.

const DAY = 86400000;
const dstr = d => new Date(d).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.floor((b - a) / DAY);

// conditions jsonb: bare values = equality; objects support gte/lte/gt/lt/ne/in.
function matches(cond, state) {
  if (!cond) return true;
  try {
    return Object.entries(cond).every(([k, v]) => {
      const s = state[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return Object.entries(v).every(([op, val]) => {
          if (op === 'gte') return typeof s === 'number' && s >= val;
          if (op === 'lte') return typeof s === 'number' && s <= val;
          if (op === 'gt') return typeof s === 'number' && s > val;
          if (op === 'lt') return typeof s === 'number' && s < val;
          if (op === 'ne') return s !== val;
          if (op === 'in') return Array.isArray(val) && val.includes(s);
          return false;
        });
      }
      return s === v;
    });
  } catch (_) { return false; }
}

function fill(msg, state) {
  return String(msg || '')
    .replace(/\{name\}/g, state.name || 'founder')
    .replace(/\{streak\}/g, String(state.streak_days || 0))
    .replace(/\{longest_streak\}/g, String(state.longest_streak || 0))
    .replace(/\{level\}/g, String(state.level || 1))
    .replace(/\{sprint_velocity\}/g, String(state.sprint_velocity || 0))
    .replace(/\{sprint_days_left\}/g, String(state.sprint_days_left != null ? state.sprint_days_left : ''))
    .replace(/\{open_tasks\}/g, String(state.open_tasks || 0))
    .replace(/\{overdue_tasks\}/g, String(state.overdue_tasks || 0))
    .replace(/\{challenge_due_days\}/g, String(state.challenge_due_days != null && state.challenge_due_days < 999 ? state.challenge_due_days : ''));
}

// pre: things the dashboard already fetched, so nothing is queried twice —
// { sprint, acceptances, checkinToday, ideasCount, plan }
async function computeState(sb, user, profile, pre = {}) {
  const now = Date.now();
  const today = dstr(now);
  const head = q => q.then(r => r.count || 0, () => 0);

  const [compassN, blueprintN, ideasN, openN, overdueN, completionsN, winsN, forumN, milestonesN, pendingVerifN, xpToday, qrun] = await Promise.all([
    head(sb.from('founder_compasses').select('id', { count: 'exact', head: true }).eq('user_id', user.id)),
    head(sb.from('blueprints').select('id', { count: 'exact', head: true }).eq('user_id', user.id)),
    pre.ideasCount != null ? Promise.resolve(pre.ideasCount)
      : head(sb.from('generated_ideas').select('id', { count: 'exact', head: true }).eq('user_id', user.id)),
    head(sb.from('tasks').select('id', { count: 'exact', head: true }).eq('user_id', user.id).neq('status', 'done')),
    head(sb.from('tasks').select('id', { count: 'exact', head: true }).eq('user_id', user.id).neq('status', 'done').lt('due_date', today)),
    head(sb.from('challenge_completions').select('id', { count: 'exact', head: true }).eq('user_id', user.id)),
    head(sb.from('wins').select('id', { count: 'exact', head: true }).eq('user_id', user.id)),
    head(sb.from('forum_threads').select('id', { count: 'exact', head: true }).eq('user_id', user.id)),
    head(sb.from('user_milestones').select('id', { count: 'exact', head: true }).eq('user_id', user.id)),
    head(sb.from('verification_requests').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('status', 'pending')),
    sb.from('xp_events').select('reason').eq('user_id', user.id).gte('created_at', today + 'T00:00:00Z').limit(50).then(r => r.data || [], () => []),
    sb.from('questionnaire_responses').select('founder_path').eq('user_id', user.id).eq('completed', true)
      .order('created_at', { ascending: false }).limit(1).maybeSingle().then(r => r.data, () => null)
  ]);

  const reasons = xpToday.map(e => String(e.reason || ''));
  const sprint = pre.sprint || null;
  const acc = Array.isArray(pre.acceptances) ? pre.acceptances : [];
  const dueDays = acc.map(a => a.due_date ? Math.ceil((new Date(a.due_date).getTime() - now) / DAY) : 999);

  const lastCheckin = profile.last_checkin_date ? new Date(profile.last_checkin_date + 'T00:00:00Z').getTime() : null;
  const lastActive = profile.last_active_at ? new Date(profile.last_active_at).getTime() : (profile.created_at ? new Date(profile.created_at).getTime() : now);

  return {
    name: (profile.display_name || profile.username || 'founder').split(' ')[0],
    plan: pre.plan || 'free',
    level: profile.current_level || 1,
    verified_level: profile.verified_level || 1,
    verification_pending: pendingVerifN > 0,
    founder_path: (qrun && qrun.founder_path) || 'exploring',
    // The questionnaire is the Level 1 quest now, so the Coach needs to know
    // whether it is still outstanding — it is the first thing to nudge.
    has_questionnaire: !!qrun,
    has_compass: compassN > 0,
    has_blueprint: blueprintN > 0,
    ideas_count: ideasN,
    has_sprint: !!sprint,
    sprint_velocity: sprint ? (sprint.velocity_pct || 0) : 0,
    sprint_days_left: sprint && sprint.end_date ? Math.max(0, Math.ceil((new Date(sprint.end_date).getTime() - now) / DAY)) : null,
    sprint_ended: !!(sprint && sprint.end_date && sprint.end_date < today),
    open_tasks: openN,
    overdue_tasks: overdueN,
    active_challenges: acc.length,
    challenge_due_days: dueDays.length ? Math.min(...dueDays) : 999,
    challenge_overdue: dueDays.some(d => d < 0),
    completed_challenges: completionsN,
    wins_count: winsN,
    forum_posts: forumN,
    milestones_achieved: milestonesN,
    checkin_today: !!pre.checkinToday,
    streak_days: profile.streak_days || 0,
    longest_streak: profile.longest_streak || 0,
    streak_broken: !!(lastCheckin && daysBetween(lastCheckin, now) >= 2 && (profile.streak_days || 0) > 0),
    days_inactive: daysBetween(lastActive, now),
    days_since_signup: profile.created_at ? daysBetween(new Date(profile.created_at).getTime(), now) : 0,
    task_done_today: reasons.some(r => r.startsWith('Completed task')),
    challenge_accepted_today: reasons.some(r => r.startsWith('Accepted challenge')),
    challenge_completed_today: reasons.some(r => r.startsWith('Completed challenge')),
    idea_drafted_today: reasons.some(r => r.startsWith('Drafted your own idea'))
  };
}

async function pickTips(sb, userId, state, limit = 2) {
  const [rulesR, seenR] = await Promise.all([
    sb.from('guidance_rules').select('*').eq('active', true),
    sb.from('guidance_seen').select('rule_key, seen_at').eq('user_id', userId)
      .gte('seen_at', new Date(Date.now() - 60 * DAY).toISOString())
  ]);
  const rules = rulesR.data || [];
  const lastSeen = {};
  (seenR.data || []).forEach(s => {
    const t = new Date(s.seen_at).getTime();
    if (!lastSeen[s.rule_key] || t > lastSeen[s.rule_key]) lastSeen[s.rule_key] = t;
  });
  const now = Date.now();
  const matched = rules.filter(r => matches(r.conditions, state));
  let eligible = matched.filter(r => {
    const last = lastSeen[r.key];
    return !last || (now - last) >= (r.cooldown_days || 3) * DAY;
  });
  let logSeen = true;
  if (!eligible.length && matched.length) {
    // Every matching rule is inside its cooldown (heavy usage burns through
    // the library fast). The Coach should never go silent: surface the
    // least-recently-shown matches instead, and don't re-log them so the
    // real cooldown clock keeps its original timestamps.
    eligible = matched.slice().sort((a, b) => (lastSeen[a.key] || 0) - (lastSeen[b.key] || 0) || b.priority - a.priority);
    logSeen = false;
  } else {
    eligible.sort((a, b) => (b.priority - a.priority) || (Math.random() - 0.5));
  }
  const picked = eligible.slice(0, limit);
  if (picked.length && logSeen) {
    sb.from('guidance_seen').insert(picked.map(p => ({ user_id: userId, rule_key: p.key })))
      .then(() => {}, () => {});
  }
  return picked.map(p => ({ key: p.key, category: p.category, message: fill(p.message, state), cta_label: p.cta_label, cta_href: p.cta_href }));
}

// One call from a route: never throws, never blocks the page on failure.
async function getGuidance(sb, user, profile, pre) {
  try {
    const state = await computeState(sb, user, profile, pre);
    return await pickTips(sb, user.id, state, 2);
  } catch (e) {
    console.error('guidance', e.message);
    return [];
  }
}

module.exports = { getGuidance, computeState, pickTips, matches };
