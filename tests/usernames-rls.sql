\set ON_ERROR_STOP on
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select public.create_workspace('Username A') as a \gset
select set_config('test.username_a', :'a',false);
insert into public.user_profiles values(auth.uid(),'alice');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
select public.create_workspace('Username B') as b \gset
select set_config('test.username_b', :'b',false);
do $$ begin
 begin insert into public.user_profiles values(auth.uid(),'alice');raise exception 'duplicate allowed';exception when unique_violation then null;end;
 begin insert into public.user_profiles values(auth.uid(),'Alice');raise exception 'noncanonical allowed';exception when check_violation then null;end;
end $$;
insert into public.user_profiles values(auth.uid(),'bob');
do $$ begin
 if (select count(*) from public.user_profiles)<>1 then raise exception 'unrelated profiles leaked';end if;
 begin perform public.lookup_workspace_username(current_setting('test.username_a')::uuid,'alice');raise exception 'outsider lookup allowed';exception when insufficient_privilege then null;end;
 begin perform public.add_workspace_member_by_username(current_setting('test.username_a')::uuid,'bob',auth.uid());raise exception 'self join allowed';exception when insufficient_privilege then null;end;
 begin update public.user_profiles set user_id='00000000-0000-0000-0000-000000000001';raise exception 'profile reassignment';exception when insufficient_privilege then null;end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
do $$ begin
 if (select user_id from public.lookup_workspace_username(current_setting('test.username_a')::uuid,' BOB '))<>'00000000-0000-0000-0000-000000000002'::uuid then raise exception 'exact normalized lookup failed';end if;
 if exists(select 1 from public.lookup_workspace_username(current_setting('test.username_a')::uuid,'bo')) then raise exception 'partial search allowed';end if;
 begin perform public.add_workspace_member_by_username(current_setting('test.username_a')::uuid,'bob',auth.uid());raise exception 'wrong confirmed ID accepted';exception when raise_exception then if sqlerrm='wrong confirmed ID accepted' then raise;end if;end;
end $$;
select public.add_workspace_member_by_username(:'a','BOB','00000000-0000-0000-0000-000000000002');
do $$ begin
 if (select count(*) from public.user_profiles)<>2 then raise exception 'member labels inaccessible';end if;
 update public.user_profiles set username='stolen' where user_id='00000000-0000-0000-0000-000000000002';
 if (select username from public.user_profiles where user_id='00000000-0000-0000-0000-000000000002')<>'bob' then raise exception 'other profile edited';end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
update public.user_profiles set username='robert' where user_id=auth.uid();
do $$ begin
 if not exists(select 1 from public.workspace_members where workspace_id=current_setting('test.username_a')::uuid and user_id=auth.uid()) then raise exception 'rename lost membership';end if;
 begin perform public.lookup_workspace_username(current_setting('test.username_a')::uuid,'alice');raise exception 'Member lookup allowed';exception when insufficient_privilege then null;end;
 begin perform public.add_workspace_member_by_username(current_setting('test.username_a')::uuid,'alice','00000000-0000-0000-0000-000000000001');raise exception 'Member add allowed';exception when insufficient_privilege then null;end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
delete from public.workspace_members where workspace_id=:'a' and user_id='00000000-0000-0000-0000-000000000002';
do $$ begin
 if (select count(*) from public.user_profiles)<>1 then raise exception 'revoked labels still visible';end if;
 begin perform public.add_workspace_member_by_username(current_setting('test.username_a')::uuid,'bob','00000000-0000-0000-0000-000000000002');raise exception 'stale name accepted';exception when raise_exception then if sqlerrm='stale name accepted' then raise;end if;end;
end $$;
reset role;
set role anon;
do $$ begin
 begin perform * from public.user_profiles;raise exception 'anon profiles';exception when insufficient_privilege then null;end;
 begin perform public.lookup_workspace_username(current_setting('test.username_a')::uuid,'alice');raise exception 'anon lookup';exception when insufficient_privilege then null;end;
 begin perform public.add_workspace_member_by_username(current_setting('test.username_a')::uuid,'alice','00000000-0000-0000-0000-000000000001');raise exception 'anon add';exception when insufficient_privilege then null;end;
end $$;
\echo 'PASS: unique usernames, private profiles, Owner-only exact lookup and membership, rename safety, revocation, anonymous denial'
