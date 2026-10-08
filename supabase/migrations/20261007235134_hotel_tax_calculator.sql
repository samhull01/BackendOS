begin;
-- No browser data is migrated. Rates are applied to all entries, as in v5.
create table public.hotel_tax_settings (
 workspace_id uuid primary key references public.workspaces on delete cascade,
 thursday_cost numeric not null default 319.60 check(thursday_cost between 0 and 1000000),
 weekend_cost numeric not null default 282 check(weekend_cost between 0 and 1000000),
 tax_rate numeric not null default 6 check(tax_rate between 0 and 100),
 tax_discount numeric not null default 1 check(tax_discount between 0 and 100)
);
create table public.hotel_tax_entries (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces on delete cascade,
 date date not null check(date between '2000-01-01' and '2100-12-31'),
 name text not null check(length(trim(name)) between 1 and 200),
 thursday_guests numeric not null check(thursday_guests between 0 and 1000000 and mod(thursday_guests,0.5)=0),
 weekend_guests numeric not null check(weekend_guests between 0 and 1000000 and mod(weekend_guests,0.5)=0),
 charged_guests numeric not null check(charged_guests between 0 and 1000000 and mod(charged_guests,0.5)=0),
 free_guests numeric not null check(free_guests between 0 and 1000000 and mod(free_guests,0.5)=0)
);
create index hotel_tax_entries_workspace_date_idx on public.hotel_tax_entries(workspace_id,date,id);
alter table public.hotel_tax_settings enable row level security;
alter table public.hotel_tax_entries enable row level security;
-- Disabled apps retain data but are inaccessible until enabled by the Owner.
create policy hotel_settings_read on public.hotel_tax_settings for select to authenticated
 using(backendos_private.has_role(workspace_id) and exists(select 1 from public.workspaces w where w.id=workspace_id and 'tax-tracker'=any(w.enabled_apps)));
create policy hotel_settings_insert on public.hotel_tax_settings for insert to authenticated
 with check(backendos_private.has_role(workspace_id,'owner') and exists(select 1 from public.workspaces w where w.id=workspace_id and 'tax-tracker'=any(w.enabled_apps)));
create policy hotel_settings_update on public.hotel_tax_settings for update to authenticated
 using(backendos_private.has_role(workspace_id,'owner') and exists(select 1 from public.workspaces w where w.id=workspace_id and 'tax-tracker'=any(w.enabled_apps)))
 with check(backendos_private.has_role(workspace_id,'owner') and exists(select 1 from public.workspaces w where w.id=workspace_id and 'tax-tracker'=any(w.enabled_apps)));
create policy hotel_entries_read on public.hotel_tax_entries for select to authenticated
 using(backendos_private.has_role(workspace_id) and exists(select 1 from public.workspaces w where w.id=workspace_id and 'tax-tracker'=any(w.enabled_apps)));
create policy hotel_entries_insert on public.hotel_tax_entries for insert to authenticated
 with check(backendos_private.has_role(workspace_id) and exists(select 1 from public.workspaces w where w.id=workspace_id and 'tax-tracker'=any(w.enabled_apps)));
create policy hotel_entries_update on public.hotel_tax_entries for update to authenticated
 using(backendos_private.has_role(workspace_id) and exists(select 1 from public.workspaces w where w.id=workspace_id and 'tax-tracker'=any(w.enabled_apps)))
 with check(backendos_private.has_role(workspace_id) and exists(select 1 from public.workspaces w where w.id=workspace_id and 'tax-tracker'=any(w.enabled_apps)));
create policy hotel_entries_delete on public.hotel_tax_entries for delete to authenticated
 using(backendos_private.has_role(workspace_id,'owner') and exists(select 1 from public.workspaces w where w.id=workspace_id and 'tax-tracker'=any(w.enabled_apps)));
revoke all on public.hotel_tax_settings,public.hotel_tax_entries from public,anon,authenticated;
grant select,insert on public.hotel_tax_settings to authenticated;
grant update(thursday_cost,weekend_cost,tax_rate,tax_discount) on public.hotel_tax_settings to authenticated;
grant select,insert,delete on public.hotel_tax_entries to authenticated;
-- Workspace and entry identity cannot be reassigned, even between two owned workspaces.
grant update(date,name,thursday_guests,weekend_guests,charged_guests,free_guests) on public.hotel_tax_entries to authenticated;
-- Atomic replacement: validation or authorization failure rolls back the entire restore.
-- SECURITY INVOKER preserves RLS and explicit grants; no elevated client credentials.
create function public.restore_hotel_tax(target_workspace uuid, backup jsonb) returns void
language plpgsql security invoker set search_path='' as $$
begin
 if not backendos_private.has_role(target_workspace,'owner') or not exists(
  select 1 from public.workspaces where id=target_workspace and 'tax-tracker'=any(enabled_apps)
 ) then raise exception 'Only the Owner of an enabled workspace can restore data' using errcode='42501'; end if;
 if backup->>'app' is distinct from 'BackendOS Hotel Tax Calculator' or backup->>'version' is distinct from '2'
  or jsonb_typeof(backup->'entries') is distinct from 'array' or jsonb_typeof(backup->'settings') is distinct from 'object'
  then raise exception 'Invalid BackendOS backup'; end if;
 if jsonb_array_length(backup->'entries')>10000 then raise exception 'Backup exceeds 10000 entries'; end if;
 -- Serialize restores and rates changes for this workspace.
 perform 1 from public.workspaces where id=target_workspace for update;
 insert into public.hotel_tax_settings(workspace_id,thursday_cost,weekend_cost,tax_rate,tax_discount)
 values(target_workspace,(backup->'settings'->>'thursday_cost')::numeric,(backup->'settings'->>'weekend_cost')::numeric,
  (backup->'settings'->>'tax_rate')::numeric,(backup->'settings'->>'tax_discount')::numeric)
 on conflict(workspace_id) do update set thursday_cost=excluded.thursday_cost,weekend_cost=excluded.weekend_cost,
 tax_rate=excluded.tax_rate,tax_discount=excluded.tax_discount;
 delete from public.hotel_tax_entries where workspace_id=target_workspace;
 insert into public.hotel_tax_entries(workspace_id,date,name,thursday_guests,weekend_guests,charged_guests,free_guests)
 select target_workspace,(x->>'date')::date,x->>'name',(x->>'thursday_guests')::numeric,(x->>'weekend_guests')::numeric,
 (x->>'charged_guests')::numeric,(x->>'free_guests')::numeric from jsonb_array_elements(backup->'entries') x;
end;
$$;
revoke all on function public.restore_hotel_tax(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.restore_hotel_tax(uuid,jsonb) to authenticated;
commit;
