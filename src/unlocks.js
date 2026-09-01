// What each rung of the Ladder actually gives you.
//
// founder_levels.unlock_text promises a reward at every level, and until now not
// one of them was implemented — verified_level was written by admin approval and
// read by nothing. A promised reward that never arrives is the most expensive
// bug a game can have, so this file is the single place where an unlock is
// declared, and every entry says honestly how it is delivered:
//
//   kind: 'live'   — the app does it, automatically, right now.
//   kind: 'manual' — a real-world commitment a human fulfils off-platform.
//                    Shown to the founder as something that will be arranged,
//                    never as something the software has already granted.
//
// Adding a promise here without shipping the behaviour is the thing this file
// exists to prevent. If it isn't 'live', don't let the UI imply that it is.

const UNLOCKS = {
  3: [{
    kind: 'live',
    label: 'Your build goes public',
    detail: 'Your business name and website appear on your public profile. Below Level 3 they stay hidden.'
  }],
  7: [{
    kind: 'manual',
    label: 'Mentor track',
    detail: 'You become eligible to mentor founders on lower rungs. Arranged with you directly.'
  }],
  8: [{
    kind: 'manual',
    label: 'Accelerator referral',
    detail: 'You are accelerator-ready. The referral is made by a person, after your Level 8 verification is reviewed.'
  }],
  9: [{
    kind: 'manual',
    label: 'Alumni & cohort leader',
    detail: 'Alumni status and cohort leader privileges, arranged after verification.'
  }],
  10: [{
    kind: 'manual',
    label: 'Published playbook',
    detail: 'Your playbook is published for the founders behind you, with your sign-off.'
  }]
};

// Level 3 is the one unlock the software itself enforces: below it, a profile's
// business name and link are withheld. Kept as a named helper so the rule lives
// in one place rather than as a bare `>= 3` scattered through views.
const SHOWCASE_LEVEL = 3;
const showsBuild = profile => (profile && profile.current_level ? profile.current_level : 1) >= SHOWCASE_LEVEL;

const forLevel = level => UNLOCKS[level] || [];

module.exports = { UNLOCKS, forLevel, showsBuild, SHOWCASE_LEVEL };
