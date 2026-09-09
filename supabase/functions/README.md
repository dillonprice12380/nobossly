# Edge functions

These were discovered in production on 2026-09-09 with **no source control at
all** — thirteen live functions, holding service role keys and API keys, and the
only copy of each was inside Supabase. This directory is where they live now.

A `.disabled` file is the original body of a function that has been retired. The
version deployed in its place is a small stub returning `410 Gone` with a note
saying where the behaviour went. Nothing was deleted, so any of them can be put
back by redeploying the `.disabled` file — but read the header first; each one
says what was wrong with it.

## Live and in use

| Function | verify_jwt | Notes |
|---|---|---|
| `ai-proxy` | true | **The only one the application calls.** Every AI request in `src/` goes through it. |
| `stripe-webhook` | false | Correct — Stripe cannot send a JWT. Should verify the Stripe signature instead. Left untouched: it is not known whether Stripe points here or at the app's own `/billing/webhook`, and guessing wrong stops paid access being granted. |
| `task-reminders` | false | Called by pg_cron. Takes no attacker-controlled input and is idempotent per user per day (checked against `email_log`), so being public is self-limiting. |
| `og-prerender` | false | Public by design. |
| `send-email` | **true (changed 2026-09-09)** | Was `verify_jwt: false` with **no auth check anywhere in the body** — an open relay on a verified sending domain. It took the recipient from the request body and sent branded mail from `hello@nobossly.com` to anyone. Its only caller passes the service role key, so requiring a JWT cost nothing. |

## Retired 2026-09-09

All six were dead — the application called none of them — and all six were
reachable by any signed-in member with the public anon key.

| Function | Why |
|---|---|
| `award-xp-and-notify` | `amount` and `milestone_slug` came from the request body and went to `award_xp()` / `check_and_award_milestone()` **with the service role key**. Any signed-in member could POST `{amount: 999999}` and reach Level 10, or clear any rung gate. Revoking EXECUTE on those SQL functions did not close it: `service_role` is not subject to grants. |
| `weekly-brief` | Called the Anthropic API directly with a raw `ANTHROPIC_API_KEY` and performed **no credit check at all**. Callable in a loop by anyone signed in. |
| `ai-cofounder` | OpenAI (`gpt-4o-mini`) on its own `OPENAI_API_KEY` — a second AI provider nobody was watching. Decremented `ai_credits.balance` by hand, bypassing `spend_ai_credits()`. Also inserted into `ai_conversations`, which now has a unique index the coach relies on. |
| `generate-ideas` | The idea generator the product **deliberately retired**. Still live, still able to insert machine-written rows into `generated_ideas` without `source='user'` or a pinned fit test. Read a questionnaire shape that no longer exists. |
| `generate-blueprint` | OpenAI, outside the rail, and it deactivated every existing blueprint for an idea before inserting its own — so calling it could silently replace the member's real work. |
| `generate-sprint-tasks` | OpenAI, outside the rail, writing sprints and tasks with the service role key. |

## Two conventions worth keeping

1. **Never take a quantity from the request body and hand it to a service-role
   write.** Every one of the retired functions did some version of this. Amounts,
   slugs and ids must be derived server-side from what actually happened.
2. **Every AI call goes through `spend_ai_credits()`.** The rail is only worth
   something if nothing routes around it, and five of these did — three on a
   provider the application does not even use.

## Still open

- `stripe-checkout` and `send-welcome-email` are also dead (nothing calls them)
  but carry no AI spend and no data exposure, so they were left alone rather
  than redeployed late in a long session. Retire them the same way when
  convenient.
- Supabase Auth's leaked-password protection is off. That is a dashboard toggle,
  not something a migration can set: Authentication → Policies.
