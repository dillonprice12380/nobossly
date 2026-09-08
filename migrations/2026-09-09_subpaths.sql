-- Subpaths: the second level of specificity.
--
-- A path says what shape the business is. A freelance copywriter and a freelance
-- developer both sell a skill by the hour and share almost nothing about what to
-- do next; "content creator" covers someone cutting TikToks and someone running
-- a blog with forty thousand readers. The subpath is what lets a quest be
-- written for the actual work.
--
-- Definitions live in src/paths.js (SUBPATHS). This is the database half: the
-- elective pool can now be tagged with them, and a subpath-tagged quest outranks
-- a merely path-tagged one for someone it matches.

alter table tailored_challenges add column if not exists subpaths text[] not null default '{}';

comment on column tailored_challenges.subpaths is
  'Subpath slugs from src/paths.js SUBPATHS. Empty means the quest suits the whole path. A tagged quest is only offered to those subpaths, and outranks untagged ones for them.';

create index if not exists tailored_challenges_subpaths_idx on tailored_challenges using gin (subpaths);

-- Tag the existing pool where a quest is plainly for one kind of work, so the
-- mechanism has real content behind it rather than an empty column.
update tailored_challenges set subpaths = array['blog','newsletter']
  where title = 'Get 100 people on an email list';
update tailored_challenges set subpaths = array['social','youtube','streaming']
  where title = 'Land your first paid collaboration';
update tailored_challenges set subpaths = array['dev','design']
  where title = 'Write one case study' and 'freelancer' = any(paths);
update tailored_challenges set subpaths = array['handmade','print']
  where title = 'Photograph your product properly';
update tailored_challenges set subpaths = array['saas','marketplace']
  where title = 'Charge someone before it is finished';
update tailored_challenges set subpaths = array['food','retail','bar']
  where title = 'Collect 5 local reviews' and 'brick_mortar' = any(paths);
update tailored_challenges set subpaths = array['trades','cleaning','garden']
  where title = 'Collect 5 local reviews' and 'local_service' = any(paths);

-- And a first set written FOR a subpath, which is the thing subpaths exist for.
insert into tailored_challenges
  (title, description, emoji, xp_reward, suggested_days, min_level, max_level, source, is_active, paths, subpaths)
select * from (values
  ('Post 30 days without checking the numbers',
   'Short-form rewards volume and punishes second-guessing. Thirty consecutive posts, analytics closed, then read them all at once.',
   '📱', 150, 30, 1, 5, 'curated', true, array['creator'], array['social']),
  ('Write 20 titles before you film',
   'On long-form the title and thumbnail decide whether the work is seen at all. Twenty options, pick one, film to it.',
   '🎬', 120, 14, 1, 5, 'curated', true, array['creator'], array['youtube']),
  ('Get 10 subscribers from outside your own audience',
   'Anyone can convert people who already follow them. Ten from a guest post, a collaboration or a directory is the first real distribution.',
   '📧', 150, 30, 2, 6, 'curated', true, array['creator'], array['newsletter','blog']),
  ('Rewrite one page and measure what it does',
   'Copywriting sells because it is testable. Change one page, keep everything else fixed, and write down what happened.',
   '✍️', 150, 21, 2, 7, 'curated', true, array['freelancer'], array['writing']),
  ('Ship one small thing for a stranger, fixed price',
   'Not hourly, not a retainer. One clearly-scoped build for a price you named — it is the fastest way to learn to scope.',
   '💻', 180, 30, 2, 7, 'curated', true, array['freelancer'], array['dev']),
  ('Rebuild one brand you did not design',
   'Pick something with real constraints, redo it properly, and write up the reasoning. It is a portfolio piece and a pitch at once.',
   '🎨', 150, 21, 1, 6, 'curated', true, array['freelancer'], array['design']),
  ('Run one paid discovery call',
   'Charge for the first conversation. It filters out people who want free advice and tells you whether the offer is priced right.',
   '🧠', 180, 30, 2, 7, 'curated', true, array['consultant'], array['business','career']),
  ('Get on three local trade directories',
   'Checkatrade, Angi, the town Facebook group — wherever people in your area actually ask. Listed, with photos and a real number.',
   '🔧', 120, 14, 1, 5, 'curated', true, array['local_service'], array['trades','auto']),
  ('Photograph one job before and after',
   'For visual trades, the proof is the picture. One job documented properly is worth more than a page of description.',
   '📸', 120, 14, 1, 5, 'curated', true, array['local_service'], array['cleaning','garden','beauty']),
  ('Cost your menu to the plate',
   'Every dish, to the gram and the penny, including waste. Food businesses die on the dishes they think are profitable.',
   '🍽️', 200, 21, 1, 6, 'curated', true, array['brick_mortar'], array['food']),
  ('Sell 10 units at a market before you list',
   'Handmade sells face to face first. Ten in person tells you the price, the pitch and which variant to make more of.',
   '🧶', 180, 30, 1, 5, 'curated', true, array['online_store'], array['handmade']),
  ('Get one integration or listing on someone else''s platform',
   'For business software, distribution is usually somebody else''s marketplace. One listing beats three months of posting.',
   '🔌', 200, 45, 2, 7, 'curated', true, array['software'], array['saas','extension'])
) as v(title, description, emoji, xp_reward, suggested_days, min_level, max_level, source, is_active, paths, subpaths)
where not exists (select 1 from tailored_challenges t where t.title = v.title);

-- Mirrored onto the profile so elective matching does not join through the
-- questionnaire on every request, exactly as profiles.path already is.
alter table profiles add column if not exists subpath text;

comment on column profiles.subpath is
  'Mirrored from the completed questionnaire (path_answers.subpath, stored as a slug from src/paths.js SUBPATHS) so elective matching and the Coach do not have to join through questionnaire_responses on every request. Mirrors profiles.path.';
