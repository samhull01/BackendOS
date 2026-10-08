\set ON_ERROR_STOP on
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select public.create_workspace('Hotel A') as a \gset
select set_config('test.hotel_a', :'a',false);
insert into public.hotel_tax_settings(workspace_id) values(:'a');
insert into public.hotel_tax_entries(workspace_id,date,name,thursday_guests,weekend_guests,charged_guests,free_guests)
 values(:'a','2026-10-07','A guest',1.5,2,3,0.5) returning id as entry_a \gset
select set_config('test.entry_a', :'entry_a',false);
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
select public.create_workspace('Hotel B') as b \gset
select set_config('test.hotel_b', :'b',false);
insert into public.hotel_tax_settings(workspace_id,thursday_cost) values(:'b',100);
insert into public.hotel_tax_entries(workspace_id,date,name,thursday_guests,weekend_guests,charged_guests,free_guests)
 values(:'b','2026-10-07','B guest',1,2,3,0);
do $$ declare n int; begin
 if (select count(*) from public.hotel_tax_entries)<>1 or (select name from public.hotel_tax_entries)<>'B guest' then raise exception 'outsider entries leak';end if;
 if (select count(*) from public.hotel_tax_settings)<>1 then raise exception 'outsider rates leak';end if;
 begin insert into public.hotel_tax_entries(workspace_id,date,name,thursday_guests,weekend_guests,charged_guests,free_guests) values(current_setting('test.hotel_a')::uuid,'2026-10-07','Attack',1,0,0,0);raise exception 'outsider insert allowed';exception when insufficient_privilege then null;end;
 begin insert into public.hotel_tax_settings(workspace_id) values(current_setting('test.hotel_a')::uuid);raise exception 'outsider settings insert allowed';exception when insufficient_privilege then null;end;
 update public.hotel_tax_entries set name='Attack' where id=current_setting('test.entry_a')::uuid;get diagnostics n=row_count;if n<>0 then raise exception 'outsider update allowed';end if;
 delete from public.hotel_tax_entries where id=current_setting('test.entry_a')::uuid;get diagnostics n=row_count;if n<>0 then raise exception 'outsider delete allowed';end if;
 begin perform public.restore_hotel_tax(current_setting('test.hotel_a')::uuid,'{}');raise exception 'outsider restore allowed';exception when insufficient_privilege then null;end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
insert into public.workspace_members values(:'a','00000000-0000-0000-0000-000000000002','member');
do $$ begin
 if exists(select 1 from public.hotel_tax_entries where workspace_id=current_setting('test.hotel_b')::uuid) then raise exception 'owner A sees B';end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
insert into public.hotel_tax_entries(workspace_id,date,name,thursday_guests,weekend_guests,charged_guests,free_guests)
 values(:'a','2026-10-08','Member guest',0.5,2,2,0.5);
update public.hotel_tax_entries set name='Member edit' where id=:'entry_a';
do $$ declare n int;begin
 if (select count(*) from public.hotel_tax_entries)<>3 then raise exception 'member read failed';end if;
 if (select name from public.hotel_tax_entries where id=current_setting('test.entry_a')::uuid)<>'Member edit' then raise exception 'member update failed';end if;
 update public.hotel_tax_settings set tax_rate=50 where workspace_id=current_setting('test.hotel_a')::uuid;get diagnostics n=row_count;if n<>0 then raise exception 'member rates edit allowed';end if;
 begin insert into public.hotel_tax_settings(workspace_id) values(current_setting('test.hotel_a')::uuid) on conflict(workspace_id) do update set tax_rate=50;raise exception 'member upsert allowed';exception when insufficient_privilege then null;end;
 delete from public.hotel_tax_entries where workspace_id=current_setting('test.hotel_a')::uuid;get diagnostics n=row_count;if n<>0 then raise exception 'member delete allowed';end if;
 begin update public.hotel_tax_entries set workspace_id=current_setting('test.hotel_b')::uuid where id=current_setting('test.entry_a')::uuid;raise exception 'workspace reassignment allowed';exception when insufficient_privilege then null;end;
 begin update public.hotel_tax_entries set id=gen_random_uuid();raise exception 'entry identity reassignment allowed';exception when insufficient_privilege then null;end;
 begin perform public.restore_hotel_tax(current_setting('test.hotel_a')::uuid,'{}');raise exception 'member restore allowed';exception when insufficient_privilege then null;end;
end $$;
-- B can manage rates in B while being only a Member in A.
update public.hotel_tax_settings set tax_rate=7 where workspace_id=:'b';
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select public.restore_hotel_tax(:'a','{"app":"BackendOS Hotel Tax Calculator","version":2,"settings":{"thursday_cost":200,"weekend_cost":150,"tax_rate":6,"tax_discount":1},"entries":[{"date":"2026-10-09","name":"Restored","thursday_guests":1.5,"weekend_guests":2,"charged_guests":3,"free_guests":0.5}]}');
do $$begin
 if (select count(*) from public.hotel_tax_entries)<>1 or (select name from public.hotel_tax_entries)<>'Restored' then raise exception 'owner restore failed';end if;
 begin perform public.restore_hotel_tax(current_setting('test.hotel_a')::uuid,'{"app":"BackendOS Hotel Tax Calculator","version":2,"settings":{"thursday_cost":999,"weekend_cost":150,"tax_rate":6,"tax_discount":1},"entries":[{"date":"2026-10-09","name":"Bad","thursday_guests":-1,"weekend_guests":2,"charged_guests":3,"free_guests":0}]}');raise exception 'invalid restore allowed';exception when check_violation then null;end;
 if (select thursday_cost from public.hotel_tax_settings)<>200 or (select name from public.hotel_tax_entries)<>'Restored' then raise exception 'restore was not atomic';end if;
 begin perform public.restore_hotel_tax(current_setting('test.hotel_a')::uuid,'{"app":"Hotel Tax Tracker","version":1,"entries":[],"settings":{}}');raise exception 'prototype import allowed';exception when raise_exception then if sqlerrm='prototype import allowed' then raise;end if;end;
 begin update public.hotel_tax_entries set thursday_guests=0.3;raise exception 'invalid fraction allowed';exception when check_violation then null;end;
 begin update public.hotel_tax_settings set tax_rate='NaN';raise exception 'NaN allowed';exception when check_violation then null;end;
end $$;
update public.workspaces set enabled_apps=array['documents'] where id=:'a';
do $$ begin
 if exists(select 1 from public.hotel_tax_entries) or exists(select 1 from public.hotel_tax_settings) then raise exception 'disabled app read';end if;
 begin insert into public.hotel_tax_entries(workspace_id,date,name,thursday_guests,weekend_guests,charged_guests,free_guests) values(current_setting('test.hotel_a')::uuid,'2026-10-07','Disabled',1,0,0,0);raise exception 'disabled app write';exception when insufficient_privilege then null;end;
 begin perform public.restore_hotel_tax(current_setting('test.hotel_a')::uuid,'{}');raise exception 'disabled restore';exception when insufficient_privilege then null;end;
end $$;
update public.workspaces set enabled_apps=array['tax-tracker'] where id=:'a';
delete from public.workspace_members where workspace_id=:'a' and user_id='00000000-0000-0000-0000-000000000002';
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
do $$begin
 if (select count(*) from public.hotel_tax_entries)<>1 or (select name from public.hotel_tax_entries)<>'B guest' then raise exception 'revocation/data isolation failed';end if;
 if (select tax_rate from public.hotel_tax_settings)<>7 or (select thursday_cost from public.hotel_tax_settings)<>100 then raise exception 'B rates affected by A';end if;
 begin insert into public.hotel_tax_entries(workspace_id,date,name,thursday_guests,weekend_guests,charged_guests,free_guests) values(current_setting('test.hotel_a')::uuid,'2026-10-07','Revoked',1,0,0,0);raise exception 'revoked write allowed';exception when insufficient_privilege then null;end;
end $$;
reset role;
set role anon;
do $$begin
 begin perform * from public.hotel_tax_entries;raise exception 'anon entries access';exception when insufficient_privilege then null;end;
 begin perform * from public.hotel_tax_settings;raise exception 'anon settings access';exception when insufficient_privilege then null;end;
 begin perform public.restore_hotel_tax(current_setting('test.hotel_a')::uuid,'{}');raise exception 'anon restore';exception when insufficient_privilege then null;end;
end $$;
\echo 'PASS: Hotel Tax two-user/two-workspace reads and writes, Owner/Member permissions, immutable identity, disabled app, revocation, anonymous denial, atomic restore'
