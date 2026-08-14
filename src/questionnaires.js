// A founder can run the questionnaire more than once. Each run is its own row in
// questionnaire_responses; the newest row is the live one, and generated_ideas
// point back at the run they came from via questionnaire_id.

const NEWEST_FIRST = { ascending: false };

async function latest(sb, userId, cols = '*') {
  const { data } = await sb.from('questionnaire_responses').select(cols)
    .eq('user_id', userId).order('created_at', NEWEST_FIRST).limit(1);
  return (data && data[0]) || null;
}

async function latestCompleted(sb, userId, cols = '*') {
  const { data } = await sb.from('questionnaire_responses').select(cols)
    .eq('user_id', userId).eq('completed', true).order('created_at', NEWEST_FIRST).limit(1);
  return (data && data[0]) || null;
}

async function completedCount(sb, userId) {
  const { count } = await sb.from('questionnaire_responses')
    .select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('completed', true);
  return count || 0;
}

async function byId(sb, userId, id) {
  if (!id) return null;
  const { data } = await sb.from('questionnaire_responses').select('*')
    .eq('id', id).eq('user_id', userId).maybeSingle();
  return data || null;
}

async function all(sb, userId, cols = 'id, run_number, founder_path, completed, created_at') {
  const { data } = await sb.from('questionnaire_responses').select(cols)
    .eq('user_id', userId).order('created_at', NEWEST_FIRST);
  return data || [];
}

// Opens a blank run. If the newest run is already blank and unfinished, hand that
// one back instead of piling up empty rows on repeated clicks.
async function startNew(sb, userId) {
  const current = await latest(sb, userId);
  if (current && !current.completed && !current.founder_path) return current;
  const { count } = await sb.from('questionnaire_responses')
    .select('id', { count: 'exact', head: true }).eq('user_id', userId);
  const { data, error } = await sb.from('questionnaire_responses')
    .insert({ user_id: userId, run_number: (count || 0) + 1 }).select().maybeSingle();
  if (error) throw error;
  return data;
}

module.exports = { latest, latestCompleted, completedCount, byId, all, startNew };
