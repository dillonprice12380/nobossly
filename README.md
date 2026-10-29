# NoBossly

A free community for people working their way out of the 9 to 5: pick a path → take on real-world quests → run sprints → climb a ten-rung ladder with XP, levels, streaks and peer feedback. NoBossly Premium ($5/mo, $48/yr, or $200 lifetime) adds five standalone tools under `/tools`.

## Stack
Node.js (Express + EJS) · Supabase (auth + Postgres with RLS)

## Run locally
1. `npm install`
2. Copy `.env.example` to `.env` and set the Supabase values
3. `npm start` → http://localhost:3000

## Deploy (Hostinger Node.js hosting)
- Upload the project (without `node_modules`)
- Entry point: `server.js`
- Set the env vars below
- Run `npm install`, then restart the app

### Environment variables

Required — the app will not work without these:

| Var | Notes |
| --- | --- |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | Publishable key |
| `NODE_ENV` | `production` |

Optional — each has a working default, but the feature is degraded without it:

| Var | Default | What you lose |
| --- | --- | --- |
| `SITE_URL` | `https://nobossly.com` | Email links point at the wrong host |
| `STRIPE_SECRET_KEY` | *(none)* | Premium checkout. Unset, checkout says payments are being set up. Use the key for the Stripe account you want paid into |
| `STRIPE_WEBHOOK_SECRET` | *(none)* | Webhook signature check (`whsec_…` from the endpoint in Stripe). Unset, events are still re-fetched from Stripe before use, but unsigned ones aren't rejected |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | *(none)* | PayPal checkout. Unset, no PayPal buttons are shown. From the REST app at developer.paypal.com |
| `PAYPAL_WEBHOOK_ID` | *(none)* | PayPal webhook verification. Unset, the PayPal webhook answers 503 and nothing is granted from it (the return page still works) |
| `PAYPAL_ENV` | live | Set to `sandbox` to use PayPal's sandbox (separate credentials, plans and webhook) |
| `SUB_SYNC_SECRET` | *(none)* | Required for Premium to unlock after payment. Must equal `app_secrets.sub_sync` in the database |
| `SUPABASE_SERVICE_ROLE_KEY` | *(none)* | The re-engagement email sweep can't read across users, and subscriptions are applied over the anon client. Keep secret |
| `RESEND_API_KEY` | *(none)* | No outbound mail is sent at all |
| `EMAIL_FROM` | `NoBossly <hello@nobossly.com>` | — |
| `COOKIE_DOMAIN` | *(none — cookies are host-only)* | Only set this to share a session across subdomains, e.g. `.nobossly.com` for apex + `www`. Host-only is correct otherwise, and is the only thing that works on localhost or staging |
| `PORT` | `3000` | — |

NoBossly has no AI features, so no Anthropic key is needed.

### Premium (Stripe) setup
1. Set `STRIPE_SECRET_KEY` and `SUB_SYNC_SECRET` on the host (see above) and restart.
2. In Stripe → Developers → Webhooks, add an endpoint `https://nobossly.com/billing/webhook` sending
   `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` and `invoice.paid`.
   Copy its signing secret into `STRIPE_WEBHOOK_SECRET` and restart. NoBossly checkouts carry
   `metadata.app = nobossly` and the webhook ignores everything else.
   Use the **EnRoute Jobs, LLC** Stripe account (`acct_1UVXYsEbskpSXY6Z`) — its secret key, its webhook, its Prices. (Premium billing moved there in Oct 2026; the old NoBossly account is no longer charged on.)
3. Optional: Stripe → Settings → Billing → Customer portal → activate it, so members can update their card from Account settings.
4. Prices live in the `pricing_tiers` table (edit them at `/admin/pricing`). Stripe Price IDs are optional — checkout charges the amount in the table directly when none is set.
5. Test: buy the monthly plan with a Stripe test key and card `4242 4242 4242 4242`; `/tools` should unlock straight after checkout.

### Premium (PayPal) setup
PayPal sits beside Stripe: each pricing card has **Pay with Stripe** and **Pay with PayPal**. A member who pays with one is kept on it (the other's button is hidden and refused), so nobody is billed twice. Lifetime is a one-time PayPal order and needs no plan; Monthly and Annual are PayPal subscriptions and each needs a plan.
1. Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_WEBHOOK_ID` on the host (and `PAYPAL_ENV=sandbox` only if testing in the sandbox), then restart.
2. In PayPal, create two billing plans on a product for NoBossly Premium: **$5.00 USD every 1 month** and **$48.00 USD every 1 year**, both with unlimited cycles and no trial, set to Active.
3. At `/admin/pricing`, paste each plan id (`P-…`) into the matching tier's **PayPal plan ID**. Checkout re-reads the plan from PayPal and refuses to sell it if its price, currency or interval differs from the tier, so a wrong plan can never charge the wrong amount.
4. In the PayPal developer dashboard, add a webhook for the same app pointing at `https://nobossly.com/billing/paypal/webhook`, sending `BILLING.SUBSCRIPTION.ACTIVATED`, `.UPDATED`, `.CANCELLED`, `.SUSPENDED`, `.EXPIRED`, `.PAYMENT.FAILED`, `PAYMENT.SALE.COMPLETED`, `CHECKOUT.ORDER.APPROVED` and `PAYMENT.CAPTURE.COMPLETED`. Its id is `PAYPAL_WEBHOOK_ID`.
5. Notes: PayPal charges the listed price with no sales tax added (Stripe adds tax automatically). While a markdown/promo is running on a tier the PayPal button for it is hidden, because a plan has one fixed price. PayPal subscription ids (`I-…`) are stored in `profiles.stripe_subscription_id` beside Stripe's (`sub_…`); the column name is historical. Webhooks and the return page both re-read everything from PayPal and only act on payments whose `custom_id` is `nobossly:<member id>`.
6. Switching plans: a Monthly member sees **Switch to Annual** on `/pricing`. On Stripe the subscription is moved to the annual price at once — the unused part of the month is credited and the year starts today (a declined card changes nothing). On PayPal the member approves a plan change at PayPal, and Premium follows when PayPal applies it (the `BILLING.SUBSCRIPTION.UPDATED` webhook or the return page). Only Monthly to Annual is offered; Lifetime still goes through checkout.
7. Testing with PayPal's sandbox: run a separate copy of the site (for example on a test subdomain) with `PAYPAL_ENV=sandbox`, the sandbox app's `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET`, a sandbox webhook's `PAYPAL_WEBHOOK_ID` pointed at that copy's `/billing/paypal/webhook`, `SITE_URL` set to the copy's address, and the sandbox plan ids in `PAYPAL_SANDBOX_PLAN_MONTH` and `PAYPAL_SANDBOX_PLAN_YEAR`. A sandbox copy ignores the live plan ids stored in `pricing_tiers`, so the live site is never touched. Leave the Stripe variables off the test copy. It shares the live database, so only buy as your own test member.

