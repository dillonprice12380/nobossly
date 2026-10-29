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
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | *(none)* | PayPal checkout (second way to pay). Unset, the "Pay with PayPal" buttons stay hidden. Needs `SUB_SYNC_SECRET` and `SUPABASE_SERVICE_ROLE_KEY` too |
| `PAYPAL_WEBHOOK_ID` | *(none)* | Id of the PayPal webhook for this app. Unset, every PayPal delivery is refused (fails closed) |
| `PAYPAL_ENV` | `live` | `live` or `sandbox`; must match the credentials |
| `STRIPE_WEBHOOK_SECRET` | *(none)* | Webhook signature check (`whsec_…` from the endpoint in Stripe). Unset, events are still re-fetched from Stripe before use, but unsigned ones aren't rejected |
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
   Use the **NoBossly** Stripe account (`acct_1UKfmqHBPaeWu07O`) — its secret key, its webhook, its Prices.
3. Optional: Stripe → Settings → Billing → Customer portal → activate it, so members can update their card from Account settings.
4. Prices live in the `pricing_tiers` table (edit them at `/admin/pricing`). Stripe Price IDs are optional — checkout charges the amount in the table directly when none is set.
5. Test: buy the monthly plan with a Stripe test key and card `4242 4242 4242 4242`; `/tools` should unlock straight after checkout.

### Premium (PayPal) setup
PayPal is offered beside Stripe: Monthly and Annual are PayPal subscriptions, Lifetime is a one-time PayPal payment.
1. Run `migrations/2026-10-29_paypal_payments.sql` in Supabase **before** deploying (adds the columns and billing functions and stores the two plan IDs).
2. In PayPal create the plans (product "NoBossly Premium"): `$5.00` every 1 month and `$48.00` every 1 year, no trial, no set-up fee. Their IDs live in `pricing_tiers.paypal_plan_id` (edit at `/admin/pricing`). Before every checkout the server re-reads the plan from PayPal and refuses PayPal if it is off or sells a different price/interval.
3. On the PayPal REST app you will use, add a webhook `https://nobossly.com/billing/paypal/webhook` for: `BILLING.SUBSCRIPTION.ACTIVATED`, `.UPDATED`, `.CANCELLED`, `.SUSPENDED`, `.EXPIRED`, `.PAYMENT.FAILED`, `PAYMENT.SALE.COMPLETED`, `PAYMENT.SALE.REFUNDED`, `PAYMENT.SALE.REVERSED`, `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`. Put the app's credentials and the webhook's id in the `PAYPAL_*` variables and restart.
4. Every NoBossly PayPal object carries `custom_id = nobossly:<user id>:<tier>`; anything else on the same PayPal account (EnRoute Jobs) is ignored.
5. A markdown on a subscription tier hides PayPal for that tier (a PayPal plan has one fixed price); cards still get the sale price.
