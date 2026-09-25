# NoBossly

A free community for people working their way out of the 9 to 5: pick a path → take on real-world quests → run sprints → climb a ten-rung ladder with XP, levels, streaks and peer feedback. NoBossly Premium ($3.99/mo, $38.30/yr, or $191.50 lifetime) adds five standalone tools under `/tools`.

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
3. Optional: Stripe → Settings → Billing → Customer portal → activate it, so members can update their card from Account settings.
4. Prices live in the `pricing_tiers` table (edit them at `/admin/pricing`). Stripe Price IDs are optional — checkout charges the amount in the table directly when none is set.
5. Test: buy the monthly plan with a Stripe test key and card `4242 4242 4242 4242`; `/tools` should unlock straight after checkout.
