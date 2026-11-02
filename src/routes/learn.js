// Taking a course: the outline with your progress, each lesson, and marking
// lessons done. Lessons are readable by enrolled members and the course's
// team only (row-level security in migrations/2026-11-03_marketplace.sql).
const router = require('express').Router();
const mk = require('../marketplace');
const { WORKSHEETS } = require('../workspace/worksheets');
const richtext = require('../workspace/richtext');

const enc = encodeURIComponent;
const UUID = /^[0-9a-f-]{36}$/i;

// The course, its modules and lessons in order, and what you have done. Null
// when you cannot open it (not enrolled, not on its team, or not a course).
async function load(req) {
  if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(req.params.slug)) return null;
  const { data: l, error } = await req.sb.rpc('listing_page', { p_slug: req.params.slug });
  if (error || !l || l.kind !== 'course') return null;
  const learner = l.mine && l.mine.status === 'enrolled';
  if (!learner && !l.team) return { l, locked: true };
  const [{ data: mods }, { data: lessons }, { data: done }] = await Promise.all([
    req.sb.from('course_modules').select('id, title, position, created_at').eq('listing_id', l.id).order('position').order('created_at'),
    req.sb.from('course_lessons').select('id, module_id, title, minutes, position, created_at').eq('listing_id', l.id).order('position').order('created_at'),
    req.sb.from('lesson_progress').select('lesson_id').eq('listing_id', l.id).eq('user_id', req.user.id)
  ]);
  const doneSet = new Set((done || []).map(d => d.lesson_id));
  const modules = (mods || []).map(m => Object.assign({}, m, { lessons: (lessons || []).filter(x => x.module_id === m.id) }));
  const order = modules.flatMap(m => m.lessons);
  return { l, learner, modules, order, doneSet, locked: false };
}

router.get('/:slug', async (req, res, next) => {
  try {
    const c = await load(req);
    if (!c) return res.status(404).render('error', { title: 'Not found', message: 'That course is not available.' });
    if (c.locked) return res.redirect('/programs/' + c.l.slug + '?err=' + enc('Enroll to open the lessons.'));
    const nextLesson = c.order.find(x => !c.doneSet.has(x.id)) || null;
    res.render('learn/course', {
      title: c.l.title, mk, l: c.l, modules: c.modules, done: c.doneSet, total: c.order.length,
      doneCount: c.order.filter(x => c.doneSet.has(x.id)).length, nextLesson, preview: !c.learner, msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

router.get('/:slug/:lesson', async (req, res, next) => {
  try {
    if (!UUID.test(req.params.lesson)) return res.redirect('/learn/' + req.params.slug);
    const c = await load(req);
    if (!c) return res.status(404).render('error', { title: 'Not found', message: 'That course is not available.' });
    if (c.locked) return res.redirect('/programs/' + c.l.slug + '?err=' + enc('Enroll to open the lessons.'));
    const i = c.order.findIndex(x => x.id === req.params.lesson);
    if (i < 0) return res.redirect('/learn/' + c.l.slug);
    const { data: lesson } = await req.sb.from('course_lessons').select('*').eq('id', req.params.lesson).maybeSingle();
    if (!lesson) return res.redirect('/learn/' + c.l.slug);
    const tool = lesson.tool_key && WORKSHEETS[lesson.tool_key] ? { key: lesson.tool_key, def: WORKSHEETS[lesson.tool_key] } : null;
    res.render('learn/lesson', {
      title: lesson.title + ' — ' + c.l.title, mk, l: c.l, modules: c.modules, done: c.doneSet, lesson,
      body: richtext.clean(lesson.body, mk.LIMITS.lesson), embed: mk.embedOf(lesson.video_url), tool,
      prev: c.order[i - 1] || null, next: c.order[i + 1] || null, isDone: c.doneSet.has(lesson.id),
      position: i + 1, total: c.order.length, preview: !c.learner
    });
  } catch (e) { next(e); }
});

// Mark a lesson done (or not done), then carry on.
router.post('/:slug/:lesson/done', async (req, res, next) => {
  try {
    if (!UUID.test(req.params.lesson)) return res.redirect('/learn/' + req.params.slug);
    const c = await load(req);
    if (!c || c.locked || !c.learner) return res.redirect('/learn/' + req.params.slug);
    const i = c.order.findIndex(x => x.id === req.params.lesson);
    if (i < 0) return res.redirect('/learn/' + c.l.slug);
    if (req.body.undo === '1') {
      await req.sb.from('lesson_progress').delete().eq('user_id', req.user.id).eq('lesson_id', req.params.lesson);
      return res.redirect('/learn/' + c.l.slug + '/' + req.params.lesson);
    }
    await req.sb.from('lesson_progress').upsert({ user_id: req.user.id, lesson_id: req.params.lesson, listing_id: c.l.id }, { onConflict: 'user_id,lesson_id', ignoreDuplicates: true });
    const nxt = c.order[i + 1];
    res.redirect(nxt ? '/learn/' + c.l.slug + '/' + nxt.id : '/learn/' + c.l.slug + '?msg=' + enc(c.order.every(x => x.id === req.params.lesson || c.doneSet.has(x.id)) ? 'Course complete. Nicely done.' : 'Lesson done.'));
  } catch (e) { next(e); }
});

module.exports = router;
