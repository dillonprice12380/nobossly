// One place to turn parts of the product on and off. Everything on the
// shelve list is off until the community is big enough to want it.
const FLAGS = {
  premium:      false,  // pricing page, billing UI, upgrade prompts, Premium gating
  ladder:       false,  // XP, levels, rungs, verified levels
  trophies:     false,  // badges, trophies, milestones, trophy claims
  quests:       false,  // quests, challenges, cohort quests, waitlist
  sprints:      false,  // sprints, sprint tasks, daily check-ins, streaks
  wins:         false,  // wins wall
  analytics:    false,  // dashboard charts, weekly plans
  friendships:  false,  // friend requests (follows stay on)
  collabs:      false,  // collaborations (groups replace them)
  helpBoard:    false,  // turned on in Phase 3
  worksheets:   false,  // turned on in Phase 4
  orgs:         false,  // turned on in Phase 2
};
module.exports = { FLAGS, on: k => !!FLAGS[k] };
