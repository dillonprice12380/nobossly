# NoBossly

AI-powered entrepreneurial platform: founder questionnaire → AI-matched business ideas → launch blueprint → weekly sprints with XP, levels, and streaks.

## Stack
Node.js (Express + EJS) · Supabase (auth + Postgres with RLS) · Anthropic Claude API

## Run locally
1. `npm install`
2. Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`
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
| `STRIPE_SECRET_KEY` | **Must be the EnRoute Jobs, LLC account** (`acct_1SWF2KGYCkHj7ufX`) — that is where the NoBossly products and the Price IDs in `pricing_tiers` live. Unset, checkout tells people payments are being set up; set to another account's key, every catalog Price is unknown and checkout falls back to charging inline on the wrong account |
| `NODE_ENV` | `production` |

Optional — each has a working default, but the feature is degraded without it:

| Var | Default | What you lose |
| --- | --- | --- |
| `SITE_URL` | `https://nobossly.com` | Stripe return URLs and email links point at the wrong host |
| `SUPABASE_SERVICE_ROLE_KEY` | *(none)* | Subscriptions are applied over the anon client instead of a trusted one, and the re-engagement sweep can't read across users. Keep secret |
| `SUB_SYNC_SECRET` | *(none)* | Must match the value in `app_secrets` for subscription sync |
| `RESEND_API_KEY` | *(none)* | No outbound mail is sent at all |
| `EMAIL_FROM` | `NoBossly <hello@nobossly.com>` | — |
| `COOKIE_DOMAIN` | *(none — cookies are host-only)* | Only set this to share a session across subdomains, e.g. `.nobossly.com` for apex + `www`. Host-only is correct otherwise, and is the only thing that works on localhost or staging |
| `PORT` | `3000` | — |

`ANTHROPIC_API_KEY` is **not** an app env var. Every model call goes through the
`ai-proxy` Supabase Edge Function, so the key belongs in the Edge Function
secrets (Supabase Dashboard → Edge Functions → Secrets), not on the web host.

### After deploying
Load `/pricing` and start a monthly checkout. It should quote the 2026/27 launch
price of $6, and the Stripe receipt should read EnRoute Jobs, LLC. If the server
log shows `[billing] Stripe rejected price ...`, the key is for the wrong Stripe
account — the sale still goes through on the inline fallback, but on the wrong books.
