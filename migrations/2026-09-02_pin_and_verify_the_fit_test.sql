-- Applied 2026-09-02. Two fixes to what "passes" actually means.
--
-- Before this, a language model wrote the five criteria and then graded the
-- idea against them, with no rubric anywhere for what "pass" meant. Two
-- consequences, neither of which threw an error:
--
--   1. THE GOALPOSTS MOVED. fit_test lived only on the Compass, so redrawing
--      the Compass ("Sharpen it", which deepens the questionnaire) rewrote the
--      criteria underneath an idea already being scored against them. A 5/5
--      idea could become 3/5 without the idea changing.
--
--   2. THE SCORE WAS FARMABLE BY RE-ROLLING. Grading was non-deterministic, and
--      re-running the advisor is the entire Level 1 loop — so clicking again
--      could raise the score without touching the idea. The XP was made
--      unfarmable via a high-water mark; the score itself was not.
--
-- The criteria are now pinned to the idea at draft time, and every criterion
-- that is really a threshold is graded in code (src/fit.js) against the
-- advisor's own estimate, rather than by asking the model whether $750 < $800.
-- The model still estimates the cost; the comparison is arithmetic and gives
-- the same answer every run.
alter table generated_ideas add column if not exists fit_test jsonb;

-- How many criteria were settled by arithmetic rather than opinion. Surfaced on
-- the idea page so a 5/5 is not read as certainty when it is five judgement
-- calls in a row.
alter table generated_ideas add column if not exists fit_verified smallint;

-- No backfill. Ideas drafted before this have no pinned test and keep scoring
-- off the advisor's own results (gradeFitTest falls back to them), with nothing
-- claiming to be verified — which is the truth about how they were scored.
