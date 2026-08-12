// XP + streak helpers. All writes use the user's own client (RLS applies).

// Daily activity streak. Any XP-earning action counts as activity for the day
// (awardXP calls this), and manual dashboard check-ins still work too.
// One automatic "streak freeze" per calendar month silently covers a single
// missed day, WIP-style, so one busy Tuesday doesn't erase a 40-day streak.
async function bumpStreak(sb, userId, profile) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const last = profile.last_checkin_date;
    if (last === today) return profile.streak_days || 0;
    const day = 86400000;
    const yesterday = new Date(Date.now() - day).toISOString().slice(0, 10);
    const twoAgo = new Date(Date.now() - 2 * day).toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    const patch = { last_checkin_date: today };
    let streak;
    if (last === yesterday) {
      streak = (profile.streak_days || 0) + 1;
    } else if (last === twoAgo && profile.streak_freeze_used_month !== month) {
      streak = (profile.streak_days || 0) + 1; // freeze covers the one missed day
      patch.streak_freeze_used_month = month;
    } else {
      streak = 1;
    }
    patch.streak_days = streak;
    patch.longest_streak = Math.max(profile.longest_streak || 0, streak);
    await sb.from('profiles').update(patch).eq('id', userId);
    // Keep the in-memory profile current so repeat calls within one request
    // are no-ops and can't double-consume the monthly freeze.
    profile.streak_days = streak;
    profile.last_checkin_date = today;
    profile.longest_streak = patch.longest_streak;
    if (patch.streak_freeze_used_month) profile.streak_freeze_used_month = patch.streak_freeze_used_month;
    return streak;
  } catch (e) {
    console.error('bumpStreak', e.message);
    return profile.streak_days || 0;
  }
}

async function awardXP(sb, userId, profile, amount, reason, entityType, entityId) {
  try {
    await sb.from('xp_events').insert({ user_id: userId, amount, reason, entity_type: entityType || null, entity_id: entityId || null });
    const newTotal = (profile.xp_total || 0) + amount;
    const { data: levels } = await sb.from('founder_levels').select('level, xp_required').order('xp_required', { ascending: true });
    let level = profile.current_level || 1;
    if (levels) for (const l of levels) if (newTotal >= l.xp_required) level = l.level;
    await sb.from('profiles').update({ xp_total: newTotal, current_level: level, last_active_at: new Date().toISOString() }).eq('id', userId);
    // Every XP-earning action keeps the daily streak alive.
    await bumpStreak(sb, userId, profile);
    return { newTotal, level };
  } catch (e) {
    console.error('awardXP', e.message);
    return null;
  }
}

module.exports = { awardXP, bumpStreak };
