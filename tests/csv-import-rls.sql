\set ON_ERROR_STOP on
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select public.create_workspace('Import A') as a \gset
select set_config('test.import_a', :'a',false);
select set_config('test.import_entries','[{"date":"2026-10-01","name":"Legacy","thursday_guests":1.5,"weekend_guests":2,"charged_guests":3,"free_guests":0.5},{"date":"2026-10-01","name":" Legacy ","thursday_guests":1.5,"weekend_guests":2,"charged_guests":3,"free_guests":0.5}]',false);
do $$declare r jsonb;begin
 r=public.import_hotel_tax_csv(current_setting('test.import_a')::uuid,current_setting('test.import_entries')::jsonb);
 if r<> '{"imported":1,"skipped":1}'::jsonb then raise exception 'file duplicates not skipped %',r;end if;
 r=public.import_hotel_tax_csv(current_setting('test.import_a')::uuid,current_setting('test.import_entries')::jsonb);
 if r<> '{"imported":0,"skipped":2}'::jsonb then raise exception 'repeat not skipped';end if;
 if exists(select 1 from public.hotel_tax_settings where workspace_id=current_setting('test.import_a')::uuid) then raise exception 'rates unexpectedly changed';end if;
 begin perform public.import_hotel_tax_csv(current_setting('test.import_a')::uuid,'[{"date":"2026-10-02","name":"Good","thursday_guests":1,"weekend_guests":0,"charged_guests":1,"free_guests":0},{"date":"2026-10-03","name":"Bad","thursday_guests":-1,"weekend_guests":0,"charged_guests":1,"free_guests":0}]','{"thursday_cost":100,"weekend_cost":200,"tax_rate":6,"tax_discount":1}');raise exception 'invalid import allowed';exception when raise_exception then if sqlerrm='invalid import allowed' then raise;end if;end;
 if (select count(*) from public.hotel_tax_entries where workspace_id=current_setting('test.import_a')::uuid)<>1 or exists(select 1 from public.hotel_tax_settings where workspace_id=current_setting('test.import_a')::uuid) then raise exception 'partial invalid import';end if;
end $$;
select public.import_hotel_tax_csv(:'a',current_setting('test.import_entries')::jsonb,'{"thursday_cost":100,"weekend_cost":200,"tax_rate":6,"tax_discount":1}');
insert into public.workspace_members values(:'a','00000000-0000-0000-0000-000000000002','member');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
select public.create_workspace('Import B') as b \gset
select set_config('test.import_b', :'b',false);
do $$begin
 begin perform public.import_hotel_tax_csv(current_setting('test.import_a')::uuid,current_setting('test.import_entries')::jsonb);raise exception 'Member import allowed';exception when insufficient_privilege then null;end;
 perform public.import_hotel_tax_csv(current_setting('test.import_b')::uuid,current_setting('test.import_entries')::jsonb);
 if (select count(*) from public.hotel_tax_entries where workspace_id=current_setting('test.import_b')::uuid)<>1 then raise exception 'other workspace duplicate suppressed';end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
do $$begin
 begin perform public.import_hotel_tax_csv(current_setting('test.import_b')::uuid,current_setting('test.import_entries')::jsonb);raise exception 'outsider import allowed';exception when insufficient_privilege then null;end;
 if (select thursday_cost from public.hotel_tax_settings where workspace_id=current_setting('test.import_a')::uuid)<>100 then raise exception 'optional rates failed';end if;
end $$;
update public.workspaces set enabled_apps=array['documents'] where id=:'a';
do $$begin
 begin perform public.import_hotel_tax_csv(current_setting('test.import_a')::uuid,current_setting('test.import_entries')::jsonb);raise exception 'disabled import allowed';exception when insufficient_privilege then null;end;
end $$;
reset role;set role anon;
do $$begin
 begin perform public.import_hotel_tax_csv(current_setting('test.import_a')::uuid,current_setting('test.import_entries')::jsonb);raise exception 'anonymous import';exception when insufficient_privilege then null;end;
end $$;
\echo 'PASS: atomic CSV import, duplicate handling, optional rates, two-workspace separation and Owner/Member/outsider/disabled/anonymous permissions'
