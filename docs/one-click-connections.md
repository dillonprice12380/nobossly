# One-click connections: what each needs once

Each "Connect with …" button shows "Coming soon" (with the paste-a-key way
still working) until its two environment variables are set. Register
NoBossly once with each provider, using the redirect URI listed.

| Provider | Where to register | Environment variables | Redirect URI | Ask for |
|---|---|---|---|---|
| WordPress | Nothing to register | none | — | — |
| Supabase | Organization settings → OAuth Apps → Add application | `SUPABASE_OAUTH_CLIENT_ID`, `SUPABASE_OAUTH_CLIENT_SECRET` | `https://nobossly.com/app-data/oauth/supabase/callback` | Projects: Read, Database: Read and write (Supabase only allows queries with write; NoBossly only calls its read-only query endpoint, which runs as a read-only database user) |
| Google (Firebase) | Google Cloud console → APIs & Services → Credentials → OAuth client (Web application); consent screen with the `firebase` scope | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | `https://nobossly.com/app-data/oauth/google/callback` | `https://www.googleapis.com/auth/firebase` (Google reviews this scope; until then up to 100 test users) |
| PlanetScale | Organization settings → OAuth applications | `PLANETSCALE_OAUTH_CLIENT_ID`, `PLANETSCALE_OAUTH_CLIENT_SECRET` | `https://nobossly.com/app-data/oauth/planetscale/callback` | Read databases, read branches, create branch passwords / roles |
| Shopify | Shopify Dev Dashboard → create a public app (needs App Store review before other stores can install) | `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` (optional `SHOPIFY_ALL_ORDERS=1` once Shopify approves read_all_orders) | `https://nobossly.com/budget/connect/shopify/callback`; privacy webhooks to `https://nobossly.com/webhooks/shopify` | `read_orders` |
| Stripe | A Stripe App with OAuth (`stripe apps create`, `stripe_api_access_type: oauth`, `distribution_type: public`), read-only permissions for charges, payment intents and invoices; marketplace review before public install | `STRIPE_APP_CLIENT_ID`, `STRIPE_APP_SECRET_KEY` | `https://nobossly.com/budget/connect/stripe/callback` | read-only charge, payment intent and invoice permissions |
| Admitad | Admitad publisher account → API applications | `ADMITAD_CLIENT_ID`, `ADMITAD_CLIENT_SECRET` | `https://nobossly.com/budget/connect/admitad/callback` | `statistics` |

Already built and waiting on keys from earlier: Square (`SQUARE_APP_ID`,
`SQUARE_APP_SECRET`), Gumroad (`GUMROAD_CLIENT_ID`, `GUMROAD_CLIENT_SECRET`),
banks through Plaid (`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`).

No one-click exists for: impact.com, CJ, Awin, Rakuten, PartnerStack,
ClickBank, Travelpayouts (API keys only), Neon and PayPal (partner programs),
and plain Postgres/MySQL hosts (connection strings).
