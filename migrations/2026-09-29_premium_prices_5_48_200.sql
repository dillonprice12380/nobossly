-- Premium is $5/month, $48/year (20% off monthly) and $200 once for lifetime.
--
-- Stripe Price IDs are cleared: the old ones belonged to another Stripe
-- account. With no ID, src/routes/billing.js charges price_cents inline, so
-- checkout charges exactly these amounts. Set stripe_price_id at
-- /admin/pricing if catalogue Prices are created later.
update pricing_tiers set price_cents = 500,   stripe_price_id = null, promo_stripe_price_id = null where key = 'month';
update pricing_tiers set price_cents = 4800,  stripe_price_id = null, promo_stripe_price_id = null where key = 'year';
update pricing_tiers set price_cents = 20000, stripe_price_id = null, promo_stripe_price_id = null where key = 'lifetime';
