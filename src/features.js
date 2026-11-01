// One place to turn parts of the product on and off. Shelved parts stay in
// the code behind a flag, so bringing one back is a one-line change.
const FLAGS = {
  premium:      false,  // pricing page, billing UI, upgrade prompts, Premium gating
  ladder:       false,  // XP, levels, rungs, verified levels
  trophies:     false,  // badges, trophies, milestones, trophy claims
  quests:       true,   // quests, challenges, public cohorts, waitlist — the public side (2026-11-01)
  sprints:      false,  // sprints, sprint tasks, daily check-ins, streaks
  wins:         true,   // wins wall: members share results
  analytics:    false,  // dashboard charts, weekly plans
  friendships:  false,  // friend requests (follows stay on)
  collabs:      true,   // collaborations: seek collaborators
  helpBoard:    true,   // help board: asks, offers, service swaps (needs migrations/2026-11-01_phase1_public_side.sql)
  worksheets:   false,  // the workspace tools (Phase 2)
  orgs:         false,  // accelerator orgs and private cohorts (Phase 3)
};
module.exports = { FLAGS, on: k => !!FLAGS[k] };
