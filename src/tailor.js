// Business classification + elective challenge matching.
//
// Every founder gets classified once against the business_taxonomy table
// (type, industry, customer segment, value prop) using their blueprint, their
// chosen idea, or their questionnaire — whichever is the richest thing they
// have. Electives are then matched from the tailored_challenges pool by tag
// overlap and level band. When the pool runs thin for a founder's profile,
// the AI writes new electives INTO the pool (source='ai'), so every
// generation deepens the database for the next similar founder.
const paths = require('./paths');

const EDGE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '') + '/functions/v1/ai-proxy';

// Compact JSON-out call to the same ai-proxy edge function ai.js uses. Kept
// local so this module is self-contained and ai.js stays untouched.
async function askJSON(token, system, prompt, maxTokens) {
  const r = await fetch(EDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'apikey': process.env.SUPABASE_ANON_KEY },
    body: JSON.stringify({ system: system + ' Respond ONLY with valid JSON. No markdown fences, no commentary.', prompt, max_tokens: maxTokens })
  });
  const raw = await r.text();
  let j = {};
  try { j = raw ? JSON.parse(raw) : {}; } catch (_) { throw new Error('AI response cut off'); }
  if (!r.ok || j.error) throw new Error(j.error || ('AI proxy HTTP ' + r.status));
  let text = String(j.text || '').trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  const start = Math.min(...['[', '{'].map(c => { const i = text.indexOf(c); return i === -1 ? Infinity : i; }));
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  if (start === Infinity || end === -1) throw new Error('AI returned no JSON');
  return JSON.parse(text.slice(start, end + 1));
}

const KINDS = ['business_type', 'industry', 'customer_segment', 'value_prop'];
const PROFILE_COLS = { business_type: 'biz_type', industry: 'biz_industry', customer_segment: 'biz_segment', value_prop: 'biz_value_prop' };

async function taxonomy(sb) {
  const { data } = await sb.from('business_taxonomy').select('kind, slug, label');
  const byKind = { business_type: [], industry: [], customer_segment: [], value_prop: [] };
  (data || []).forEach(t => { if (byKind[t.kind]) byKind[t.kind].push(t); });
  return byKind;
}

// The richest description of what this founder is building, in priority order:
// active blueprint > favorited/first idea > questionnaire business fields.
async function businessBrief(sb, userId) {
  const { data: bp } = await sb.from('blueprints').select('business_name, tagline, positioning, icp_archetype, icp_description, revenue_type, updated_at').eq('user_id', userId).eq('is_active', true).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (bp) {
    return {
      changedAt: bp.updated_at,
      text: `Business: ${bp.business_name || ''} — ${bp.tagline || ''}\nPositioning: ${bp.positioning || ''}\nIdeal customer: ${bp.icp_archetype || ''} — ${bp.icp_description || ''}\nRevenue model: ${bp.revenue_type || ''}`
    };
  }
  const { data: idea } = await sb.from('generated_ideas').select('name, tagline, category, profile_summary, created_at').eq('user_id', userId).order('is_favorited', { ascending: false }).order('position').limit(1).maybeSingle();
  if (idea) {
    return { changedAt: idea.created_at, text: `Business idea: ${idea.name} — ${idea.tagline || ''}\nCategory: ${idea.category || ''}\nSummary: ${idea.profile_summary || ''}` };
  }
  const { data: q } = await sb.from('questionnaire_responses').select('biz_name, biz_description, biz_model, target_customer, industry_field, idea_description, idea_customer, updated_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (q && (q.biz_description || q.idea_description)) {
    return {
      changedAt: q.updated_at,
      text: q.biz_description
        ? `Business: ${q.biz_name || ''} — ${q.biz_description}\nModel: ${q.biz_model || ''}\nServes: ${q.target_customer || ''}\nIndustry background: ${q.industry_field || ''}`
        : `Business idea: ${q.idea_description}\nFirst customer: ${q.idea_customer || ''}\nIndustry background: ${q.industry_field || ''}`
    };
  }
  return null;
}

// Classify (or re-classify when the blueprint changed since last time).
// Returns the profile object with fresh biz_* fields merged in. Never throws —
// an unclassified founder just sees no electives yet.
async function ensureClassified(sb, accessToken, userId, profile) {
  try {
    const brief = await businessBrief(sb, userId);
    if (!brief) return profile;
    const stale = profile.biz_classified_at && brief.changedAt && new Date(brief.changedAt) > new Date(profile.biz_classified_at);
    if (profile.biz_type && !stale) return profile;
    if (!accessToken) return profile;

    const tax = await taxonomy(sb);
    const lists = KINDS.map(k => `${k}: ${tax[k].map(t => t.slug).join(', ')}`).join('\n\n');
    const out = await askJSON(accessToken,
      'You classify businesses against a fixed taxonomy. You always pick the single closest slug from each provided list — never invent slugs, never leave a field blank.',
      `${brief.text}\n\nClassify this business. Choose EXACTLY ONE slug from each list below (copy the slug verbatim):\n\n${lists}\n\nReturn JSON: { "business_type": "...", "industry": "...", "customer_segment": "...", "value_prop": "..." }`,
      500);

    const patch = { biz_classified_at: new Date().toISOString() };
    for (const k of KINDS) {
      const slug = String(out[k] || '').trim();
      if (tax[k].some(t => t.slug === slug)) patch[PROFILE_COLS[k]] = slug;
    }
    if (!patch.biz_type && !profile.biz_type) return profile; // classification came back unusable
    await sb.from('profiles').update(patch).eq('id', userId);
    return { ...profile, ...patch };
  } catch (e) {
    console.error('classify', e.message);
    return profile;
  }
}

const matches = (arr, val) => !arr || !arr.length || (val && arr.includes(val));
const specificity = (c, p) => ['business_types', 'industries', 'customer_segments', 'value_props']
  .reduce((s, dim, i) => s + ((c[dim] || []).length && (c[dim] || []).includes([p.biz_type, p.biz_industry, p.biz_segment, p.biz_value_prop][i]) ? 1 : 0), 0);

// Electives for this founder: pool matches by tag + level, topped up by AI
// when thin. AI top-up is paid-only (it costs money); pool matches are for
// everyone.
async function getElectives(sb, profile, level, { paid, accessToken } = {}) {
  // A declared path beats an AI classification of free text, so a founder with
  // a path gets electives even before they have anything to classify.
  const path = profile.path || null;
  if (!profile.biz_type && !path) return { electives: [], unclassified: true };

  const { data: taken } = await sb.from('user_custom_challenges').select('tailored_id').eq('user_id', profile.id).not('tailored_id', 'is', null);
  const takenSet = new Set((taken || []).map(t => t.tailored_id));

  const { data: pool } = await sb.from('tailored_challenges').select('*')
    .eq('is_active', true).lte('min_level', level).gte('max_level', level).limit(500);

  // A challenge tagged with paths is only for those paths. An untagged one is
  // general and still matched the old way, on classification tags.
  const onPath = c => !c.paths || !c.paths.length || (path && c.paths.includes(path));
  let list = (pool || []).filter(c => !takenSet.has(c.id)
    && onPath(c)
    && matches(c.business_types, profile.biz_type)
    && matches(c.industries, profile.biz_industry)
    && matches(c.customer_segments, profile.biz_segment)
    && matches(c.value_props, profile.biz_value_prop));
  // Path-tagged first: written for exactly this kind of business, and chosen by
  // the founder rather than guessed at.
  const onPathScore = c => (c.paths && c.paths.length && path && c.paths.includes(path)) ? 1 : 0;
  list.sort((a, b) => onPathScore(b) - onPathScore(a)
    || specificity(b, profile) - specificity(a, profile)
    || (a.xp_reward - b.xp_reward));

  if (list.length < 3 && paid && accessToken) {
    try {
      const made = await generateIntoPool(sb, accessToken, profile, level, 4 - list.length + 2);
      list = list.concat(made.filter(c => !takenSet.has(c.id)));
    } catch (e) { console.error('elective generation', e.message); }
  }
  return { electives: list.slice(0, 6), unclassified: false };
}

async function generateIntoPool(sb, accessToken, profile, level, count) {
  const brief = await businessBrief(sb, profile.id);
  const path = profile.path || null;
  const pathDef = path ? paths.get(path) : null;
  // The founder's own answers on their own path — a creator's platform and
  // audience size, a shop's rent ceiling. This is what makes a generated
  // challenge specific rather than generic startup advice.
  const { data: run } = await sb.from('questionnaire_responses').select('*')
    .eq('user_id', profile.id).eq('completed', true)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  const answers = run ? paths.describe(run) : '';
  const items = await askJSON(accessToken,
    'You are NoBossly, a startup execution coach who designs time-boxed challenges that push founders toward real traction. Challenges are concrete, verifiable actions — never vague "work on your mindset" fluff.',
    `${brief ? brief.text + '\n\n' : ''}${pathDef ? 'PATH: ' + pathDef.label + ' — ' + pathDef.blurb + '\n\n' : ''}${answers ? 'THE FOUNDER\'S OWN ANSWERS:\n' + answers + '\n\n' : ''}Founder classification: business type "${profile.biz_type || 'unclassified'}", industry "${profile.biz_industry || 'unknown'}", customers "${profile.biz_segment || 'unknown'}", value prop "${profile.biz_value_prop || 'unknown'}". Founder level: ${level} of 10 (1 = just starting, 10 = scaled).\n\nWrite ${Math.max(2, Math.min(5, count))} time-boxed challenges for a founder on this path at this level. Use their answers to make each one land: the platform they picked, the hours and money they actually have, the deal breakers they named. Never write a challenge that breaks one of their deal breakers. Each must be concrete and verifiable, completable within the suggested days, and phrased so another founder on the same path could also do it — so no references to this founder's brand name. Return a JSON array where each element has: title (short, action-oriented), description (1-2 sentences on the challenge and why it matters), emoji (single emoji), suggested_days (one of 30, 60, 90), xp_reward (integer 50-150).`,
    2000);
  if (!Array.isArray(items) || !items.length) return [];
  const rows = items.slice(0, 5).map(c => ({
    title: String(c.title || 'Challenge').slice(0, 120),
    description: String(c.description || '').slice(0, 400),
    emoji: String(c.emoji || '\ud83c\udfc1').slice(0, 8),
    xp_reward: Math.max(25, Math.min(200, parseInt(c.xp_reward, 10) || 75)),
    suggested_days: [30, 60, 90].includes(parseInt(c.suggested_days, 10)) ? parseInt(c.suggested_days, 10) : 30,
    min_level: Math.max(1, level - 1), max_level: Math.min(10, level + 2),
    business_types: profile.biz_type ? [profile.biz_type] : [],
    industries: profile.biz_industry ? [profile.biz_industry] : [],
    customer_segments: profile.biz_segment ? [profile.biz_segment] : [],
    value_props: profile.biz_value_prop ? [profile.biz_value_prop] : [],
    paths: path ? [path] : [],
    source: 'ai'
  }));
  const { data, error } = await sb.from('tailored_challenges').insert(rows).select();
  if (error) { console.error('pool insert', error.message); return []; }
  return data || [];
}

module.exports = { ensureClassified, getElectives };
