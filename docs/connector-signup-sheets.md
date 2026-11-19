# Connector sign-up sheets

One sheet per platform: where to sign up, what to paste into each field,
and the settings to add to Hostinger afterwards. Every connector already
works in NoBossly; it switches from "Coming soon" to a working button as soon
as its settings are added and the site restarts.

These are the same for every platform, so copy them when a form asks:

| Field | Value |
|---|---|
| App name | `NoBossly` |
| Website / homepage | `https://nobossly.com` |
| Privacy policy | `https://nobossly.com/privacy` |
| Terms of service | `https://nobossly.com/terms` |
| Support email | the address members already write to |
| Logo | `https://pub-95ede4ca0cce4b26aa322170b1a5b9f1.r2.dev/Site%20Images/N_i8pl8n.png` |
| Short description | `NoBossly is a workspace for people building a business around a job. This connection lets a member see their own numbers in NoBossly. It only reads; it never changes anything.` |

Never paste a secret into a chat or email; it only goes into Hostinger.

---

## 1. Gumroad (quick, no review)

1. Sign up or log in at gumroad.com.
2. Go to **gumroad.com/settings/advanced** → **Applications** → create an application.
3. Fill in:

| Field | Value |
|---|---|
| Application name | `NoBossly` |
| Redirect URI | `https://nobossly.com/budget/connect/gumroad/callback` |
| Icon | the logo above |

4. Copy the **Application ID** and **Application Secret** into Hostinger:

```
GUMROAD_CLIENT_ID     = (Application ID)
GUMROAD_CLIENT_SECRET = (Application Secret)
```

NoBossly asks members for the `view_sales` permission only.

## 2. Square (quick, no review)

1. Sign up at **developer.squareup.com** (free) → **Applications** → **+** to create one named `NoBossly`.
2. Open the app → **OAuth** (switch to **Production** at the top):

| Field | Value |
|---|---|
| Redirect URL | `https://nobossly.com/budget/connect/square/callback` |

3. Copy the **Application ID** and **Application secret** (from the OAuth page, Production) into Hostinger:

```
SQUARE_APP_ID     = (Application ID, starts with sq0idp-)
SQUARE_APP_SECRET = (Application secret, starts with sq0csp-)
```

NoBossly asks for `PAYMENTS_READ` and `MERCHANT_PROFILE_READ` only.

## 3. PlanetScale (quick, no review)

1. Sign up at **planetscale.com** (free) → your organization → **Settings** → **OAuth applications** → **New application**.
2. Fill in:

| Field | Value |
|---|---|
| Name | `NoBossly` |
| Redirect URI | `https://nobossly.com/app-data/oauth/planetscale/callback` |
| Access | read databases, read branches, create branch passwords, create branch roles. Nothing else. |

3. Copy the client ID and secret into Hostinger:

```
PLANETSCALE_OAUTH_CLIENT_ID     = (client ID)
PLANETSCALE_OAUTH_CLIENT_SECRET = (client secret)
```

NoBossly uses the sign-in once, to make its own read-only login on the database the member picks.

## 4. Admitad (quick; Admitad may check the app)

1. Sign up as a publisher at **admitad.com**.
2. In the publisher account: **Settings** → **API** (or **API applications**) → create an application:

| Field | Value |
|---|---|
| Name | `NoBossly` |
| Redirect URI | `https://nobossly.com/budget/connect/admitad/callback` |
| Scope | `statistics` only |

3. Copy the client ID and secret into Hostinger:

```
ADMITAD_CLIENT_ID     = (client ID)
ADMITAD_CLIENT_SECRET = (client secret)
```

## 5. Plaid (banks)

1. Sign up at **dashboard.plaid.com** (free trial, 10 bank connections).
2. **Developers** → **Keys**: copy the **client_id** and the **secret** for the environment you are using.
3. **Developers** → **API** → **Allowed redirect URIs** → add `https://nobossly.com/budget/connect/bank`. (Chase, Bank of America and other big banks log members in on their own site and send them back here.)
4. In Hostinger:

```
PLAID_CLIENT_ID    = (client_id)
PLAID_SECRET       = (secret for that environment)
PLAID_ENV          = sandbox          ← until Plaid approves production, then: production
PLAID_REDIRECT_URI = https://nobossly.com/budget/connect/bank
```

5. To let real members connect real banks, request **Production** access in the Plaid dashboard (product: **Transactions**, country: **US**). Plaid reviews the company and use case first, and charges per connected bank after the free allowance.

## 6. Google (Firebase sign-in)

1. Go to **console.cloud.google.com** and create a project called `NoBossly`.
2. **APIs & Services** → **OAuth consent screen**:

| Field | Value |
|---|---|
| User type | External |
| App name, support email, logo, home page, privacy policy, terms | from the table at the top |
| Authorized domain | `nobossly.com` |
| Scopes | `https://www.googleapis.com/auth/firebase` |
| Scope justification | `NoBossly lists the member's Firebase projects and reads sign-up and last-sign-in times of their app's users, to show user counts in their NoBossly dashboard. It never changes any data.` |

3. **APIs & Services** → **Credentials** → **Create credentials** → **OAuth client ID** → **Web application**:

| Field | Value |
|---|---|
| Name | `NoBossly` |
| Authorized redirect URI | `https://nobossly.com/app-data/oauth/google/callback` |

4. In Hostinger:

```
GOOGLE_OAUTH_CLIENT_ID     = (client ID, ends in .apps.googleusercontent.com)
GOOGLE_OAUTH_CLIENT_SECRET = (client secret)
```

5. While the app is in **Testing**, add up to 100 members by email as test users. To open it to everyone, click **Publish app** and submit for verification. Google asks for a short screen recording of the Connect with Google flow and may take a few weeks. You may also need to verify `nobossly.com` in Google Search Console.

## 7. Shopify

1. Sign up for a free **Shopify Partner** account at **partners.shopify.com**, then open the **Dev Dashboard** and create an app named `NoBossly` (public distribution).
2. Copy its **Client ID** into `connectors/shopify-app/shopify.app.toml` (replace `PASTE-CLIENT-ID-HERE`). That file already holds the URLs, the `read_orders` scope and the required privacy webhooks.
3. From the `connectors/shopify-app` folder, with the Shopify CLI installed: `shopify app deploy`.
4. In Hostinger:

```
SHOPIFY_CLIENT_ID     = (Client ID)
SHOPIFY_CLIENT_SECRET = (Client secret)
```

5. Submit the app for review in the Dev Dashboard (listing: the description and logo above). Until it is approved it installs only on your own development stores; members keep using the paste-a-key way meanwhile.
6. Optional, later: request `read_all_orders` (orders older than 60 days). Once Shopify approves it, add `SHOPIFY_ALL_ORDERS = 1` and the scope `read_orders,read_all_orders` in the toml.

## 8. Stripe

This uses a **Stripe App** (read-only), made from **NoBossly's own Stripe account**. Stripe will not publish a public app from an account with Stripe Connect switched on.

1. Install the Stripe CLI and its apps plugin (`stripe plugin install apps`), and log in to NoBossly's Stripe account with `stripe login`.
2. From the `connectors/stripe-app` folder: `stripe apps upload`. The manifest there already asks for read-only access to charges, payment intents, invoices and subscriptions, with the redirect URL set.
3. In the Stripe Dashboard → **Apps** → **NoBossly** → **Settings**, copy the app's **client ID** (starts with `ca_`).
4. In Hostinger:

```
STRIPE_APP_CLIENT_ID  = (ca_… client ID)
STRIPE_APP_SECRET_KEY = (secret key of the Stripe account the app belongs to)
```

5. Submit the app for Stripe Marketplace review. Until it is approved, the **External test** links in the app's settings work for accounts you invite; members keep using the restricted-key way meanwhile.

---

After adding any of these, restart or redeploy the site, then open the matching
Connect page on NoBossly: the "Coming soon" note is replaced by the button.
