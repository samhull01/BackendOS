begin;
-- User-selected legacy CSV is parsed in the client; the database validates and
-- assigns the target workspace. No browser storage is accessed or migrated.
create function public.import_hotel_tax_csv(target_workspace uuid, entries jsonb, rates jsonb default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare added int;
begin
 if not backendos_private.has_role(target_workspace,'owner') or not exists(select 1 from public.workspaces where id=target_workspace and 'tax-tracker'=any(enabled_apps)) then
  raise exception 'Only the Owner of an enabled workspace can import CSV' using errcode='42501';
 end if;
 if jsonb_typeof(entries) is distinct from 'array' or jsonb_array_length(entries) not between 1 and 10000 then raise exception 'Import must contain 1 to 10000 entries';end if;
 perform 1 from public.workspaces where id=target_workspace for update;
 -- Validate every row, including duplicates, before inserting any rows.
 if exists(select 1 from jsonb_to_recordset(entries) as x(date date,name text,thursday_guests numeric,weekend_guests numeric,charged_guests numeric,free_guests numeric)
 where date is null or date not between '2000-01-01' and '2100-12-31' or name is null or length(trim(name)) not between 1 and 200
 or thursday_guests is null or thursday_guests not between 0 and 1000000 or mod(thursday_guests,0.5)<>0
 or weekend_guests is null or weekend_guests not between 0 and 1000000 or mod(weekend_guests,0.5)<>0
 or charged_guests is null or charged_guests not between 0 and 1000000 or mod(charged_guests,0.5)<>0
 or free_guests is null or free_guests not between 0 and 1000000 or mod(free_guests,0.5)<>0) then raise exception 'Invalid guest entry';end if;
 if rates is not null then
  if jsonb_typeof(rates) is distinct from 'object' then raise exception 'Invalid rates';end if;
  insert into public.hotel_tax_settings(workspace_id,thursday_cost,weekend_cost,tax_rate,tax_discount)
  values(target_workspace,(rates->>'thursday_cost')::numeric,(rates->>'weekend_cost')::numeric,(rates->>'tax_rate')::numeric,(rates->>'tax_discount')::numeric)
  on conflict(workspace_id) do update set thursday_cost=excluded.thursday_cost,weekend_cost=excluded.weekend_cost,tax_rate=excluded.tax_rate,tax_discount=excluded.tax_discount;
 end if;
 insert into public.hotel_tax_entries(workspace_id,date,name,thursday_guests,weekend_guests,charged_guests,free_guests)
 select target_workspace,x.date,trim(x.name),x.thursday_guests,x.weekend_guests,x.charged_guests,x.free_guests
 from (select distinct date,trim(name) as name,thursday_guests,weekend_guests,charged_guests,free_guests from jsonb_to_recordset(entries) as r(date date,name text,thursday_guests numeric,weekend_guests numeric,charged_guests numeric,free_guests numeric)) x
 where not exists(select 1 from public.hotel_tax_entries e where e.workspace_id=target_workspace and e.date=x.date and e.name=trim(x.name) and e.thursday_guests=x.thursday_guests and e.weekend_guests=x.weekend_guests and e.charged_guests=x.charged_guests and e.free_guests=x.free_guests);
 get diagnostics added=row_count;
 return jsonb_build_object('imported',added,'skipped',jsonb_array_length(entries)-added);
end;
$$;
revoke all on function public.import_hotel_tax_csv(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.import_hotel_tax_csv(uuid,jsonb,jsonb) to authenticated;
commit;
