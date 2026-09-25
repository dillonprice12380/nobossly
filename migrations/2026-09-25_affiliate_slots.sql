-- Affiliate slots. NoBossly is free; recommending the right tool at the moment a
-- member needs it (the quest that asks them to open a business bank account,
-- the guide on invoicing) is how it earns without a paywall.
--
-- Every slot is seeded generic and EMPTY: no partner, no URL. A slot is shown
-- to members only once an admin pastes a partner name and link into
-- /admin/affiliates and switches it on, so this migration changes nothing a
-- member can see.
--
-- Where a slot appears is decided by its tags:
--   match_titles   quest and trophy titles, lowercased (quest board, trophy case)
--   match_paths    path slugs (the public /paths/:slug landing pages)
--   match_keywords matched at word starts against a guide's title (guide pages)
--
-- Clicks go through /go/:key, which calls affiliate_go(): it logs the click
-- and hands back the partner URL. Links are never written into pages directly,
-- so a partner can be swapped without touching content.

create table if not exists public.affiliate_offers (
  key            text primary key check (key ~ '^[a-z0-9_]{2,60}$'),
  category       text not null,
  label          text not null,
  blurb          text not null,
  cta_label      text not null default 'Take a look',
  partner_name   text,
  url            text check (url is null or url ~* '^https://'),
  match_titles   text[] not null default '{}',
  match_paths    text[] not null default '{}',
  match_keywords text[] not null default '{}',
  active         boolean not null default false,
  sort           int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.affiliate_clicks (
  id         bigserial primary key,
  offer_key  text not null references public.affiliate_offers(key) on delete cascade,
  user_id    uuid,
  source     text,
  created_at timestamptz not null default now()
);
create index if not exists affiliate_clicks_offer_created on public.affiliate_clicks (offer_key, created_at);

alter table public.affiliate_offers enable row level security;
alter table public.affiliate_clicks enable row level security;

-- Anyone may read a live offer; admins read them all. Kept as two policies so a
-- signed-out visitor never evaluates is_admin(), which anon cannot execute.
drop policy if exists affiliate_offers_live_read on public.affiliate_offers;
create policy affiliate_offers_live_read on public.affiliate_offers
  for select using (active and url is not null);
drop policy if exists affiliate_offers_admin_read on public.affiliate_offers;
create policy affiliate_offers_admin_read on public.affiliate_offers
  for select to authenticated using (public.is_admin());
drop policy if exists affiliate_clicks_admin_read on public.affiliate_clicks;
create policy affiliate_clicks_admin_read on public.affiliate_clicks
  for select to authenticated using (public.is_admin());
-- No insert/update/delete policies: writes go through the functions below.

create or replace function public.affiliate_go(p_key text, p_source text)
returns text language plpgsql security definer set search_path to 'public'
as $function$
declare v_url text;
begin
  select url into v_url from affiliate_offers
   where key = p_key and active and url is not null;
  if v_url is null then return null; end if;
  insert into affiliate_clicks (offer_key, user_id, source)
  values (p_key, auth.uid(), left(p_source, 200));
  return v_url;
end $function$;
revoke all on function public.affiliate_go(text, text) from public;
grant execute on function public.affiliate_go(text, text) to anon, authenticated;

create or replace function public.admin_save_affiliate(
  p_key text, p_partner text, p_url text, p_cta text, p_active boolean)
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare v_url text := nullif(btrim(coalesce(p_url, '')), '');
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if v_url is not null and v_url !~* '^https://' then
    raise exception 'Affiliate links must start with https://';
  end if;
  update affiliate_offers set
    partner_name = nullif(btrim(left(coalesce(p_partner, ''), 80)), ''),
    url          = v_url,
    cta_label    = coalesce(nullif(btrim(left(coalesce(p_cta, ''), 40)), ''), 'Take a look'),
    -- A slot without a link cannot be live.
    active       = coalesce(p_active, false) and v_url is not null,
    updated_at   = now()
  where key = p_key;
end $function$;
revoke all on function public.admin_save_affiliate(text, text, text, text, boolean) from public;
grant execute on function public.admin_save_affiliate(text, text, text, text, boolean) to authenticated;

create or replace function public.admin_affiliate_clicks()
returns table (offer_key text, clicks_30d bigint, clicks_total bigint)
language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return query
    select c.offer_key,
           count(*) filter (where c.created_at > now() - interval '30 days'),
           count(*)
      from affiliate_clicks c group by c.offer_key;
end $function$;
revoke all on function public.admin_affiliate_clicks() from public;
grant execute on function public.admin_affiliate_clicks() to authenticated;

-- The slots. Re-running refreshes the generic copy and tags but never touches
-- partner_name, url, cta_label or active — those belong to the admin screen.
insert into public.affiliate_offers (key, category, label, blurb, match_titles, match_paths, match_keywords, sort) values
  ('business_formation', 'Start & protect', 'Business formation service', 'Files your LLC or corporation paperwork with the state so you do not have to work through the forms yourself.', array['registered my business']::text[], '{}'::text[], array['llc','incorporat','form a business','business structure','register your business','registering']::text[], 10),
  ('registered_agent', 'Start & protect', 'Registered agent service', 'A registered address for official legal mail — and it keeps your home address off public filings.', array['registered my business']::text[], '{}'::text[], array['registered agent']::text[], 20),
  ('legal_templates', 'Start & protect', 'Contract & legal templates', 'Ready-made client contracts, NDAs and terms you can adapt instead of writing from scratch.', array['publish a portfolio that wins work','price one offer by the outcome','land a partnership']::text[], array['freelancer','consultant']::text[], array['contract','agreement','nda']::text[], 30),
  ('online_legal_help', 'Start & protect', 'On-demand legal advice', 'Short, affordable consultations with a lawyer for the questions a template cannot answer.', array['land a partnership']::text[], '{}'::text[], array['lawyer','attorney','legal']::text[], 40),
  ('trademark_filing', 'Start & protect', 'Trademark filing service', 'Protects your business name or logo before someone else claims it.', array['registered my business']::text[], array['creator','online_store','physical_product','software']::text[], array['trademark','brand name']::text[], 50),
  ('general_liability_insurance', 'Start & protect', 'Small business insurance', 'General liability cover, so one accident or claim does not wipe out the business.', array['registered my business']::text[], array['local_service','brick_mortar','physical_product']::text[], array['insurance','liability']::text[], 60),
  ('professional_liability_insurance', 'Start & protect', 'Professional liability insurance', 'Covers you if a client says your advice or work cost them money.', '{}'::text[], array['freelancer','consultant']::text[], array['professional liability','errors and omissions']::text[], 70),
  ('business_licensing', 'Start & protect', 'Licenses & permits service', 'Finds the local, state and industry licenses you need and helps you file them.', array['test the concept without the lease']::text[], array['local_service','brick_mortar']::text[], array['license','permit']::text[], 80),
  ('business_checking', 'Money & payments', 'Business checking account', 'Keeps business money separate from personal — the first thing every accountant asks for.', array['opened a business bank account','separate your business money']::text[], '{}'::text[], array['bank account','business bank','checking account']::text[], 90),
  ('business_savings', 'Money & payments', 'High-yield business savings', 'Somewhere for tax money and a safety cushion to earn interest until it is needed.', array['had my first profitable month']::text[], '{}'::text[], array['savings','emergency fund','set aside']::text[], 100),
  ('business_credit_card', 'Money & payments', 'Business credit card', 'Builds business credit and keeps business spending on its own statement.', array['separate your business money']::text[], '{}'::text[], array['credit card','business credit']::text[], 110),
  ('invoicing', 'Money & payments', 'Invoicing tool', 'Professional invoices, automatic reminders, and a clear view of who still owes you.', array['set up how you get paid','quote 10 jobs in two weeks']::text[], array['freelancer','consultant','local_service']::text[], array['invoice','invoicing','get paid']::text[], 120),
  ('online_payments', 'Money & payments', 'Online payment processing', 'Take card payments online or through a payment link — no full store needed.', array['set up how you get paid','make your first sale']::text[], '{}'::text[], array['accept payments','payment link','take payments','checkout']::text[], 130),
  ('card_reader', 'Money & payments', 'Card reader & point of sale', 'Take card and tap payments at markets, on job sites or behind a counter.', array['make one by hand and sell it']::text[], array['local_service','brick_mortar','physical_product']::text[], array['card reader','point of sale','pos system']::text[], 140),
  ('bookkeeping_software', 'Money & payments', 'Bookkeeping software', 'Tracks income and expenses and gets you ready for tax time.', array['separate your business money','earn your first $100','work out your true unit margin']::text[], '{}'::text[], array['bookkeeping','accounting','expenses']::text[], 150),
  ('bookkeeping_service', 'Money & payments', 'Done-for-you bookkeeping', 'A bookkeeper keeps your books tidy every month so you do not have to.', array['hit a $1k month']::text[], '{}'::text[], array['bookkeeper']::text[], 160),
  ('tax_help', 'Money & payments', 'Small business tax help', 'Tax prep and advice from people who know self-employment and side-business income.', array['had my first profitable month']::text[], '{}'::text[], array['tax','self-employ','quarterly estimate']::text[], 170),
  ('payroll', 'Money & payments', 'Payroll service', 'Pays staff or contractors on time and handles the filings.', array['went full-time on my business','serve 100 paying customers']::text[], array['brick_mortar','local_service']::text[], array['payroll','first hire','employee']::text[], 180),
  ('receipt_mileage', 'Money & payments', 'Receipt & mileage tracker', 'Snap receipts and log business miles so no deduction slips through.', '{}'::text[], array['local_service']::text[], array['receipt','mileage','deduction']::text[], 190),
  ('business_funding', 'Money & payments', 'Small business funding', 'Loans, lines of credit and financing for when growth needs cash up front.', array['cover a month''s rent from takings']::text[], array['brick_mortar','physical_product']::text[], array['loan','funding','financing','line of credit']::text[], 200),
  ('crowdfunding', 'Money & payments', 'Crowdfunding platform', 'Pre-sell a product to prove demand and fund the first production run.', array['get three manufacturing quotes']::text[], array['physical_product']::text[], array['crowdfund','pre-sell','preorder','pre-order']::text[], 210),
  ('domain_name', 'Website & selling', 'Domain name registrar', 'Claim yourbusiness.com before you build anything on it.', array['launch a landing page']::text[], '{}'::text[], array['domain']::text[], 220),
  ('website_builder', 'Website & selling', 'Website builder', 'A professional site without code — enough to look real to your first customers.', array['launch a landing page','publish a portfolio that wins work']::text[], '{}'::text[], array['website','site builder','portfolio site']::text[], 230),
  ('web_hosting', 'Website & selling', 'Web hosting', 'Reliable hosting if you would rather build and own your site yourself.', '{}'::text[], array['software']::text[], array['web hosting','hosting']::text[], 240),
  ('landing_page_builder', 'Website & selling', 'Landing page builder', 'Build one focused page to test an idea and collect sign-ups fast.', array['launch a landing page','validate your idea']::text[], '{}'::text[], array['landing page']::text[], 250),
  ('business_email', 'Website & selling', 'Professional email & workspace', 'you@yourbusiness.com email, calendar and docs — small, but it changes how people read you.', array['launch a landing page']::text[], '{}'::text[], array['business email','email address','workspace']::text[], 260),
  ('ecommerce_platform', 'Website & selling', 'Online store platform', 'Everything to run a store: products, checkout, shipping and sales tax.', array['list your first product properly']::text[], array['online_store','physical_product']::text[], array['online store','ecommerce','e-commerce','sell online']::text[], 270),
  ('digital_products', 'Website & selling', 'Digital product storefront', 'Sell downloads, templates and guides with delivery handled for you.', '{}'::text[], array['creator']::text[], array['digital product','download','template']::text[], 280),
  ('courses_memberships', 'Website & selling', 'Course & membership platform', 'Host a course, cohort or paid community and take payment in one place.', '{}'::text[], array['creator','consultant']::text[], array['online course','membership','paid community']::text[], 290),
  ('booking_scheduling', 'Website & selling', 'Online booking & scheduling', 'Clients book and pay for your time without the back-and-forth.', array['5 customer conversations']::text[], array['consultant','freelancer','local_service']::text[], array['booking','scheduling','appointment']::text[], 300),
  ('print_on_demand', 'Website & selling', 'Print-on-demand', 'Sell merch and printed products with no inventory up front.', '{}'::text[], array['creator','online_store']::text[], array['merch','print on demand','print-on-demand']::text[], 310),
  ('product_sourcing', 'Website & selling', 'Product sourcing & suppliers', 'Find manufacturers and wholesale suppliers and compare quotes.', array['get three manufacturing quotes','list your first product properly']::text[], array['online_store','physical_product']::text[], array['supplier','manufactur','wholesale','sourcing']::text[], 320),
  ('shipping_labels', 'Website & selling', 'Shipping & label software', 'Discounted postage and one place to print labels for every order.', array['reach 50 paying customers']::text[], array['online_store','physical_product']::text[], array['shipping','postage','fulfil']::text[], 330),
  ('packaging_supplies', 'Website & selling', 'Packaging supplies', 'Boxes, mailers and branded packaging for shipping orders.', '{}'::text[], array['online_store','physical_product']::text[], array['packaging']::text[], 340),
  ('inventory_management', 'Website & selling', 'Inventory management', 'Know what is in stock across every channel before you oversell.', array['reach 50 paying customers','serve 100 paying customers']::text[], array['online_store','physical_product','brick_mortar']::text[], array['inventory','stock control']::text[], 350),
  ('email_marketing', 'Marketing & growth', 'Email marketing platform', 'Build your list and send newsletters and automated sequences.', array['grow an email list to 100']::text[], array['creator']::text[], array['email list','newsletter','email marketing']::text[], 360),
  ('social_scheduling', 'Marketing & growth', 'Social media scheduler', 'Plan and schedule a month of posts in one sitting.', array['build a social presence','publish 12 pieces in 30 days']::text[], array['creator']::text[], array['social media','content calendar']::text[], 370),
  ('graphic_design', 'Marketing & growth', 'Graphic design tool', 'Logos, social graphics and flyers from templates — no designer needed.', array['build a social presence']::text[], '{}'::text[], array['logo','graphic design','branding']::text[], 380),
  ('video_editing', 'Marketing & growth', 'Video editing software', 'Edit, caption and cut short-form clips quickly.', array['publish 12 pieces in 30 days']::text[], array['creator']::text[], array['video']::text[], 390),
  ('podcast_hosting', 'Marketing & growth', 'Podcast hosting', 'Publish your show everywhere listeners are, with stats.', '{}'::text[], array['creator']::text[], array['podcast']::text[], 400),
  ('creator_gear', 'Marketing & growth', 'Microphones, cameras & lighting', 'The starter kit that makes content look and sound professional.', '{}'::text[], array['creator']::text[], array['microphone','camera','lighting','equipment']::text[], 410),
  ('link_in_bio', 'Marketing & growth', 'Link-in-bio page', 'One link that sends followers to everything you offer.', array['build a social presence']::text[], array['creator']::text[], array['link in bio']::text[], 420),
  ('seo_tools', 'Marketing & growth', 'SEO tools', 'See what your customers search for and how to show up for it.', '{}'::text[], '{}'::text[], array['seo','search engine','keyword research']::text[], 430),
  ('local_listings', 'Marketing & growth', 'Local listings & reviews', 'Keep your details consistent across maps and directories, and ask happy customers for reviews.', array['get your google business profile live and verified']::text[], array['local_service','brick_mortar']::text[], array['local seo','google business profile','online reviews','directory']::text[], 440),
  ('testimonial_collection', 'Marketing & growth', 'Testimonial collection', 'Collect written and video testimonials and show them on your site.', array['collect 5 testimonials','collect 5 pieces of audience proof']::text[], '{}'::text[], array['testimonial','social proof']::text[], 450),
  ('print_marketing', 'Marketing & growth', 'Business cards & print marketing', 'Cards, flyers, door hangers and signs for getting known locally.', array['quote 10 jobs in two weeks']::text[], array['local_service','brick_mortar']::text[], array['business card','flyer','signage','door hanger']::text[], 460),
  ('crm', 'Marketing & growth', 'Customer relationship manager (CRM)', 'Track every lead and conversation so no follow-up falls through.', array['do 25 outreach touches','pitch 25 brands or collaborators','reach 10 paying customers']::text[], array['freelancer','consultant']::text[], array['crm','leads','lead generation','sales pipeline']::text[], 470),
  ('outreach_tools', 'Marketing & growth', 'Outreach & prospecting tool', 'Find the right contacts and send personal outreach at a sensible pace.', array['do 25 outreach touches','pitch 25 brands or collaborators']::text[], '{}'::text[], array['outreach','prospect','cold email']::text[], 480),
  ('referral_software', 'Marketing & growth', 'Referral program software', 'Reward customers for sending their friends your way.', array['start a referral engine']::text[], '{}'::text[], array['referral']::text[], 490),
  ('forms_surveys', 'Marketing & growth', 'Forms & surveys', 'Collect interest, feedback and pre-orders with simple forms.', array['validate your idea','interview 5 people in a field you are curious about']::text[], array['exploring']::text[], array['survey','feedback form','waitlist']::text[], 500),
  ('user_testing', 'Marketing & growth', 'User testing', 'Watch real people use your product and see where they get stuck.', array['watch 5 people use it without helping']::text[], array['software']::text[], array['user testing','usability']::text[], 510),
  ('project_management', 'Operations', 'Project management', 'Organize tasks, clients and deadlines as the work picks up.', array['write your one-page plan']::text[], '{}'::text[], array['project management','productivity']::text[], 520),
  ('automation', 'Operations', 'No-code automation', 'Connect your apps so repetitive tasks run on their own.', array['automate one process']::text[], '{}'::text[], array['automat','workflow']::text[], 530),
  ('e_signature', 'Operations', 'E-signature', 'Get contracts and quotes signed online in minutes.', array['land a partnership']::text[], array['freelancer','consultant','local_service']::text[], array['e-signature','esignature','sign contracts']::text[], 540),
  ('proposals_quotes', 'Operations', 'Proposal & quote software', 'Send polished proposals and quotes clients can accept online.', array['quote 10 jobs in two weeks','price one offer by the outcome']::text[], array['freelancer','consultant','local_service']::text[], array['proposal','quote','estimate']::text[], 550),
  ('time_tracking', 'Operations', 'Time tracking', 'Know exactly where your hours go — and bill for all of them.', '{}'::text[], array['freelancer','consultant']::text[], array['time tracking','hourly rate','billable']::text[], 560),
  ('field_service', 'Operations', 'Field service software', 'Scheduling, dispatch, quotes and invoicing for on-site jobs.', array['quote 10 jobs in two weeks']::text[], array['local_service']::text[], array['field service','dispatch']::text[], 570),
  ('business_phone', 'Operations', 'Business phone number', 'A separate business line on the phone you already have.', array['get your google business profile live and verified']::text[], array['local_service','consultant','freelancer']::text[], array['phone number','business phone']::text[], 580),
  ('virtual_address', 'Operations', 'Virtual business address & mailbox', 'A real street address for your business and its mail, without an office.', array['registered my business']::text[], '{}'::text[], array['virtual address','mailbox','business address']::text[], 590),
  ('password_manager', 'Operations', 'Password manager', 'Keep every business login secure and shareable with the people who help you.', array['automate one process']::text[], '{}'::text[], array['password','security']::text[], 600),
  ('cloud_dev_tools', 'Operations', 'Cloud hosting & developer tools', 'Infrastructure and tools to build, deploy and run your product.', array['ship something usable in 30 days']::text[], array['software']::text[], array['cloud','deploy','developer']::text[], 610),
  ('product_analytics', 'Operations', 'Product analytics', 'See how people actually use your product and where they drop off.', array['watch 5 people use it without helping']::text[], array['software']::text[], array['analytics','metrics']::text[], 620),
  ('subscription_billing', 'Operations', 'Subscription billing', 'Recurring billing, trials and failed-payment recovery for software and memberships.', array['$1k mrr']::text[], array['software','creator']::text[], array['subscription','recurring revenue','mrr']::text[], 630),
  ('prototyping', 'Operations', 'Prototyping & 3D printing', 'Turn a sketch into a physical prototype you can test and show.', array['make one by hand and sell it','get three manufacturing quotes']::text[], array['physical_product']::text[], array['prototype','3d print']::text[], 640),
  ('commercial_space', 'Operations', 'Pop-up & commercial space listings', 'Find short-term pop-up space or your first lease.', array['test the concept without the lease','count footfall at three sites']::text[], array['brick_mortar']::text[], array['lease','pop-up','retail space','commercial space']::text[], 650),
  ('hire_freelancers', 'Operations', 'Freelance talent marketplace', 'Hire help for design, writing or development by the project.', array['went full-time on my business']::text[], '{}'::text[], array['outsourc','hire help','virtual assistant']::text[], 660),
  ('find_client_work', 'Operations', 'Freelance job marketplace', 'Find paid projects while you build your own client base.', array['make your first sale']::text[], array['freelancer']::text[], array['find clients','freelance work','first client']::text[], 670),
  ('online_learning', 'Learning & planning', 'Online courses & skills', 'Learn the specific skill your next rung needs.', '{}'::text[], array['exploring']::text[], array['learn','skill','course']::text[], 680),
  ('books_audiobooks', 'Learning & planning', 'Business books & audiobooks', 'The reading list members recommend, for the commute.', array['document your playbook']::text[], array['exploring']::text[], array['business books','reading list','audiobook']::text[], 690),
  ('pitch_deck_tools', 'Learning & planning', 'Pitch deck & presentation tool', 'Build a clear deck for investors, landlords or partners.', array['built a pitch deck']::text[], array['brick_mortar','physical_product','software']::text[], array['pitch deck','presentation','investor']::text[], 700),
  ('business_plan_tools', 'Learning & planning', 'Business plan software', 'Guided templates and projections for your one-page — or full — plan.', array['write your one-page plan']::text[], '{}'::text[], array['business plan','projection','forecast']::text[], 710),
  ('coworking', 'Learning & planning', 'Coworking space', 'A desk and a community away from the kitchen table.', array['went full-time on my business']::text[], '{}'::text[], array['coworking','office space']::text[], 720)
on conflict (key) do update set
  category = excluded.category, label = excluded.label, blurb = excluded.blurb,
  match_titles = excluded.match_titles, match_paths = excluded.match_paths,
  match_keywords = excluded.match_keywords, sort = excluded.sort;
