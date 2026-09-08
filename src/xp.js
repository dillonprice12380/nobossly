// XP + streak helpers. All writes use the user's own client (RLS applies).
//
// bumpStreak is called ONLY by the daily check-in. It used to run at the end of
// awardXP too, which meant the streak advanced on any XP event at all — ticking
// a task, drafting an idea — while the dashboard and homepage sold it as daily
// check-in discipline. The number and the label now mean the same thing.

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

// ---------- The Ladder ----------
// Levels gate on real accomplishments (see founder_levels.requirements).
// current_level is the game score; verified_level is what real-world unlocks
// check. Levels 1-7 self-verify on the honor-plus-witnesses system; reaching
// 8+ opens a verification_request that an admin reviews — privacy-first, no
// financial documents ever required.

async function achievedQuests(sb, userId) {
  const have = new Set();
  try {
    const [cc, um] = await Promise.all([
      sb.from('challenge_completions').select('challenge_id').eq('user_id', userId),
      sb.from('user_milestones').select('predefined_milestone_id, custom_title').eq('user_id', userId)
    ]);
    const chIds = (cc.data || []).map(r => r.challenge_id).filter(Boolean);
    if (chIds.length) {
      const { data: chs } = await sb.from('challenges').select('title').in('id', chIds);
      (chs || []).forEach(c => c && c.title && have.add('challenge:' + c.title.trim().toLowerCase()));
    }
    const msIds = (um.data || []).map(r => r.predefined_milestone_id).filter(Boolean);
    if (msIds.length) {
      const { data: ms } = await sb.from('predefined_milestones').select('title').in('id', msIds);
      (ms || []).forEach(m => m && m.title && have.add('milestone:' + m.title.trim().toLowerCase()));
    }
    (um.data || []).forEach(r => { if (r && r.custom_title) have.add('milestone:' + r.custom_title.trim().toLowerCase()); });
  } catch (e) { console.error('achievedQuests', e.message); }
  return have;
}

// A gate can be path-specific. `only` limits an entry to those paths, `except`
// removes it from them, and an entry with neither applies to everybody — which
// is most of them.
//
// This exists because several gates were written for one kind of business and
// applied to all nine. A content creator does not register a company to take a
// sponsorship, and a plumber at $1k months will never build a pitch deck. The
// answer is a substitute of equal weight rather than a skipped rung: the site
// promises the same ten-level ladder to everyone, and a path that clears Level
// 10 on fewer real accomplishments makes that untrue.
function questApplies(q, path) {
  if (!q) return false;
  const p = String(path || '').trim();
  if (Array.isArray(q.only) && q.only.length) return q.only.includes(p);
  if (Array.isArray(q.except) && q.except.length) return !q.except.includes(p);
  return true;
}

// The gates that actually stand in front of THIS member. An unknown path (they
// have not finished onboarding) falls back to the universal set, which is the
// safe reading: it can only ever ask for gates that apply to everyone.
function applicableQuests(reqmt, path) {
  if (!reqmt || !Array.isArray(reqmt.quests)) return [];
  return reqmt.quests.filter(q => questApplies(q, path));
}

// Gates that belong to OTHER paths. The quest board and the trophy case filter
// by level only, so without this a creator browses "Serve 100 paying customers"
// and "Registered my business" — gates that will never be theirs — sitting
// beside the ones that are. Takes the levels rows so the caller can reuse a
// query it already made.
function foreignGateTitles(levels, path, type) {
  const mine = new Set(), all = new Set();
  for (const l of levels || []) {
    for (const q of (l && l.requirements && l.requirements.quests) || []) {
      if (!q || q.type !== type || !q.title) continue;
      const t = String(q.title).trim().toLowerCase();
      all.add(t);
      if (questApplies(q, path)) mine.add(t);
    }
  }
  return new Set([...all].filter(t => !mine.has(t)));
}

function meetsRequirements(reqmt, have, path) {
  const quests = applicableQuests(reqmt, path);
  if (!quests.length) return true;
  const hits = quests.filter(qt =>
    qt && have.has(String(qt.type || '') + ':' + String(qt.title || '').trim().toLowerCase())
  ).length;
  // Clamp to what applies. A `min` of 2 against a single applicable gate would
  // be a rung nobody on that path could ever reach.
  const need = (reqmt.min && reqmt.min > 0) ? Math.min(reqmt.min, quests.length) : quests.length;
  return hits >= need;
}

// What stands between this founder and the next rung, in the two currencies the
// ladder actually charges: XP, and completed real-world quests. Nothing in the
// app used to surface the quest half — the dashboard showed an XP countdown
// only, so a founder blocked on "make your first sale" saw a number ticking
// down toward a level they could never reach that way.
async function ladderStatus(sb, userId, profile) {
  try {
    const { data: levels } = await sb.from('founder_levels')
      .select('level, title, emoji, xp_required, requirements, unlock_text').order('level');
    const cur = profile.current_level || 1;
    const next = (levels || []).find(l => l.level === cur + 1);
    if (!next) return null;

    const reqs = next.requirements || {};
    const list = applicableQuests(reqs, profile.path);
    const have = list.length ? await achievedQuests(sb, userId) : new Set();
    const quests = list.map(q => ({
      type: q.type,
      title: q.title,
      href: q.type === 'challenge' ? '/challenges' : '/milestones',
      done: have.has(String(q.type || '') + ':' + String(q.title || '').trim().toLowerCase())
    }));

    const needMin = (reqs.min && reqs.min > 0) ? Math.min(reqs.min, quests.length) : quests.length;
    const doneCount = quests.filter(q => q.done).length;
    const xpNeeded = Math.max(0, (next.xp_required || 0) - (profile.xp_total || 0));
    const questsMet = doneCount >= needMin;

    return {
      next, quests, needMin, doneCount, questsMet, xpNeeded,
      xpMet: xpNeeded === 0,
      // What to actually tell them, rather than a bare number.
      blocker: !questsMet && xpNeeded > 0 ? 'both' : (!questsMet ? 'quests' : (xpNeeded > 0 ? 'xp' : null))
    };
  } catch (e) {
    console.error('ladderStatus', e.message);
    return null;
  }
}

async function awardXP(sb, userId, profile, amount, reason, entityType, entityId) {
  try {
    await sb.from('xp_events').insert({ user_id: userId, amount, reason, entity_type: entityType || null, entity_id: entityId || null });
    const newTotal = (profile.xp_total || 0) + amount;
    const { data: levels } = await sb.from('founder_levels')
      .select('level, xp_required, title, emoji, requirements, unlock_text')
      .order('level', { ascending: true });
    const current = profile.current_level || 1;
    let level = current;
    if (levels && levels.length) {
      const maxXpLevel = levels.reduce((m, l) => (newTotal >= l.xp_required ? Math.max(m, l.level) : m), 1);
      if (maxXpLevel > current) {
        const have = await achievedQuests(sb, userId);
        for (const l of levels) {
          if (l.level <= level) continue;
          if (newTotal < l.xp_required) break;
          if (!meetsRequirements(l.requirements, have, profile.path)) break;
          level = l.level;
        }
      }
    }
    level = Math.max(level, current);
    const patch = { xp_total: newTotal, current_level: level, last_active_at: new Date().toISOString() };
    // Levels 1-7 self-verify; 8+ waits for admin review of a verification request.
    if (level <= 7) patch.verified_level = Math.max(profile.verified_level || 1, level);
    await sb.from('profiles').update(patch).eq('id', userId);
    profile.xp_total = newTotal;
    if (patch.verified_level) profile.verified_level = patch.verified_level;
    if (level > current) {
      profile.current_level = level;
      const info = (levels || []).find(l => l.level === level) || {};
      const msg = 'LEVEL UP! ' + (info.emoji || '\u2b06\ufe0f') + ' You are now Level ' + level + ' \u2014 ' + (info.title || '') + '. ' + (info.unlock_text || '');
      await sb.rpc('push_notification', { target_user: userId, ntype: 'levels', nmessage: msg.slice(0, 500), nentity_type: null, nentity_id: null }).then(() => {}, () => {});
      if (level >= 8) {
        // Real-world unlocks (accelerator track, cohort leader, featured playbook)
        // check verified_level, so they open on approval. Unique(user_id, level)
        // makes the insert idempotent.
        await sb.from('verification_requests').insert({ user_id: userId, level }).then(() => {}, () => {});
        await sb.rpc('push_notification', { target_user: userId, ntype: 'levels', nmessage: 'Level ' + level + ' unlocks touch the real world, so they open after a quick verification. Add your evidence \u2014 a public link, a REDACTED screenshot, or book a call. Never upload full financial documents.', nentity_type: null, nentity_id: null }).then(() => {}, () => {});
      }
    }
    // The level's own title and emoji ride along so the celebration can name
    // the rung the founder just reached rather than only its number.
    const reached = (levels || []).find(l => l.level === level) || {};
    // isMax drives the once-ever "mastered NoBossly" celebration, read from the
    // ladder rather than hard-coded to 10 so adding a rung doesn't strand it.
    const topLevel = (levels || []).reduce((m, l) => Math.max(m, l.level), 1);
    return {
      newTotal, level, leveledUp: level > current,
      title: reached.title || '', emoji: reached.emoji || '',
      isMax: level >= topLevel
    };
  } catch (e) {
    console.error('awardXP', e.message);
    return null;
  }
}

module.exports = { awardXP, bumpStreak, achievedQuests, meetsRequirements, ladderStatus, applicableQuests, questApplies, foreignGateTitles };
