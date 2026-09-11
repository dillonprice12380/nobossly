-- Point pricing_tiers at the NoBossly products/prices created in the
-- EnRoute Jobs, LLC Stripe account (acct_1SWF2KGYCkHj7ufX, livemode).
--
-- The stripe_price_id values previously stored here belonged to a different
-- Stripe account and were rejected at checkout; the markdown had no Price at
-- all and was being quoted through billing.js's inline price_data fallback.
-- Both columns are now real Prices in the account whose secret key the app
-- uses. Nothing was migrated across accounts because nothing needed to be:
-- at the time of this change no member had a Stripe subscription or customer.
--
-- Products: nobossly_escape_{monthly,quarterly,annual,lifetime}
-- Each tier gets a list Price and a 2026/27 launch (50% off) Price.

update pricing_tiers set
  stripe_price_id       = 'price_1UEcKHGYCkHj7ufXDDg0PpJv',  -- $12.00 / month
  promo_stripe_price_id = 'price_1UEcKNGYCkHj7ufXhyR0Wunu'   -- $6.00 / month
where key = 'month';

update pricing_tiers set
  stripe_price_id       = 'price_1UEcKTGYCkHj7ufXdai7mnfQ',  -- $29.00 / 3 months
  promo_stripe_price_id = 'price_1UEcMuGYCkHj7ufXZN514NN8'   -- $14.50 / 3 months
where key = 'quarter';

update pricing_tiers set
  stripe_price_id       = 'price_1UEcMwGYCkHj7ufXLkeHzXsI',  -- $97.00 / year
  promo_stripe_price_id = 'price_1UEcN1GYCkHj7ufXWp7HVpd9'   -- $48.50 / year
where key = 'year';

update pricing_tiers set
  stripe_price_id       = 'price_1UEcN2GYCkHj7ufX43flPTYG',  -- $350.00 one-time
  promo_stripe_price_id = 'price_1UEcN4GYCkHj7ufXhKKLNutr'   -- $175.00 one-time
where key = 'lifetime';
