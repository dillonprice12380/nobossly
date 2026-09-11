-- The 2026/27 markdown: half price, for the time being.
--
-- A promotion does not overwrite the list price or its Stripe Price ID. It sits
-- beside them, so the full price and its catalogue ID survive the promotion,
-- and ending it is clearing promo_price_cents rather than retyping four prices
-- from memory and hoping they were right.
--
-- promo_stripe_price_id is deliberately allowed to be null while the amount is
-- set. src/routes/billing.js builds the checkout line item inline from the
-- amount in this table whenever there is no Price ID, so the markdown charges
-- correctly from the moment it is switched on and only gets tidier when the
-- Stripe Price objects are created and pasted in. It also means a wrong ID can
-- never quietly charge the wrong amount: the number on the pricing page and the
-- number in the checkout both come from src/pricing.js offerFor().

alter table pricing_tiers add column if not exists promo_price_cents      integer;
alter table pricing_tiers add column if not exists promo_stripe_price_id  text;
alter table pricing_tiers add column if not exists promo_label            text;
alter table pricing_tiers add column if not exists promo_ends_at          timestamptz;

comment on column pricing_tiers.promo_price_cents is
  'Markdown amount in cents. Null means no markdown — the list price in price_cents applies.';
comment on column pricing_tiers.promo_stripe_price_id is
  'Stripe Price for the markdown. Optional: checkout falls back to an inline price built from promo_price_cents.';
comment on column pricing_tiers.promo_ends_at is
  'When the markdown stops. Null is open-ended, not expired.';

-- 50% off every tier, lifetime included. The end date is left open: this runs
-- "for the time being", and a date nobody chose is a date that expires by
-- surprise on a Saturday.
update pricing_tiers set
  promo_price_cents = price_cents / 2,
  promo_label = '2026/27 launch price — 50% off',
  promo_ends_at = null
where key in ('month', 'quarter', 'year', 'lifetime');
