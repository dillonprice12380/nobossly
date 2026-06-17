// XP + streak helpers. All writes use the user's own client (RLS applies).
async function awardXP(sb, userId, profile, amount, reason, entityType, entityId) {
  try {
    await sb.from('xp_events').insert({ user_id: userId, amount, reason, entity_type: entityType || null, entity_id: entityId || null });
    const newTotal = (profile.xp_total || 0) + amount;
    const { data: levels } = await sb.from('founder_levels').select('level, xp_required').order('xp_required', { ascending: true });
    let level = profile.current_level || 1;
    if (levels) for (const l of levels) if (newTotal >= l.xp_required) level = l.level;
    await sb.from('profiles').update({ xp_total: newTotal, current_level: level, last_active_at: new Date().toISOString() }).eq('id', userId);
    return { newTotal, level };
  } catch (e) {
    console.error('awardXP', e.message);
    return null;
  }
}

async function bumpStreak(sb, userId, profile) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const last = profile.last_checkin_date;
    if (last === today) return profile.streak_days || 0;
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const streak = last === yesterday ? (profile.streak_days || 0) + 1 : 1;
    await sb.from('profiles').update({ streak_days: streak, last_checkin_date: today }).eq('id', userId);
    return streak;
  } catch (e) {
    console.error('bumpStreak', e.message);
    return profile.streak_days || 0;
  }
}

module.exports = { awardXP, bumpStreak };
