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
//
// Level 7 was in here as 'manual' — "eligible to mentor members on lower rungs,
// arranged with you directly" — and nothing arranged it. awardXP opens a
// verification_request at level 8 and above; level 7 opened nothing, notified
// nobody, and appeared in no admin queue. So the exact failure this file was
// written to prevent was sitting inside it. It is 'live' now, and the software
// delivers it: see isMentor() below.

const UNLOCKS = {
  3: [{
    kind: 'live',
    label: 'Your build goes public',
    detail: 'Your business name and website appear on your public profile. Below Level 3 they stay hidden.'
  }],
  7: [{
    kind: 'live',
    label: 'Listed as a mentor',
    detail: 'You are listed as a mentor in the member directory and on your profile, where anyone on a lower rung can find you and message you. Turn it off any time in your profile settings.'
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

// Both live unlocks read verified_level, not current_level.
//
// verified_level is the honest number: awardXP sets it automatically for rungs
// 1-7, but 8 and above only move when an admin approves the member's
// verification request. current_level is the game score and moves either way.
// Until now every unlock read the game score, so approving a verification did
// nothing a member could see and declining one did nothing either — the column
// was written by two code paths and read by none of them.
//
// reached() is the one place that choice is made. Falling back to current_level
// would quietly restore the bug, so it does not: a profile that was never
// backfilled reads as level 1 and shows nothing, which is the safe direction.
// The migration backfills every existing row first.
const reached = profile => (profile && profile.verified_level) || 1;

// Level 3: below it, a profile's business name and link are withheld.
const SHOWCASE_LEVEL = 3;
const showsBuild = profile => reached(profile) >= SHOWCASE_LEVEL;

// Level 7: listed as a mentor, unless they have turned it off. Both halves
// matter — the rung is earned, the listing is consented to — so this is the
// only expression of it, and views ask it rather than testing a level.
const MENTOR_LEVEL = 7;
const isMentor = profile =>
  reached(profile) >= MENTOR_LEVEL && (!profile || profile.mentor_available !== false);

const forLevel = level => UNLOCKS[level] || [];

module.exports = { UNLOCKS, forLevel, showsBuild, SHOWCASE_LEVEL, isMentor, MENTOR_LEVEL, reached };
