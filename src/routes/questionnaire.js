const router = require('express').Router();

const csvToArr = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);
const arrField = v => Array.isArray(v) ? v : (v ? [v] : []);

const STEPS = 5;

router.get('/', async (req, res) => {
  const step = Math.min(Math.max(parseInt(req.query.step || '1', 10) || 1, 1), STEPS);
  const { data: q } = await req.sb.from('questionnaire_responses').select('*').eq('user_id', req.user.id).maybeSingle();
  res.render('questionnaire', { title: 'Founder Questionnaire', step, steps: STEPS, q: q || {} });
});

router.post('/', async (req, res, next) => {
  try {
    const step = parseInt(req.body.step, 10) || 1;
    const b = req.body;
    let patch = {};
    if (step === 1) patch = {
      founder_name: b.founder_name, age_range: b.age_range, work_status: b.work_status,
      industry_field: b.industry_field, location: b.location, credentials: b.credentials
    };
    if (step === 2) patch = {
      skills: csvToArr(b.skills), hobbies: csvToArr(b.hobbies), superpower: b.superpower,
      passion_topic: b.passion_topic, advice_topic: b.advice_topic, problem_pain: b.problem_pain,
      energizing_work: arrField(b.energizing_work), tech_level: parseInt(b.tech_level, 10) || 3
    };
    if (step === 3) patch = {
      work_mode: b.work_mode, team_preference: b.team_preference, ai_stance: b.ai_stance,
      risk_tolerance: b.risk_tolerance, hustle_mode: b.hustle_mode, hours_per_week: b.hours_per_week
    };
    if (step === 4) patch = {
      launch_budget: b.launch_budget, runway: b.runway, income_year1: b.income_year1,
      has_idea: b.has_idea, idea_description: b.idea_description, biz_models: arrField(b.biz_models),
      deal_breakers: csvToArr(b.deal_breakers), ideal_day: b.ideal_day, regret: b.regret, biggest_fear: b.biggest_fear
    };
    if (step === 5) patch = {
      competition_preference: b.competition_preference, prior_attempts: b.prior_attempts,
      biggest_obstacle: b.biggest_obstacle, target_customer: b.target_customer,
      sales_comfort: parseInt(b.sales_comfort, 10) || 3, marketing_comfort: parseInt(b.marketing_comfort, 10) || 3,
      motivation: b.motivation
    };
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
    // readiness_score is constrained to 1-5 in the database
    let pts = 0;
    if (q.skills && q.skills.length >= 3) pts++;
    if (q.launch_budget && q.launch_budget !== '$0') pts++;
    if (q.hours_per_week && !['<5', '5-10'].includes(q.hours_per_week)) pts++;
    if (q.has_idea === 'yes' || q.problem_pain) pts++;
    if (q.prior_attempts && q.prior_attempts !== 'Never started one') pts++;
    const score = Math.max(1, Math.min(5, 1 + pts));
    await req.sb.from('questionnaire_responses').update({ completed: true, readiness_score: score }).eq('id', q.id);
    await req.sb.from('profiles').update({ onboarding_completed: true, display_name: q.founder_name || undefined }).eq('id', req.user.id);
    res.redirect('/ideas/generate');
  } catch (e) { next(e); }
});

module.exports = router;
