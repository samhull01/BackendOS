\set ON_ERROR_STOP on
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select public.create_workspace('A') as a \gset
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
select public.create_workspace('B') as b \gset
-- B owner cannot read A or add themselves to A.
select set_config('test.a', :'a',false);
select set_config('test.b', :'b',false);
do $$ begin
 if (select count(*) from public.workspaces)<>1 then raise exception 'cross-workspace read'; end if;
 begin insert into public.workspace_members values(current_setting('test.a')::uuid,auth.uid(),'member');raise exception 'self-join permitted';exception when insufficient_privilege then null;end;
 begin insert into public.workspace_homes values(current_setting('test.a')::uuid,auth.uid(),array['documents']);raise exception 'outsider home write permitted';exception when insufficient_privilege then null;end;
 if exists(select 1 from public.workspaces where name='A') then raise exception 'A leaked';end if;
end $$;
insert into public.user_preferences values(auth.uid(),'{"theme":"dark"}');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
insert into public.workspace_members values(:'a','00000000-0000-0000-0000-000000000002','member');
insert into public.user_preferences values(auth.uid(),'{"theme":"light"}');
update public.workspaces set name='A updated' where id=:'a';
update public.workspace_homes set shortcuts=array['customers'] where workspace_id=:'a';
do $$ begin
 if (select count(*) from public.user_preferences)<>1 then raise exception 'preferences leak';end if;
 begin insert into public.workspace_members values(current_setting('test.b')::uuid,auth.uid(),'owner');raise exception 'owner escalation';exception when insufficient_privilege then null;end;
 begin update public.user_preferences set user_id='00000000-0000-0000-0000-000000000002';raise exception 'identity reassignment';exception when insufficient_privilege then null;end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
insert into public.workspace_homes values(:'a',auth.uid(),array['documents']);
do $$ declare n int;begin
 if (select count(*) from public.workspaces)<>2 then raise exception 'membership read failed';end if;
 update public.workspaces set name='stolen' where id=current_setting('test.a')::uuid;get diagnostics n=row_count;if n<>0 then raise exception 'member edit permitted';end if;
 delete from public.workspace_members where workspace_id=current_setting('test.a')::uuid;get diagnostics n=row_count;if n<>0 then raise exception 'member deletion permitted';end if;
 begin insert into public.workspace_members values(current_setting('test.a')::uuid,'00000000-0000-0000-0000-000000000003','member');raise exception 'member management permitted';exception when insufficient_privilege then null;end;
 if (select count(*) from public.workspace_homes where workspace_id=current_setting('test.a')::uuid)<>1 then raise exception 'home leak';end if;
 if (select shortcuts from public.workspace_homes where workspace_id=current_setting('test.a')::uuid)<>array['documents'] then raise exception 'personal home failed';end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
delete from public.workspace_members where workspace_id=:'a' and user_id='00000000-0000-0000-0000-000000000002';
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
do $$ begin
 if (select count(*) from public.workspaces)<>1 then raise exception 'revocation failed';end if;
 if exists(select 1 from public.workspace_homes where workspace_id=current_setting('test.a')::uuid) then raise exception 'revoked home retained';end if;
end $$;
reset role;
set role anon;
do $$ begin
 begin perform * from public.workspaces;raise exception 'anonymous read permitted';exception when insufficient_privilege then null;end;
 begin perform public.create_workspace('Anon');raise exception 'anonymous RPC permitted';exception when insufficient_privilege then null;end;
end $$;
\echo 'PASS: two-user/two-workspace RLS, owner restrictions, preferences, homes, revocation, anonymous denial'
