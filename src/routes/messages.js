const router = require('express').Router();
const { fetchOg, firstUrl } = require('../notify');

async function findOrCreateConversation(sb, me, other) {
  const { data: existing } = await sb.from('conversations').select('*')
    .or(`and(participant_a.eq.${me},participant_b.eq.${other}),and(participant_a.eq.${other},participant_b.eq.${me})`)
    .maybeSingle();
  if (existing) return existing;
  const { data: created, error } = await sb.from('conversations')
    .insert({ participant_a: me, participant_b: other, last_message_at: new Date().toISOString() }).select().maybeSingle();
  if (error) throw error;
  return created;
}

async function blockSets(sb, me) {
  const [{ data: mine }, { data: theirs }] = await Promise.all([
    sb.from('user_blocks').select('blocked_id').eq('blocker_id', me),
    sb.from('user_blocks').select('blocker_id').eq('blocked_id', me)
  ]);
  return {
    iBlocked: new Set((mine || []).map(b => b.blocked_id)),
    blockedMe: new Set((theirs || []).map(b => b.blocker_id))
  };
}

router.get('/', async (req, res, next) => {
  try {
    const { data: convos } = await req.sb.from('conversations').select('*')
      .or(`participant_a.eq.${req.user.id},participant_b.eq.${req.user.id}`)
      .order('last_message_at', { ascending: false, nullsFirst: false }).limit(50);
    const { iBlocked, blockedMe } = await blockSets(req.sb, req.user.id);
    const visible = (convos || []).filter(c => {
      const other = c.participant_a === req.user.id ? c.participant_b : c.participant_a;
      return !iBlocked.has(other) && !blockedMe.has(other);
    });
    const otherIds = [...new Set(visible.map(c => c.participant_a === req.user.id ? c.participant_b : c.participant_a))];
    const { data: profiles } = otherIds.length ? await req.sb.from('profiles').select('id, username, display_name').in('id', otherIds) : { data: [] };
    const pmap = {}; (profiles || []).forEach(p => pmap[p.id] = p);
    // previews: last message + unread count per conversation
    const convoIds = visible.map(c => c.id);
    const previews = {}, unread = {};
    if (convoIds.length) {
      const { data: msgs } = await req.sb.from('messages')
        .select('conversation_id, sender_id, content, attachment_name, is_read, created_at')
        .in('conversation_id', convoIds).order('created_at', { ascending: false }).limit(300);
      (msgs || []).forEach(msg => {
        if (!previews[msg.conversation_id]) {
          let text = (msg.content || '').replace(/\s+/g, ' ').trim();
          if (!text && msg.attachment_name) text = '\uD83D\uDCCE ' + msg.attachment_name;
          previews[msg.conversation_id] = { text: text.slice(0, 70) + (text.length > 70 ? '\u2026' : ''), mine: msg.sender_id === req.user.id };
        }
        if (!msg.is_read && msg.sender_id !== req.user.id) unread[msg.conversation_id] = (unread[msg.conversation_id] || 0) + 1;
      });
    }
    res.render('messages/list', { title: 'Messages', convos: visible, pmap, me: req.user.id, previews, unread });
  } catch (e) { next(e); }
});

router.get('/with/:userId', async (req, res, next) => {
  try {
    if (req.params.userId === req.user.id) return res.redirect('/messages');
    const { iBlocked, blockedMe } = await blockSets(req.sb, req.user.id);
    if (iBlocked.has(req.params.userId) || blockedMe.has(req.params.userId)) return res.redirect('/messages');
    const convo = await findOrCreateConversation(req.sb, req.user.id, req.params.userId);
    res.redirect('/messages/c/' + convo.id);
  } catch (e) { next(e); }
});

router.get('/c/:id', async (req, res, next) => {
  try {
    const { data: convo } = await req.sb.from('conversations').select('*').eq('id', req.params.id).maybeSingle();
    if (!convo) return res.redirect('/messages');
    const otherId = convo.participant_a === req.user.id ? convo.participant_b : convo.participant_a;
    const { iBlocked, blockedMe } = await blockSets(req.sb, req.user.id);
    if (iBlocked.has(otherId) || blockedMe.has(otherId)) return res.redirect('/messages');
    const [{ data: msgs }, { data: other }] = await Promise.all([
      req.sb.from('messages').select('*').eq('conversation_id', convo.id).order('created_at').limit(200),
      req.sb.from('profiles').select('id, username, display_name').eq('id', otherId).maybeSingle()
    ]);
    req.sb.from('messages').update({ is_read: true }).eq('conversation_id', convo.id).neq('sender_id', req.user.id).then(() => {});
    res.render('messages/thread', { title: 'Chat with ' + ((other && other.display_name) || 'member'), convo, msgs: msgs || [], other, me: req.user.id });
  } catch (e) { next(e); }
});

router.post('/c/:id', async (req, res, next) => {
  try {
    const content = (req.body.content || '').trim().slice(0, 2000);
    const attachmentUrl = (req.body.attachment_url || '').trim() || null;
    const attachmentName = (req.body.attachment_name || '').trim().slice(0, 120) || null;
    const attachmentType = (req.body.attachment_type || '').trim() === 'image' ? 'image' : (attachmentUrl ? 'file' : null);
    const { data: convo } = await req.sb.from('conversations').select('*').eq('id', req.params.id).maybeSingle();
    if (convo) {
      const otherIdChk = convo.participant_a === req.user.id ? convo.participant_b : convo.participant_a;
      const { iBlocked, blockedMe } = await blockSets(req.sb, req.user.id);
      if (iBlocked.has(otherIdChk) || blockedMe.has(otherIdChk)) return res.redirect('/messages');
    }
    if (convo && (content || attachmentUrl)) {
      let link = {};
      const url = firstUrl(content);
      if (url) {
        const og = await fetchOg(url);
        if (og) link = { link_url: og.url, link_title: og.title, link_image: og.image, link_domain: og.domain };
      }
      await req.sb.from('messages').insert({ conversation_id: convo.id, sender_id: req.user.id, content,
        attachment_url: attachmentUrl, attachment_name: attachmentName, attachment_type: attachmentType, ...link });
      await req.sb.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', convo.id);
      const otherId = convo.participant_a === req.user.id ? convo.participant_b : convo.participant_a;
      await req.sb.rpc('push_notification', { target_user: otherId, ntype: 'message', nmessage: (req.profile.display_name || 'Someone') + ' sent you a message', nentity_type: 'conversations', nentity_id: convo.id }).then(() => {}, () => {});
    }
    res.redirect('/messages/c/' + req.params.id);
  } catch (e) { next(e); }
});

module.exports = router;
