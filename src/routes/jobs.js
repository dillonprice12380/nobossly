const router = require('express').Router();

// Poll endpoint for background generation jobs (ideas, blueprints).
// RLS restricts reads to the requesting user's own jobs.
router.get('/:id', async (req, res) => {
  try {
    const { data: job } = await req.sb.from('generation_jobs')
      .select('status, redirect, error')
      .eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (!job) return res.json({ status: 'error', error: 'Job not found — it may have been interrupted by a server restart. Please try again.' });
    res.json(job);
  } catch (e) {
    res.json({ status: 'error', error: 'Could not check job status: ' + e.message });
  }
});

module.exports = router;
