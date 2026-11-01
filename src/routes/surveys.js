// The survey maker. A member builds a survey, shares a link that anyone can
// answer without an account, and reads the results here: a count, a chart per
// question, every written answer, and a CSV.
//
// The rules live in the database (migrations/2026-11-01_workspace_foundations.sql):
// a survey is visible only to its creator, and answers go in only through
// survey_submit(), which checks each one and allows one per visitor. The shape
// of a question lives in src/surveys.js. This file wires the two together.
//
// `router` is mounted at /surveys behind requireAuth; `publicRouter` at /s for
// anyone, signed in or not.
const crypto = require('crypto');
const express = require('express');
const supa = require('../supabase');
const { cookieOpts } = require('../middleware/auth');
const S = require('../surveys');

const router = express.Router();
const publicRouter = express.Router();
const enc = encodeURIComponent;

const SITE = () => (process.env.SITE_URL || 'https://nobossly.com').replace(/\/+$/, '');
const shareUrl = code => (code ? SITE() + '/s/' + code : null);

const STATUS = { draft: 'Draft', active: 'Open', closed: 'Closed', archived: 'Archived' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLS = 'id, title, description, questions, status, deadline, response_count, max_responses, share_code, created_at, updated_at';
// The results page shows this many written answers per question; the CSV has
// the rest.
const TEXT_CAP = 200;

// Until the migration is applied the new columns and functions are not there
// (and the old status check refuses 'draft'); say so instead of failing.
const notReady = err => !!err && (
  ['42P01', '42703', '42883', 'PGRST202', 'PGRST204', 'PGRST205'].includes(err.code) ||
  /does not exist|Could not find|surveys_status_check/i.test(err.message || ''));

const notFound = res => res.status(404).render('error', { title: 'Not found', message: 'That survey is gone, or it is not yours.' });

// Row policy already limits a member to their own surveys, except that admins
// can read every survey — so the creator check is repeated here, and the
// builder never shows an admin someone else's survey as if it were theirs.
async function load(req, id) {
  if (!UUID.test(String(id || ''))) return { survey: null };
  const { data, error } = await req.sb.from('surveys').select(COLS).eq('id', id).eq('creator_id', req.user.id).maybeSingle();
  if (data && !Array.isArray(data.questions)) data.questions = [];
  return { survey: data || null, error };
}

// Every response, newest first, a page at a time (the API returns at most a
// thousand rows per request; a survey can take ten thousand).
async function allResponses(sb, surveyId, cap) {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; from < cap; from += PAGE) {
    const { data, error } = await sb.from('survey_responses').select('id, answers, created_at')
      .eq('survey_id', surveyId).order('created_at', { ascending: false }).range(from, Math.min(from + PAGE, cap) - 1);
    if (error) return { error, responses: out };
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return { responses: out };
}

// ---------------------------------------------------------------------------
// The list and a new survey.

router.get('/', async (req, res, next) => {
  try {
    const show = STATUS[req.query.show] ? req.query.show : '';
    let q = req.sb.from('surveys').select('id, title, status, deadline, response_count, max_responses, share_code, created_at, updated_at')
      .eq('creator_id', req.user.id).order('created_at', { ascending: false }).limit(200);
    if (show) q = q.eq('status', show);
    else q = q.neq('status', 'archived');
    const { data, error } = await q;
    const base = { title: 'Surveys', show, STATUS, shareUrl, msg: req.query.msg || null };
    if (notReady(error)) return res.render('surveys/index', Object.assign(base, { notReady: true, surveys: [] }));
    res.render('surveys/index', Object.assign(base, { notReady: false, surveys: data || [] }));
  } catch (e) { next(e); }
});

router.get('/new', (req, res) => {
  res.render('surveys/new', { title: 'New survey', LIMITS: S.LIMITS });
});

router.post('/', async (req, res, next) => {
  try {
    const title = String(req.body.title || '').trim().slice(0, S.LIMITS.title);
    const description = String(req.body.description || '').trim().slice(0, S.LIMITS.description);
    if (!title) return res.redirect('/surveys/new?err=' + enc('Give your survey a title.'));
    // Start with one question so the builder is never a blank page. Written
    // inline so test/schema-drift.js can check these columns and the status.
    const { data, error } = await req.sb.from('surveys').insert({
      creator_id: req.user.id, title, description: description || null, status: 'draft',
      questions: [S.newQuestion('short_text')], max_responses: S.LIMITS.maxResponses.default
    }).select('id').maybeSingle();
    if (notReady(error)) return res.redirect('/surveys');
    if (error || !data) return res.redirect('/surveys/new?err=' + enc('Could not create the survey. Please try again.'));
    res.redirect('/surveys/' + data.id + '/edit');
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// The builder.
//
// The edit page is one form, and every button on it — save, add a question,
// move, delete, publish — submits the whole form to its own endpoint. So any
// button keeps what the member has typed everywhere else on the page, and it
// all works without JavaScript.

router.get('/:id/edit', async (req, res, next) => {
  try {
    const { survey, error } = await load(req, req.params.id);
    if (notReady(error)) return res.redirect('/surveys');
    if (!survey) return notFound(res);
    res.render('surveys/edit', {
      title: 'Edit: ' + survey.title, survey, STATUS, TYPES: S.TYPES, LIMITS: S.LIMITS, isChoice: S.isChoice,
      locked: survey.response_count > 0, shareUrl: shareUrl(survey.share_code), msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

// The form's pending edits applied to the stored survey. A field missing from
// the form keeps its stored value; a question the form could not accept keeps
// its stored version and says why, so one bad question does not lose the rest.
function pending(survey, body) {
  body = body || {};
  const errors = [];
  const patch = {};
  // Once anyone has answered, a question's type and options stay put, or old
  // answers would be counted against choices they never saw.
  const locked = survey.response_count > 0;

  if (body.title !== undefined) {
    const title = String(body.title).trim().slice(0, S.LIMITS.title);
    if (title) patch.title = title; else errors.push('The survey needs a title.');
  }
  if (body.description !== undefined) patch.description = String(body.description).trim().slice(0, S.LIMITS.description) || null;
  if (body.max_responses !== undefined && String(body.max_responses).trim() !== '') {
    const n = parseInt(body.max_responses, 10);
    const { min, max } = S.LIMITS.maxResponses;
    if (Number.isFinite(n)) patch.max_responses = Math.min(max, Math.max(min, n));
  }
  if (body.deadline !== undefined) {
    const d = String(body.deadline).trim();
    if (!d) patch.deadline = null;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z'))) patch.deadline = d;
    else errors.push('The deadline should be a date.');
  }

  const edits = body.q && typeof body.q === 'object' ? body.q : {};
  const questions = survey.questions.map(q => {
    const e = edits[q.id];
    if (!e || typeof e !== 'object') return q;
    const type = !locked && S.TYPES[e.type] ? e.type : q.type;
    let options = locked || e.options === undefined ? q.options : e.options;
    // Switching to a choice type: start it with two placeholder options.
    if (S.isChoice(type) && !S.isChoice(q.type) && S.cleanOptions(options).length < 2) options = ['Option 1', 'Option 2'];
    const { question, error } = S.cleanQuestion({
      id: q.id, type, options,
      label: e.label !== undefined ? e.label : q.label,
      help: e.help !== undefined ? e.help : q.help,
      required: e.required
    });
    if (error) { errors.push(error + ' The rest was saved.'); return q; }
    return question;
  });
  return { patch, questions, errors };
}

// Save the survey, retrying once if a new share code happens to collide.
async function save(req, survey, patch) {
  const run = p => req.sb.from('surveys').update(p).eq('id', survey.id).eq('creator_id', req.user.id);
  let { error } = await run(patch);
  if (error && error.code === '23505' && patch.share_code) ({ error } = await run(Object.assign({}, patch, { share_code: S.shareCode() })));
  return error;
}

// One builder endpoint: apply the form, then do `action` to the result.
// `action(draft, survey, req)` may change draft.questions and returns any of
// { err, msg, hash, patch }.
const builder = action => async (req, res, next) => {
  try {
    const { survey, error } = await load(req, req.params.id);
    if (notReady(error)) return res.redirect('/surveys');
    if (!survey) return notFound(res);
    const draft = pending(survey, req.body);
    const out = action(draft, survey, req) || {};
    const patch = Object.assign({}, draft.patch, out.patch || {}, {
      questions: S.normalizeQuestions(draft.questions), updated_at: new Date().toISOString()
    });
    const err = await save(req, survey, patch);
    const to = out.to || '/surveys/' + survey.id + '/edit';
    const hash = out.hash ? '#' + out.hash : '';
    if (err) return res.redirect(to + '?err=' + enc(notReady(err) ? 'Surveys are being set up. Check back shortly.' : 'Could not save. Please try again.') + hash);
    const problem = out.err || draft.errors[0];
    if (problem) return res.redirect(to + '?err=' + enc(problem) + hash);
    res.redirect(to + '?msg=' + enc(out.msg || 'Saved.') + hash);
  } catch (e) { next(e); }
};

const at = (draft, qid) => draft.questions.findIndex(q => q.id === qid);

router.post('/:id/meta', builder(() => ({ msg: 'Saved.' })));
router.post('/:id/save', builder(() => ({ msg: 'Saved.' })));

router.post('/:id/questions', builder((draft, survey, req) => {
  if (draft.questions.length >= S.LIMITS.questions) return { err: `A survey can have up to ${S.LIMITS.questions} questions.` };
  const q = S.newQuestion(req.body.type || req.body.add, draft.questions.map(x => x.id));
  draft.questions.push(q);
  return { msg: 'Question added.', hash: 'q-' + q.id };
}));

router.post('/:id/questions/:qid', builder((draft, survey, req) => {
  if (at(draft, req.params.qid) < 0) return { err: 'That question is gone.' };
  return { msg: 'Saved.', hash: 'q-' + req.params.qid };
}));

router.post('/:id/questions/:qid/move', builder((draft, survey, req) => {
  const i = at(draft, req.params.qid);
  if (i < 0) return { err: 'That question is gone.' };
  const j = req.body.dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= draft.questions.length) return { msg: 'Saved.', hash: 'q-' + req.params.qid };
  const [q] = draft.questions.splice(i, 1);
  draft.questions.splice(j, 0, q);
  return { msg: 'Moved.', hash: 'q-' + req.params.qid };
}));

router.post('/:id/questions/:qid/delete', builder((draft, survey, req) => {
  const i = at(draft, req.params.qid);
  if (i < 0) return { err: 'That question is gone.' };
  draft.questions.splice(i, 1);
  return { msg: 'Question deleted.' };
}));

router.post('/:id/publish', builder((draft, survey) => {
  if (!S.normalizeQuestions(draft.questions).length) return { err: 'Add at least one question before you publish.' };
  if (draft.errors.length) return { err: draft.errors[0].replace(' The rest was saved.', '') + ' Fix it, then publish.' };
  return {
    patch: { status: 'active', share_code: survey.share_code || S.shareCode() },
    to: '/surveys/' + survey.id, msg: 'Your survey is open. Share the link below.'
  };
}));

// Open, close and archive change only the status.
const setStatus = (status, msg, check) => async (req, res, next) => {
  try {
    const { survey, error } = await load(req, req.params.id);
    if (notReady(error)) return res.redirect('/surveys');
    if (!survey) return notFound(res);
    const to = '/surveys/' + survey.id;
    const refuse = check && check(survey);
    if (refuse) return res.redirect(to + '?err=' + enc(refuse));
    const to_status = typeof status === 'function' ? status(survey) : status;
    const err = await save(req, survey, { status: to_status, updated_at: new Date().toISOString() });
    if (err) return res.redirect(to + '?err=' + enc('Could not update the survey. Please try again.'));
    res.redirect(to + '?msg=' + enc(typeof msg === 'function' ? msg(to_status) : msg));
  } catch (e) { next(e); }
};

router.post('/:id/close', setStatus('closed', 'Closed. No new answers will be taken.', s => (s.status !== 'active' ? 'Only an open survey can be closed.' : null)));
// A survey that was never published goes back to being a draft.
router.post('/:id/reopen', setStatus(s => (s.share_code ? 'active' : 'draft'), st => (st === 'active' ? 'Reopened. The link takes answers again.' : 'Back to draft.'),
  s => (s.status === 'active' || s.status === 'draft' ? 'This survey is already open.' : s.share_code && !s.questions.length ? 'Add a question first.' : null)));
router.post('/:id/archive', setStatus('archived', 'Archived. Find it under the Archived filter.'));

router.post('/:id/delete', async (req, res, next) => {
  try {
    const { survey, error } = await load(req, req.params.id);
    if (notReady(error)) return res.redirect('/surveys');
    if (!survey) return notFound(res);
    // A draft with no answers goes straight away; anything else could hold
    // answers someone gave, so it needs the confirm box ticked.
    const easy = survey.status === 'draft' && !survey.response_count;
    if (!easy && req.body.confirm !== 'yes') {
      return res.redirect('/surveys/' + survey.id + '?err=' + enc('Tick the box to confirm. Deleting removes the survey and all its answers.'));
    }
    const { error: delErr } = await req.sb.from('surveys').delete().eq('id', survey.id).eq('creator_id', req.user.id);
    if (delErr) return res.redirect('/surveys/' + survey.id + '?err=' + enc('Could not delete the survey. Please try again.'));
    res.redirect('/surveys?msg=' + enc('Survey deleted.'));
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Results and export.

router.get('/:id/export.csv', async (req, res, next) => {
  try {
    const { survey, error } = await load(req, req.params.id);
    if (notReady(error)) return res.redirect('/surveys');
    if (!survey) return notFound(res);
    const { responses, error: rErr } = await allResponses(req.sb, survey.id, S.LIMITS.maxResponses.max);
    if (rErr) return res.redirect('/surveys/' + survey.id + '?err=' + enc('Could not load the answers. Please try again.'));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${S.slug(survey.title)}-responses.csv"`);
    res.set('Cache-Control', 'private, no-store');
    // The byte-order mark tells Excel the file is UTF-8, so accents and emoji
    // in answers open correctly.
    res.send('﻿' + S.toCsv(survey.questions, responses));
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { survey, error } = await load(req, req.params.id);
    if (notReady(error)) return res.redirect('/surveys');
    if (!survey) return notFound(res);
    const { responses, error: rErr } = await allResponses(req.sb, survey.id, S.LIMITS.maxResponses.max);
    const today = new Date().toISOString().slice(0, 10);
    res.render('surveys/results', {
      title: survey.title, survey, STATUS, TYPES: S.TYPES, shareUrl: shareUrl(survey.share_code),
      total: responses.length, summary: S.aggregate(survey.questions, responses), TEXT_CAP,
      loadFailed: !!rErr && !notReady(rErr), pastDeadline: !!survey.deadline && survey.deadline < today,
      msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// The public side: anyone with the link answers, no account needed.

async function publicSurvey(req, code) {
  if (!S.SHARE_CODE_RE.test(String(code || ''))) return { survey: null };
  const sb = req.sb || supa.anonClient();
  const { data, error } = await sb.rpc('survey_public', { p_code: code });
  const survey = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  if (survey && !Array.isArray(survey.questions)) survey.questions = [];
  return { survey, error };
}

// A long-lived random id for this browser. It never leaves the server as-is:
// what the database sees is a per-survey hash of it (S.visitorKey).
const VISITOR_RE = /^[a-f0-9]{64}$/;
function visitorCookie(req, res) {
  const have = req.cookies && req.cookies.nb_visitor;
  if (typeof have === 'string' && VISITOR_RE.test(have)) return have;
  const v = crypto.randomBytes(32).toString('hex');
  res.cookie('nb_visitor', v, cookieOpts(req, { maxAge: 1000 * 60 * 60 * 24 * 365 }));
  return v;
}

const showPublic = (res, status, locals) => res.status(status).render('surveys/public', Object.assign({
  title: 'Survey', notReady: false, survey: null, code: '', values: {}, missingIds: [], problem: null, TYPES: S.TYPES, LIMITS: S.LIMITS
}, locals));

publicRouter.get('/:code', async (req, res, next) => {
  try {
    const { survey, error } = await publicSurvey(req, req.params.code);
    if (notReady(error)) return showPublic(res, 200, { notReady: true });
    if (!survey) return showPublic(res, 404, { title: 'Survey not open' });
    showPublic(res, 200, { title: survey.title, survey, code: req.params.code });
  } catch (e) { next(e); }
});

const PROBLEMS = {
  missing: 'Please answer the questions marked required.',
  invalid: 'Some answers could not be read. Please check them and send again.'
};

publicRouter.post('/:code', async (req, res, next) => {
  try {
    const code = req.params.code;
    const { survey, error } = await publicSurvey(req, code);
    if (notReady(error)) return showPublic(res, 503, { notReady: true });
    if (!survey) return showPublic(res, 404, { title: 'Survey not open' });
    if (survey.status !== 'active') return res.redirect('/s/' + code + '/done?r=closed');

    const answers = S.collectAnswers(survey.questions, req.body);
    const key = S.visitorKey(visitorCookie(req, res), survey.id);
    const sb = req.sb || supa.anonClient();
    const { data: result, error: subErr } = await sb.rpc('survey_submit', { p_code: code, p_answers: answers, p_visitor: key });
    if (notReady(subErr)) return showPublic(res, 503, { notReady: true });

    // Turbo wants a redirect after a successful form post, or a 4xx/5xx page
    // to show in place, so: finished -> the done page; fixable -> the form again.
    if (result === 'ok') return res.redirect('/s/' + code + '/done');
    if (result === 'duplicate' || result === 'closed' || result === 'full') return res.redirect('/s/' + code + '/done?r=' + result);
    const fixable = PROBLEMS[result];
    showPublic(res, fixable ? 422 : 503, {
      title: survey.title, survey, code, values: answers,
      missingIds: result === 'missing' ? S.missingRequired(survey.questions, answers) : [],
      problem: fixable || 'Something went wrong sending your answers. Please try again.'
    });
  } catch (e) { next(e); }
});

const DONE = {
  ok: { head: 'Thank you!', body: 'Your answers were sent.' },
  duplicate: { head: 'You have already answered', body: 'Thanks — your earlier answers are in. Each person can answer once.' },
  closed: { head: 'This survey has closed', body: 'It is no longer taking answers.' },
  full: { head: 'This survey is full', body: 'It has all the answers it was looking for.' }
};

publicRouter.get('/:code/done', async (req, res, next) => {
  try {
    const r = DONE[req.query.r] ? req.query.r : 'ok';
    // The title is a nicety; the page stands without it.
    let surveyTitle = null;
    try { const { survey } = await publicSurvey(req, req.params.code); surveyTitle = survey ? survey.title : null; } catch (_) { /* shown without it */ }
    res.render('surveys/thanks', { title: DONE[r].head, result: r, done: DONE[r], surveyTitle });
  } catch (e) { next(e); }
});

module.exports = { router, publicRouter, _test: { pending, notReady, allResponses, PROBLEMS, DONE } };
