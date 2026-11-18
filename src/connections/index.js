// All income-log connections in one place (beside src/stripe_sync.js, which
// stays as it was): which exist, whether NoBossly's side is set up, and the
// background pass that syncs each one every few hours.

const shopify = require('./shopify');
const gumroad = require('./gumroad');
const square = require('./square');
const plaid = require('./plaid');
const affiliates = require('./affiliates');

const EVERY_HOURS = 6;
const PROVIDERS = {
  shopify: { key: 'shopify', label: 'Shopify', emoji: '🛍️', how: 'paste', mod: shopify, ready: () => true, blurb: 'Paid orders from your store.' },
  gumroad: { key: 'gumroad', label: 'Gumroad', emoji: '🎨', how: 'oauth', mod: gumroad, ready: gumroad.configured, blurb: 'Sales, with memberships ticked Recurring.' },
  square: { key: 'square', label: 'Square', emoji: '🟦', how: 'oauth', mod: square, ready: square.configured, blurb: 'Card and in-person payments.' }
};
// Affiliate networks sync through the same pass (src/connections/affiliates).
const AFFILIATES = {};
affiliates.list().forEach(n => { AFFILIATES[n.key] = { key: n.key, label: n.label, emoji: n.emoji, how: 'affiliate', mod: affiliates, ready: () => true, blurb: n.blurb }; });
const ALL = Object.assign({}, PROVIDERS, AFFILIATES);

const due = (row, now) => !row.last_synced_at || now - new Date(row.last_synced_at) > EVERY_HOURS * 3600000;

// The background pass: every connection not synced in the last few hours.
async function runAll(sc, { now = new Date(), limit = 50 } = {}) {
  const out = { payments: 0, imported: 0, banks: 0, bankAdded: 0, errors: 0 };
  const cutoff = new Date(now.getTime() - EVERY_HOURS * 3600000).toISOString();
  const { data: conns, error } = await sc.from('payment_connections')
    .select('id, user_id, provider, status, last_synced_at, synced_through, imported_count, account_label, meta')
    .in('provider', Object.keys(ALL)).or('last_synced_at.is.null,last_synced_at.lt.' + cutoff).limit(limit);
  if (!error) {
    for (const c of conns || []) {
      const p = ALL[c.provider];
      if (!p || !p.ready()) continue;
      const r = await p.mod.sync(sc, c, { now }).catch(e => ({ imported: 0, error: e.message }));
      out.payments++; out.imported += r.imported || 0; if (r.error) out.errors++;
    }
  }
  if (plaid.configured()) {
    const { data: banks, error: bErr } = await sc.from('bank_connections')
      .select('id, user_id, sync_cursor, last_synced_at').or('last_synced_at.is.null,last_synced_at.lt.' + cutoff).limit(limit);
    if (!bErr) {
      for (const b of banks || []) {
        const r = await plaid.sync(sc, b, { now }).catch(e => ({ added: 0, error: e.message }));
        out.banks++; out.bankAdded += r.added || 0; if (r.error) out.errors++;
      }
    }
  }
  return out;
}

module.exports = { EVERY_HOURS, PROVIDERS, AFFILIATES, ALL, affiliates, due, runAll, shopify, gumroad, square, plaid };
