const router = require('express').Router();

const csvToArr = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);
const arrField = v => Array.isArray(v) ? v : (v ? [v] : []);
const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

const PATHS = ['existing', 'idea', 'exploring'];
const STEPS = 6;

// Step 1 is always the path chooser. Steps 2-6 differ by path.
const FIELDS = {
  existing: {
    2: b => ({
      founder_name: b.founder_name, age_range: b.age_range, work_status: b.work_status,
      location: b.location, industry_field: b.industry_field, credentials: b.credentials,
      skills: csvToArr(b.skills)
    }),
    3: b => ({
      biz_name: b.biz_name, biz_description: b.biz_description, biz_stage: b.biz_stage,
      biz_age: b.biz_age, biz_model: b.biz_model, target_customer: b.target_customer
    }),
    4: b => ({
      biz_revenue_monthly: b.biz_revenue_monthly, biz_trend: b.biz_trend,
      biz_profitability: b.biz_profitability, biz_customer_count: b.biz_customer_count,
      biz_pricing: b.biz_pricing, biz_channels: arrField(b.biz_channels), biz_best_channel: b.biz_best_channel
    }),
    5: b => ({
      biz_whats_working: b.biz_whats_working, biz_whats_stuck: b.biz_whats_stuck,
      biz_growth_blocker: b.biz_growth_blocker, biz_pivot_openness: b.biz_pivot_openness,
      unfair_advantage: b.unfair_advantage, competition_preference: b.competition_preference
    }),
    6: b => ({
      biz_goal_12mo: b.biz_goal_12mo, income_year1: b.income_year1, hours_per_week: b.hours_per_week,
      launch_budget: b.launch_budget, runway: b.runway, risk_tolerance: b.risk_tolerance,
      sales_comfort: num(b.sales_comfort, 3), marketing_comfort: num(b.marketing_comfort, 3),
      motivation: b.motivation
    })
  },
  idea: {
    2: b => ({
      founder_name: b.founder_name, age_range: b.age_range, work_status: b.work_status,
      location: b.location, industry_field: b.industry_field, credentials: b.credentials
    }),
    3: b => ({
      skills: csvToArr(b.skills), superpower: b.superpower, advice_topic: b.advice_topic,
      energizing_work: arrField(b.energizing_work), tech_level: num(b.tech_level, 3),
      unfair_advantage: b.unfair_advantage, existing_assets: b.existing_assets
    }),
    4: b => ({
      idea_description: b.idea_description, idea_stage: b.idea_stage, idea_problem: b.idea_problem,
      idea_customer: b.idea_customer, idea_monetization: b.idea_monetization, idea_why_now: b.idea_why_now
    }),
    5: b => ({
      idea_validation: b.idea_validation, idea_known_competitors: b.idea_known_competitors,
      idea_differentiator: b.idea_differentiator, idea_biggest_unknown: b.idea_biggest_unknown,
      customer_access: b.customer_access, target_customer: b.target_customer,
      competition_preference: b.competition_preference
    }),
    6: b => ({
      launch_budget: b.launch_budget, runway: b.runway, income_year1: b.income_year1,
      hours_per_week: b.hours_per_week, hustle_mode: b.hustle_mode, risk_tolerance: b.risk_tolerance,
      deal_breakers: csvToArr(b.deal_breakers), motivation: b.motivation
    })
  },
  exploring: {
    2: b => ({
      founder_name: b.founder_name, age_range: b.age_range, work_status: b.work_status,
      industry_field: b.industry_field, location: b.location, credentials: b.credentials
    }),
    3: b => ({
      skills: csvToArr(b.skills), hobbies: csvToArr(b.hobbies), superpower: b.superpower,
      passion_topic: b.passion_topic, advice_topic: b.advice_topic, problem_pain: b.problem_pain,
      energizing_work: arrField(b.energizing_work), tech_level: num(b.tech_level, 3),
      existing_assets: b.existing_assets
    }),
    4: b => ({
      work_mode: b.work_mode, team_preference: b.team_preference, ai_stance: b.ai_stance,
      risk_tolerance: b.risk_tolerance, hustle_mode: b.hustle_mode, hours_per_week: b.hours_per_week,
      learning_appetite: b.learning_appetite
    }),
    5: b => ({
      launch_budget: b.launch_budget, runway: b.runway, income_year1: b.income_year1,
      biz_models: arrField(b.biz_models), deal_breakers: csvToArr(b.deal_breakers),
      avoid_industries: b.avoid_industries, ideal_day: b.ideal_day, regret: b.regret,
      biggest_fear: b.biggest_fear
    }),
    6: b => ({
      competition_preference: b.competition_preference, prior_attempts: b.prior_attempts,
      biggest_obstacle: b.biggest_obstacle, target_customer: b.target_customer,
      sales_comfort: num(b.sales_comfort, 3), marketing_comfort: num(b.marketing_comfort, 3),
      success_definition: b.success_definition, motivation: b.motivation
    })
  }
};

// readiness_score is constrained to 1-5 in the database
function readinessScore(q) {
  const path = PATHS.includes(q.founder_path) ? q.founder_path : 'exploring';
  const hasTime = q.hours_per_week && !['<5', '5-10'].includes(q.hours_per_week);
  let pts = 0;
  if (path === 'existing') {
    if (q.biz_revenue_monthly && q.biz_revenue_monthly !== '$0') pts++;
    if (q.biz_customer_count && q.biz_customer_count !== '0') pts++;
    if ((q.biz_channels || []).length >= 2) pts++;
    if (hasTime) pts++;
    if (q.biz_whats_working) pts++;
  } else if (path === 'idea') {
    if (q.idea_validation && q.idea_validation.trim().length > 20) pts++;
    if (q.idea_customer) pts++;
    if (q.launch_budget && q.launch_budget !== '$0') pts++;
    if (hasTime) pts++;
    if (q.customer_access && q.customer_access.startsWith('Yes')) pts++;
  } else {
    if ((q.skills || []).length >= 3) pts++;
    if (q.launch_budget && q.launch_budget !== '$0') pts++;
    if (hasTime) pts++;
    if (q.problem_pain) pts++;
    if (q.prior_attempts && q.prior_attempts !== 'Never started one') pts++;
  }
  return Math.max(1, Math.min(5, 1 + pts));
}

router.get('/', async (req, res) => {
  const step = Math.min(Math.max(parseInt(req.query.step || '1', 10) || 1, 1), STEPS);
  const { data: q } = await req.sb.from('questionnaire_responses').select('*').eq('user_id', req.user.id).maybeSingle();
  const path = q && PATHS.includes(q.founder_path) ? q.founder_path : null;
  if (step > 1 && !path) return res.redirect('/questionnaire?step=1');
  res.render('questionnaire', { title: 'Founder Questionnaire', step, steps: STEPS, path, q: q || {} });
});

router.post('/', async (req, res, next) => {
  try {
    const step = Math.min(Math.max(parseInt(req.body.step, 10) || 1, 1), STEPS);
    const b = req.body;
    let patch = {};

    if (step === 1) {
      const chosen = PATHS.includes(b.founder_path) ? b.founder_path : null;
      if (!chosen) return res.redirect('/questionnaire?step=1');
      patch = { founder_path: chosen, has_idea: chosen === 'exploring' ? 'no' : 'yes' };
    } else {
      const { data: current } = await req.sb.from('questionnaire_responses').select('founder_path').eq('user_id', req.user.id).maybeSingle();
      const path = current && PATHS.includes(current.founder_path) ? current.founder_path : null;
      if (!path) return res.redirect('/questionnaire?step=1');
      patch = FIELDS[path][step](b);
    }

    patch.user_id = req.user.id;
    patch.updated_at = new Date().toISOString();

    const { data: existing } = await req.sb.from('questionnaire_responses').select('id').eq('user_id', req.user.id).maybeSingle();
    if (existing) {
      await req.sb.from('questionnaire_responses').update(patch).eq('id', existing.id);
    } else {
      await req.sb.from('questionnaire_responses').insert(patch);
    }

    if (step < STEPS) return res.redirect('/questionnaire?step=' + (step + 1));

    // Final step: compute readiness, mark complete
    const { data: q } = await req.sb.from('questionnaire_responses').select('*').eq('user_id', req.user.id).maybeSingle();
    await req.sb.from('questionnaire_responses').update({ completed: true, readiness_score: readinessScore(q) }).eq('id', q.id);
    await req.sb.from('profiles').update({ onboarding_completed: true, display_name: q.founder_name || undefined }).eq('id', req.user.id);
    res.redirect('/ideas/generate');
  } catch (e) { next(e); }
});

module.exports = router;
