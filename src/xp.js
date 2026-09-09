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

const ladders = require('./ladders');
const activity = require('./activity');
const questRoutes = require('./quest_routes');
const unlocks = require('./unlocks');
const { notifySocial } = require('./notify');

const { quiet } = require('./db');
// ---------- The Ladder ----------
// Levels gate on real accomplishments. Each path has its own ten rungs and
// its own gates — see src/ladders.js, which is the source of truth for both.
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

// Gate logic lives in src/ladders.js now, because each path has its own ten
// rungs and the gates are part of that definition rather than a set of
// exceptions layered on a shared one. These are kept as thin wrappers so the
// call sites read the same as they did.
const meetsRequirements = (rung, have) => ladders.meetsRung(rung, have);

// What stands between this founder and the next rung, in the two currencies the
// ladder actually charges: XP, and completed real-world quests. Nothing in the
// app used to surface the quest half — the dashboard showed an XP countdown
// only, so a founder blocked on "make your first sale" saw a number ticking
// down toward a level they could never reach that way.
async function ladderStatus(sb, userId, profile) {
  try {
    const rungs = ladders.ladderFor(profile.path);
    const cur = profile.current_level || 1;
    const next = rungs.find(r => r.level === cur + 1);
    if (!next) return null;

    const have = next.gates.length ? await achievedQuests(sb, userId) : new Set();

    // Where each quest is actually done. Five of the milestone gates are
    // awarded automatically from something you do on another page entirely, so
    // the definitions are loaded and their auto_kind decides the destination —
    // the same field sweepMilestones() awards on, rather than a second list
    // that would drift. A failed lookup falls back to the old behaviour.
    let defs = {};
    const milestoneTitles = next.gates.filter(g => g.type === 'milestone').map(g => g.title);
    if (milestoneTitles.length) {
      // Seven titles have two rows apiece — an old seed and a newer one, the
      // old one deactivated rather than deleted. Without the is_active filter
      // whichever row came back last would decide the link.
      const { data } = await sb.from('predefined_milestones')
        .select('title, auto_kind, is_claimable')
        .eq('is_active', true).in('title', milestoneTitles);
      (data || []).forEach(d => { defs[d.title] = d; });
    }

    const quests = next.gates.map(g => {
      const to = questRoutes.destinationFor(g, defs[g.title]);
      return {
        type: g.type,
        title: g.title,
        href: to.href,
        cta: to.cta,
        done: have.has(ladders.gateKey(g))
      };
    });

    const needMin = next.min && next.min > 0 ? Math.min(next.min, quests.length) : quests.length;
    const doneCount = quests.filter(q => q.done).length;
    const xpNeeded = Math.max(0, (next.xp_required || 0) - (profile.xp_total || 0));
    const questsMet = doneCount >= needMin;

    return {
      next: { level: next.level, title: next.title, emoji: next.emoji,
              xp_required: next.xp_required, unlock_text: ladders.unlockText(next) },
      quests, needMin, doneCount, questsMet, xpNeeded,
      xpMet: xpNeeded === 0,
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
    const levels = ladders.ladderFor(profile.path);
    const current = profile.current_level || 1;
    let level = current;
    const maxXpLevel = levels.reduce((m, l) => (newTotal >= l.xp_required ? Math.max(m, l.level) : m), 1);
    if (maxXpLevel > current) {
      const have = await achievedQuests(sb, userId);
      for (const l of levels) {
        if (l.level <= level) continue;
        if (newTotal < l.xp_required) break;
        if (!ladders.meetsRung(l, have)) break;
        level = l.level;
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
      const info = levels.find(l => l.level === level) || {};
      const msg = 'LEVEL UP! ' + (info.emoji || '\u2b06\ufe0f') + ' You are now Level ' + level + ' \u2014 ' + (info.title || '') + '. ' + ladders.unlockText(info);
      await sb.rpc('push_notification', { target_user: userId, ntype: 'levels', nmessage: msg.slice(0, 500), nentity_type: null, nentity_id: null }).then(...quiet('push_notification:levels'));
      // Out to the people following them, in both forms: the notification is a
      // nudge they clear, the activity row is a thing that stays. The rung is
      // named for their own path, so a follower on a different ladder reads
      // "reached Level 5 — First Invoice" and learns something about them.
      const who = profile.display_name || profile.username || 'A member';
      await notifySocial(sb, userId, who + ' reached Level ' + level + ' \u2014 ' + (info.title || '') + ' ' + (info.emoji || '\ud83c\udf89'), 'profiles', null);
      await activity.record(sb, userId, 'level', 'reached Level ' + level + ' \u2014 ' + (info.title || ''), { emoji: info.emoji, level });

      // Say what the rung just gave them. The dashboard previews the unlocks of
      // the level you are climbing toward, so the moment you arrive they drop
      // off the screen — Level 3's showcase and Level 7's mentor listing both
      // switched on silently. Only 'live' unlocks are announced: a 'manual' one
      // has not happened yet, and saying it has is the thing unlocks.js exists
      // to prevent.
      const live = unlocks.forLevel(level).filter(u => u.kind === 'live');
      for (const u of live) {
        await sb.rpc('push_notification', { target_user: userId, ntype: 'levels', nmessage: ('\ud83c\udf81 ' + u.label + '. ' + u.detail).slice(0, 500), nentity_type: null, nentity_id: null }).then(...quiet('push_notification:unlock'));
      }

      if (level >= 8) {
        // Real-world unlocks (accelerator track, cohort leader, featured playbook)
        // check verified_level, so they open on approval. Unique(user_id, level)
        // makes the insert idempotent.
        await sb.from('verification_requests').insert({ user_id: userId, level }).then(...quiet('verification_requests.insert'));
        await sb.rpc('push_notification', { target_user: userId, ntype: 'levels', nmessage: 'Level ' + level + ' unlocks touch the real world, so they open after a quick verification. Add your evidence \u2014 a public link, a REDACTED screenshot, or book a call. Never upload full financial documents.', nentity_type: null, nentity_id: null }).then(...quiet('push_notification:levels'));
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

module.exports = { awardXP, bumpStreak, achievedQuests, meetsRequirements, ladderStatus };
