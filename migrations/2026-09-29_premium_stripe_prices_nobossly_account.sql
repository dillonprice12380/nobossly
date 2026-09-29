-- Link the Premium tiers to the Prices in the dedicated NoBossly Stripe
-- account (acct_1UKfmqHBPaeWu07O, livemode). Amounts match price_cents.
update pricing_tiers set stripe_price_id = 'price_1UL1FEHBPaeWu07OGCZopbtO' where key = 'month';    -- $5 / month
update pricing_tiers set stripe_price_id = 'price_1UL1HHHBPaeWu07OMxMSm4u7' where key = 'year';     -- $48 / year
update pricing_tiers set stripe_price_id = 'price_1UL1K1HBPaeWu07Oar0weQMA' where key = 'lifetime'; -- $200 one-time
