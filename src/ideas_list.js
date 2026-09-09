// The member's drafts, grouped by the Compass run they came out of.
//
// This was inline in the /ideas index route. The list moved onto the Compass
// page — see views/partials/idea_list.ejs for why — so the grouping moved here
// rather than being copied into a second route.
const pathsLib = require('./paths');

const PATH_LABELS = {};
pathsLib.PATHS.forEach(p => { PATH_LABELS[p.slug] = p.label; });

// Newest run first, then the order the advisor returned within that run.
async function forUser(sb, userId, runs) {
  const { data: ideas } = await sb.from('generated_ideas').select('*').eq('user_id', userId)
    .order('created_at', { ascending: false }).order('position', { ascending: true });

  const runMap = {};
  (runs || []).forEach(r => { runMap[r.id] = r; });

  const groups = [];
  const byRun = {};
  (ideas || []).forEach(i => {
    const key = i.questionnaire_id || 'unlinked';
    if (!byRun[key]) {
      const run = runMap[i.questionnaire_id] || null;
      byRun[key] = {
        key,
        runNumber: run ? run.run_number : null,
        pathLabel: run ? (PATH_LABELS[run.founder_path] || '') : '',
        date: i.created_at,
        ideas: []
      };
      groups.push(byRun[key]);
    }
    byRun[key].ideas.push(i);
  });

  return { ideas: ideas || [], groups, showRunHeadings: groups.length > 1 };
}

module.exports = { forUser, PATH_LABELS };
