-- Applied 2026-09-02. Fixes a soft-lock, and gives "does not apply" somewhere
-- to go.
--
-- THE SOFT-LOCK. The three fit trophies counted PASSES against fixed targets of
-- 3, 4 and 5, but the denominator follows the criteria the Compass actually
-- wrote. A founder whose Compass produced four criteria could sit at a perfect
-- 4/4 and never earn "Passes Your Own Test" (auto_target 5) — which gates
-- Level 2. Stuck at Level 1 permanently, with nothing on screen saying why.
--
-- THE SAME TRAP FROM THE OTHER SIDE. A criterion can simply not bear on an idea
-- — "can it be delivered in evenings?" against something nobody delivers. There
-- was no way to say so: forcing a fail capped the score below 100% forever,
-- forcing a pass inflated it. Such a criterion is now excluded from the
-- denominator, with a floor of three applicable criteria (src/fit.js) so the
-- test cannot be dissolved into a free 100%. A criterion settled by a real
-- number is always applicable, so the model cannot declare away the half of the
-- score it does not control.
--
-- Trophies therefore measure COMPLETION as a percentage, which is length-
-- independent: 3/3, 3/4 and 3/5 all read honestly.
alter table generated_ideas add column if not exists fit_applicable smallint;
alter table generated_ideas add column if not exists fit_pct smallint;
alter table generated_ideas add column if not exists best_fit_pct smallint;

update predefined_milestones set auto_kind = 'idea_fit_pct', auto_target = 60,
       description = 'Your idea passed most of the criteria on your own fit test.'
 where slug = 'idea_fit_3';
update predefined_milestones set auto_kind = 'idea_fit_pct', auto_target = 80,
       description = 'You revised against the advisor and the score moved.'
 where slug = 'idea_fit_4';
update predefined_milestones set auto_kind = 'idea_fit_pct', auto_target = 100,
       description = 'Every criterion that applies to your idea passes the fit test your own Compass wrote. Level 1 is done.'
 where slug = 'idea_fit_5';

-- Backfill so an idea already mid-loop is not reset to zero by the change.
update generated_ideas
   set best_fit_pct = greatest(coalesce(best_fit_pct, 0),
                               round(100.0 * coalesce(best_fit_passed, 0) / nullif(fit_total, 0))::int)
 where fit_total is not null and fit_total > 0;
