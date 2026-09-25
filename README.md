# NoBossly

A free community for people working their way out of the 9 to 5: pick a path → take on real-world quests → run sprints → climb a ten-rung ladder with XP, levels, streaks and peer feedback.

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
| `SUPABASE_SERVICE_ROLE_KEY` | *(none)* | The re-engagement email sweep can't read across users. Keep secret |
| `RESEND_API_KEY` | *(none)* | No outbound mail is sent at all |
| `EMAIL_FROM` | `NoBossly <hello@nobossly.com>` | — |
| `COOKIE_DOMAIN` | *(none — cookies are host-only)* | Only set this to share a session across subdomains, e.g. `.nobossly.com` for apex + `www`. Host-only is correct otherwise, and is the only thing that works on localhost or staging |
| `PORT` | `3000` | — |

NoBossly is free and has no AI features, so no Stripe or Anthropic keys are needed.
