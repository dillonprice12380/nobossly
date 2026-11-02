\set ON_ERROR_STOP 1
create table _results(n serial, label text, ok bool);
grant all on _results to anon, authenticated; grant usage on sequence _results_n_seq to anon, authenticated;
create function t(label text, cond boolean) returns void language sql as $$ insert into _results(label, ok) values (label, coalesce(cond,false)) $$;
grant execute on function t(text, boolean) to anon, authenticated;
create function fails(sql text) returns boolean language plpgsql as $$ begin execute sql; return false; exception when others then return true; end $$;
grant execute on function fails(text) to anon, authenticated;

-- a = org owner, b = member (doc owner), c = cohort-mate, d = outsider, e = other cohort
insert into profiles(id, username, display_name) values
 ('00000000-0000-0000-0000-00000000000a', 'orgowner', 'Olive'),
 ('00000000-0000-0000-0000-00000000000b', 'owner', 'Bea'),
 ('00000000-0000-0000-0000-00000000000c', 'mate', 'Cal'),
 ('00000000-0000-0000-0000-00000000000d', 'outsider', null),
 ('00000000-0000-0000-0000-00000000000e', 'elsewhere', null);
insert into organizations(id, name, slug) values ('10000000-0000-0000-0000-000000000001', 'EforAll', 'eforall');
insert into org_admins(org_id, user_id, role) values ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'owner');
insert into groups(id, name, slug, owner_id, visibility, join_policy, org_id) values
 ('30000000-0000-0000-0000-000000000001', 'Spring', 'spring', '00000000-0000-0000-0000-00000000000a', 'hidden', 'invite', '10000000-0000-0000-0000-000000000001'),
 ('30000000-0000-0000-0000-000000000002', 'Plain group', 'plain', '00000000-0000-0000-0000-00000000000e', 'public', 'open', null);
insert into group_members(group_id, user_id, role, status) values
 ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'owner', 'active'),
 ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b', 'member', 'active'),
 ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000c', 'member', 'active'),
 ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000e', 'owner', 'active'),
 ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000d', 'member', 'active');
insert into workspace_docs(id, user_id, kind, title, data) values
 ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b', 'business_model_canvas', 'EnRoute', '{"value":"<p>Jobs on the way</p>"}'),
 ('40000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000d', 'lean_canvas', 'Outsider canvas', '{}');

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select t('a cohort member can share', can_share_docs());
select t('candidates are the cohort-mates and the program team, not me', (select array_agg(username order by username) from share_candidates()) = array['mate','orgowner']);
select t('cannot share with someone outside my cohorts', doc_share_member('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000d', null) is null);
select t('cannot share someone else''s document', doc_share_member('40000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000c', null) is null);
select doc_share_member('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000c', 'Have a look') as sid \gset
select t('shares with a cohort-mate', :'sid' <> '');
select t('sharing again reuses the share', doc_share_member('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000c', null) = :'sid');
select t('members cannot write shares directly', fails($$insert into workspace_shares(doc_id, owner_id, recipient_id) values ('40000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000d')$$));
select doc_share_email('40000000-0000-0000-0000-000000000001', 'Mentor@Example.com', null) as tok \gset
select t('an email share returns a long token', :'tok' ~ '^[a-f0-9]{64}$');
select t('the owner sees both shares', (select count(*) from workspace_shares) = 2);
select t('the email is stored lower-case', (select email from workspace_shares where token = :'tok') = 'mentor@example.com');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select t('the recipient sees it in "Shared with you"', (select count(*) from shared_with_me()) = 1 and (select owner from shared_with_me()) = 'Bea');
select t('the recipient can open it, live', shared_doc(:'sid')->'data'->>'value' = '<p>Jobs on the way</p>' and shared_doc(:'sid')->>'note' = 'Have a look');
select t('the recipient still cannot read the document table', (select count(*) from workspace_docs where id = '40000000-0000-0000-0000-000000000001') = 0);
select t('the recipient cannot revoke it', not doc_share_revoke(:'sid'));
select t('the recipient does not see the email share', (select count(*) from workspace_shares) = 1);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select t('outsider (plain group only) cannot share', not can_share_docs() and doc_share_email('40000000-0000-0000-0000-000000000002', 'x@example.com', null) is null);
select t('outsider has no candidates', (select count(*) from share_candidates()) = 0);
select t('outsider cannot open the share by id', shared_doc(:'sid') is null);
select t('outsider sees no shares', (select count(*) from workspace_shares) = 0);

reset role;
set role anon;
select t('the emailed link opens signed out', shared_doc_by_token(:'tok')->>'title' = 'EnRoute');
select t('a wrong token opens nothing', shared_doc_by_token(repeat('a', 64)) is null and shared_doc_by_token('not-a-token') is null);
select t('anon cannot read shares', fails($$select * from workspace_shares$$));
select t('anon cannot share', fails($$select doc_share_email('40000000-0000-0000-0000-000000000001', 'a@b.co', null)$$));
select t('anon cannot call the internal function', fails($$select shared_with_me()$$));

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select t('the owner can turn sharing off', doc_share_revoke(:'sid') and doc_share_revoke((select id from workspace_shares where token = :'tok')));
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select t('after revoking, the recipient cannot open it', shared_doc(:'sid') is null and (select count(*) from shared_with_me()) = 0);
reset role;
select t('after revoking, the link is dead', shared_doc_by_token(:'tok') is null);
update workspace_shares set revoked_at = null, expires_at = now() - interval '1 day' where token = :'tok';
select t('an expired link is dead', shared_doc_by_token(:'tok') is null);
select t('the cohort-mate was notified once, linking to the share', (select count(*) from notifications where user_id = '00000000-0000-0000-0000-00000000000c' and entity_type = 'workspace_shares' and entity_id = :'sid') = 1);
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
do $$ begin for i in 1..19 loop perform doc_share_email('40000000-0000-0000-0000-000000000001', 'p' || i || '@example.com', null); end loop; end $$;
select t('the 21st email share in a day is refused', doc_share_email('40000000-0000-0000-0000-000000000001', 'last@example.com', null) is null);
reset role;
select t('doc_share is an allowed email type', (select pg_get_constraintdef(oid) like '%doc_share%' from pg_constraint where conname = 'email_log_email_type_check'));

select case when ok then '  ✓ ' else '  ✗ ' end || label from _results order by n;
select count(*) filter (where not ok) as failed, count(*) as total from _results;
