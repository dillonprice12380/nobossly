-- Link the Premium tiers to the Prices created in the EnRoute Jobs, LLC Stripe
-- account (acct_1UVXYsEbskpSXY6Z, livemode). Supersedes
-- 2026-09-29_premium_stripe_prices_nobossly_account.sql, which pointed at the
-- separate NoBossly account (acct_1UKfmqHBPaeWu07O). Amounts match price_cents.
--
-- Products: "NoBossly Premium" (prod_VX1bSDnpkOjjlW, monthly + annual prices)
--           "NoBossly Premium Lifetime" (prod_VX1bXvaLzcJpIK, one-time price)
-- All carry metadata.brand = nobossly.
--
-- At the time of this change no member had a Stripe subscription or customer,
-- so nothing needs migrating across accounts.
update pricing_tiers set stripe_price_id = 'price_1UVxYeEbskpSXY6ZDSXKdE7K' where key = 'month';    -- $5 / month
update pricing_tiers set stripe_price_id = 'price_1UVxYkEbskpSXY6ZuSwNBq75' where key = 'year';     -- $48 / year
update pricing_tiers set stripe_price_id = 'price_1UVxYeEbskpSXY6ZTReCwzFY' where key = 'lifetime'; -- $200 one-time
