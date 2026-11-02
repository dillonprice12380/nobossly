# Path dashboards — the map

Status: built (2026-11-02). Setup, workspace and building blocks in step 1; every path's dashboard in steps 2–4. Path configs live in `src/path_dashboards/<path>.js`.

## The idea in one paragraph

Every member picks one of ten paths. Today that choice changes a few words and
which challenges are suggested; the dashboard is the same for a YouTuber and a
café owner. This plan gives each path its own dashboard: its own **north-star
number**, its own **stages**, its own **working tools**, and its own
**checklists** — while sharing one set of building blocks underneath, so ten
dashboards do not mean ten codebases. A path decides what is *featured*; every
tool stays reachable from the tool library, because real people blur the lines
(a coach who also writes a newsletter).

---

## What the site already knows (and what it doesn't)

| | Today |
|---|---|
| Paths | 10: creator, freelancer, consultant, local_service, brick_mortar, online_store, physical_product, software, exploring (+ `default`) |
| Subpaths | 6–7 per path (e.g. creator → short-form, YouTube, podcast, newsletter, blog, live) — defined in `src/paths.js`, **never asked at signup** |
| Path questions | 4–7 per path (platform, audience size, avg job value, rent capacity, unit cost…) — defined, **never asked** since the questionnaire was removed; the old answers live in `questionnaire_responses`, which is being dropped |
| Each path's one number | Written up as each path's "bar": followers/visits, billable hours, clients per month, jobs per week, takings vs rent, orders at margin, paying customers |
| Stages | Every path has a `stage` question with 5–6 honest stages (e.g. freelancer: Not started → a few one-off jobs → some regular clients → fully booked → turning work away) |
| Ladders | 10 rungs per path, with real-world gates ("Hit a $1k month", "Serve 100 paying customers") — XP is off, but the gates are good milestones |
| Members | 15; 8 have no path yet; creator 2, exploring 2, online store 1, freelancer 1, software 1 |

So the first job is **setup**: ask the subpath and the 3–4 path questions that
actually change the dashboard, right after the path is picked (and on the
dashboard for the 8 who have none).

---

## How every path dashboard is shaped

Same skeleton, different contents:

1. **Where you are** — the path's stage (from the stage question, no XP), and
   the one thing that moves you to the next stage (taken from the ladder gates).
2. **Your number** — the path's north-star metric with a simple monthly log and
   trend, plus one or two supporting numbers.
3. **This week** — tasks and goals, pre-seeded with path-specific starter tasks.
4. **Your tools** — 3–5 tools featured for the path (the working tools below).
5. **Checklists** — the path's must-dos (licences, launch steps, lease steps…).
6. **Your people** — groups and cohorts, open help-board asks in the categories
   you can help with, and challenges tagged to your path.
7. **Workspace** — the shared planning tools, in the order that matters for the
   path (a café owner sees the business plan first; a creator sees it last).

The shared workspace tools (Phase 2 list): Lean Canvas, Business Model Canvas,
customer persona, business plan, idea refiner, elevator pitch, goals, personal
milestones, surveys, plus the existing tasks, Money (budget + income log) and
the five tools (Quit-Date Planner, Tax Set-Aside, Pricing & Margin, Proof Page,
Customer Interviews).

---

## Path by path

Legend for the shared tools: ★ featured · ○ available · — tucked away (still
in the library, not on the dashboard).

### 🎬 Content creator
*Subpaths: short-form, YouTube, podcast, newsletter, blog, live streaming.*

- **North star:** the audience they are measured in — **followers** for
  short-form/live, **subscribers** for YouTube/newsletter, **downloads per
  episode** for podcast, **monthly visits** for blog. (The existing creator bar
  already splits publishers from influencers.) Supporting: monthly creator
  income by source.
- **Stages:** Not started → posting occasionally → posting consistently, no
  income → earning something → main income.
- **Working tools**
  - **Content pipeline** — idea → scripted → recorded → edited → published, with
    a publish-date calendar. The engine of the path.
  - **Consistency tracker** — cadence goal ("3 Shorts a week") vs. what shipped;
    the honest number before money arrives.
  - **Audience & income log** — monthly followers/subs/views per platform and
    income per source (sponsor, affiliate, product, membership, ads).
  - **Brand deal pipeline** — pitched → negotiating → contracted → delivered →
    paid, with deliverables and due dates.
  - **Media kit** — the Proof Page, reframed: audience numbers, demographics,
    past partners, rates.
  - **Idea bank** — hooks and topics, tagged, promoted into the pipeline.
- **Subpath tweaks:** newsletter adds open rate and a referral count; blog adds
  a keyword tracker; podcast tracks guests and episodes; live tracks hours
  streamed and concurrent viewers.
- **Checklists:** channel setup; monetisation thresholds per platform; first
  sponsor pitch; disclosure rules for paid posts.
- **Workspace:** audience persona ★ · idea refiner ★ · elevator pitch ○ (for
  brands) · Lean Canvas ○ · business plan — · Tax Set-Aside ○ · Quit-Date ★
  (once income starts).
- **Doesn't fit:** inventory, quotes, premises.

### 💻 Freelancer
*Subpaths: writing, design, development, video, marketing, admin/ops.*

- **North star:** **billable income this month**; supporting: billable hours,
  active clients, effective hourly rate (income ÷ hours actually worked).
- **Stages:** Not started → a few one-off jobs → some regular clients → fully
  booked → turning work away.
- **Working tools**
  - **Client pipeline** — lead → conversation → proposal sent → won → delivered
    → paid; value and source per client (referral, platform, cold).
  - **Proposal & quote builder** — scope, deliverables, timeline, price; saved
    as templates; marked sent/accepted.
  - **Invoice tracker** — sent, due, overdue, paid; feeds the income log
    automatically.
  - **Time log** — billable vs. non-billable hours per client; keeps the rate
    honest (the bar's "six of ten hours are billable").
  - **Outreach tracker** — touches per week and replies; ties to the ladder's
    "25 outreach touches".
  - **Portfolio** — Proof Page with work samples and testimonials ★.
- **Checklists:** contract essentials; getting paid (deposit, terms, late
  fees); setting up as a business.
- **Workspace:** ideal-client persona ★ · Pricing & Margin ★ · elevator pitch ★
  · Tax ★ · Quit-Date ★ · Lean Canvas ○ · business plan —.

### 🧠 Coach or consultant
*Subpaths: business, career/life, health & fitness, finance, technical.*

- **North star:** **paying clients this month** and revenue; supporting:
  discovery calls held, close rate, client results recorded.
- **Stages:** Not started → advised a few people informally → paid once or
  twice → regular paying clients → main income.
- **Working tools**
  - **Offer builder** — the signature offer: who it is for, the outcome, what is
    included, length, price, guarantee; plus a low/mid/high price ladder.
  - **Discovery-call pipeline** — booked → held → proposal → won/lost, with why.
  - **Client roster & sessions** — sessions used/remaining, notes, and the
    *result* each client got.
  - **Case studies** — turns recorded results into proof (Proof Page ★).
  - **Lead-magnet planner** — one free thing that starts conversations.
- **Checklists:** credentials and scope-of-practice (health/finance subpaths get
  a "what you can and cannot claim" list); agreements and waivers; booking and
  payment setup.
- **Workspace:** ideal-client persona ★ · elevator pitch ★ · Pricing ★ ·
  surveys ★ (pre/post client check-ins) · Tax ○ · Quit-Date ○ · Lean Canvas ○.

### 🚚 Local service
*Subpaths: trades, cleaning, garden, mobile repair, mobile beauty, pet services.*

- **North star:** **jobs per week** and booked revenue; supporting: average job
  value, repeat customers, reviews collected.
- **Stages:** Not started → a few jobs for people I know → regular work → booked
  out → running it with help.
- **Working tools**
  - **Jobs board** — enquiry → quoted → booked → done → paid, with date, address
    area (not the address — the filter applies) and value.
  - **Quote builder** — labour + materials + call-out, saved price list per
    service; quote accepted → job booked.
  - **Customer list** — repeat-visit reminders (cleaning, gardening, grooming
    are recurring by nature).
  - **Reviews tracker** — ask after every job; count Google/Nextdoor reviews.
  - **Equipment & start-up costs** — what you have, need, rent; feeds Money.
  - **Service area & pricing sheet** — area, call-out radius, minimum job.
- **Checklists:** licences, insurance and certifications by trade, with expiry
  reminders; vehicle; safety; first-job paperwork.
- **Workspace:** Pricing ★ · Tax ★ (mileage matters here) · business plan ○ ·
  persona ○ · elevator pitch ○ · canvases —.
- **Doesn't fit:** content pipeline, MRR.

### 🏪 Brick and mortar
*Subpaths: café/restaurant, shop/retail, salon/barber, gym/studio, bar/pub.*

- **North star:** **monthly takings against rent** (rent under 10% of takings,
  from the path's bar); before opening, **days to opening** and **money raised
  vs. needed**.
- **Stages:** Just an idea → looking at premises → lease signed → fitting out →
  open and trading.
- **Working tools**
  - **Site scout** — compare premises side by side: rent, size, footfall,
    parking, condition, score; shortlist → viewed → offer → signed.
  - **Opening plan** — the critical path to day one: permits, inspections,
    fit-out, hiring, stock, soft launch, with dates and dependencies.
  - **Start-up cost & fit-out budget** — the big one; feeds Money and the plan.
  - **Break-even calculator** — covers/customers/memberships per day needed to
    cover rent, staff and costs.
  - **Funding tracker** — loans, grants, investors, own savings: applied →
    approved → drawn.
  - **Staffing plan** — roles, hours, cost, hiring status.
  - **Daily takings log** (once open) — feeds the north star.
- **Checklists:** lease review; licences and permits by venue type (food
  hygiene, alcohol, music, signage); insurance; opening week.
- **Workspace:** business plan ★ (lenders will ask) · Business Model Canvas ★ ·
  customer persona ★ · surveys ★ (local demand) · Pricing ○ · Lean Canvas ○ ·
  elevator pitch ○.

### 📦 Online store
*Subpaths: handmade, print on demand, wholesale/reselling, digital products,
dropshipping.*

- **North star:** **orders this month at margin**; supporting: revenue, average
  order value, margin after fees and shipping, conversion where known.
- **Stages:** Just an idea → product chosen → listed, no sales → a few sales →
  selling regularly.
- **Working tools**
  - **Product catalogue & unit economics** — per product: cost, price, platform
    fees, shipping, ad cost per sale → real margin per channel (extends the
    Pricing tool).
  - **Sales log by channel** — Etsy, own site, Amazon, TikTok Shop, markets.
  - **Inventory** (physical only) — stock, reorder point, low-stock nudge.
  - **Marketing tests** — channel, spend, sales → return on ad spend; kill or
    keep.
  - **Supplier list** (wholesale/dropship/POD) — costs, lead times, quality.
  - **Listing checklist per channel** — photos, title, tags, policies.
- **Subpath tweaks:** digital products hide inventory and shipping; handmade
  adds "hours per item" so time is costed; POD and dropship add supplier
  margin checks.
- **Checklists:** store setup per channel; tax and sales-tax basics; returns
  and shipping policies.
- **Workspace:** Pricing ★ · persona ★ · surveys ○ · Lean Canvas ○ · business
  plan ○ · Tax ★.

### 🔧 Physical product
*Subpaths: home & kitchen, apparel, beauty, outdoor, electronics.*

- **North star:** before launch, the **development stage** (concept → prototype
  → samples → first production run); after launch, **units sold** and margin.
- **Stages:** Just an idea → sketches → prototype → samples from a manufacturer
  → selling → in shops.
- **Working tools**
  - **Development tracker** — stage gates with what "done" means at each.
  - **Bill of materials & unit cost** — parts, packaging, landed cost (freight,
    duty), cost at different order quantities.
  - **Manufacturer comparison** — quote, minimum order, lead time, sample
    status, communication score.
  - **Retail vs. wholesale pricing** — keystone check: can you sell at half
    retail and still make money?
  - **Pre-order / crowdfunding tracker** — target, backers, pledged.
  - **Retailer pipeline** — shops approached → samples sent → ordering.
- **Checklists:** compliance and certification by category (cosmetics,
  electronics, children's products); IP basics; packaging and labelling.
- **Workspace:** Business Model Canvas ★ · persona ★ · surveys ★ (demand
  before tooling) · business plan ★ (financing a run) · Pricing ★ · Lean ○.

### ⌨️ Apps & Software
*Subpaths: B2B software, consumer app, mobile, extension, AI tool, marketplace.*

- **North star:** **paying customers / monthly recurring revenue**; before
  that, **waitlist sign-ups** and **active users**.
- **Stages:** Just an idea → designing → building → live, no users → live with
  users → paying customers.
- **Working tools**
  - **Problem validation** — the Customer Interview tracker ★, with a "would
    pay" count per problem.
  - **Waitlist & beta tracker** — sign-ups by source, beta invites, activation.
  - **MVP scope** — must / should / won't; keeps the first version small.
  - **Feedback & roadmap board** — requests from users, votes, status.
  - **Metrics log** — sign-ups, active users, paying, MRR, churn, monthly.
  - **Pricing tiers planner** — the "$5 × 200 vs $500 × 2" bar, per tier.
  - **Launch checklist** — directories, launch day, onboarding email.
- **Subpath tweaks:** B2B adds a sales pipeline (demo → trial → paid);
  marketplaces track both sides (supply and demand); mobile adds store listing.
- **Workspace:** Lean Canvas ★ · persona ★ · surveys ★ · elevator pitch ★ ·
  idea refiner ★ · business plan ○ · BMC ○.

### 🧭 Still figuring it out
*Subpaths: build an audience, sell a skill, work near home, sell products,
build a product, no idea yet.*

- **North star:** **clarity** — options compared and small experiments run.
  The goal is to leave this path.
- **Stages:** Just curious → serious, no idea yet → weighing a few options →
  ready to commit.
- **Working tools**
  - **Self-inventory** — skills, what energises you, time and money you can put
    in, deal-breakers (the old universal questions, as a worksheet).
  - **Options matrix** — score 2–5 ideas or paths on your own criteria.
  - **Two-week experiments** — hypothesis → smallest test → result → keep or
    drop ("post 5 times", "sell to 3 friends", "price a quote").
  - **Path previews** — each path's dashboard, read-only, so they can see what
    the work looks like before choosing.
- **The graduation moment:** when an option wins, one click moves them to that
  path, carrying their idea, persona and experiments with them.
- **Workspace:** idea refiner ★ · persona ○ · surveys ★ · Lean Canvas ○.

---

## Under the hood — one set of building blocks

Ten dashboards are ten **configurations** of seven reusable pieces, not ten
apps:

| Building block | What it is | Used by |
|---|---|---|
| **Pipeline** | stages + cards with value, date, notes | content pipeline, clients, calls, jobs, brand deals, sites, manufacturers, retailers, funding, beta, roadmap |
| **Metric log** | named numbers logged per period, with a trend | every north star and supporting number |
| **Checklist** | template defined in code, ticks stored per member, optional expiry dates | licences, launch, opening, compliance |
| **Worksheet** | structured sections saved as one document | canvases, persona, plan, pitch, idea refiner, offer builder, MVP scope, self-inventory |
| **Calculator** | inputs → outputs, saved scenarios | break-even, unit cost, rate, pricing tiers (Pricing tool already is one) |
| **Comparison matrix** | options × criteria with weights | site scout, manufacturer comparison, options matrix |
| **Calendar view** | items with dates on a month grid | content calendar, jobs, opening plan |

Data: four new tables (`workspace_docs` for worksheets, `pipeline_items`,
`metric_entries`, `checklist_progress`), each owned by the member with the
usual row policies, plus `profiles.subpath` (exists) and `profiles.path_answers`
(new) for setup. Path configs live in `src/path_dashboards/<path>.js` — north
star, stages, setup questions, featured tools, boards and their stages,
checklists, starter tasks, subpath overrides — and one dashboard view renders
whichever config the member has. Tailoring is then a matter of editing a
config, and the private cohorts in Phase 3 can ask for any worksheet or board
as a submission.

No AI anywhere: the "idea refiner" and every tool are structured worksheets
and arithmetic.

---

## Build order (proposal)

1. **Foundations** — the seven building blocks, the four tables, path setup
   (subpath + key questions right after choosing a path, and on the dashboard
   for members with none), the shared workspace worksheets (both canvases,
   persona, plan, pitch, idea refiner, goals, milestones), and the survey maker.
2. **First three dashboards** — the paths members are already on and that differ
   most: **creator**, **freelancer**, **software** (and **exploring**, which is
   small and has 2 members).
3. **The next four** — consultant, local service, online store, physical
   product.
4. **Brick and mortar** — the largest config (site scout, opening plan, funding,
   break-even).
5. Then Phase 3 (private cohorts, assignments and submissions) on top.

Each step is its own PR, reviewed before the next.

## Decisions for Dillon

1. **Featured, not fenced:** a path decides what is on the dashboard, but every
   tool stays in the library for anyone. (Recommended — people blur the lines.)
2. **One path at a time,** with an easy switch. A second, "also" path can come
   later if members ask.
3. **Setup questions:** ask the subpath plus 3–4 questions right after the path
   is chosen (about a minute), skippable, editable later.
4. **Stages without XP:** show the path's own stage and the next real-world
   milestone (from the ladder gates) — no points.
5. **Build order** as above, or a different first three.
