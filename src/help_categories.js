// What members can help with and look for. The same list is checked in the
// database (profiles.help_offer / help_need, help_posts.category in
// migrations/2026-11-01_phase1_public_side.sql), so keep them in step.
const CATEGORIES = [
  { key: 'website',        label: 'Website',            emoji: '🌐' },
  { key: 'marketing_seo',  label: 'Marketing & SEO',    emoji: '📣' },
  { key: 'design',         label: 'Design',             emoji: '🎨' },
  { key: 'legal_finance',  label: 'Legal & finance',    emoji: '⚖️' },
  { key: 'sales',          label: 'Sales',              emoji: '🤝' },
  { key: 'product',        label: 'Product',            emoji: '🧩' },
  { key: 'accountability', label: 'Accountability',     emoji: '⏰' },
  { key: 'other',          label: 'Something else',     emoji: '✨' }
];
const KEYS = CATEGORIES.map(c => c.key);
const label = k => (CATEGORIES.find(c => c.key === k) || { label: k }).label;
const emoji = k => (CATEGORIES.find(c => c.key === k) || { emoji: '' }).emoji;

// The valid keys out of a form's checkboxes, at most eight.
const pick = v => [...new Set([].concat(v || []).map(String).filter(k => KEYS.includes(k)))].slice(0, 8);

module.exports = { CATEGORIES, KEYS, label, emoji, pick };
