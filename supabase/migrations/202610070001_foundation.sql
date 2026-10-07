begin;
create schema if not exists backendos_private;
revoke all on schema backendos_private from public;
create table public.workspaces (
 id uuid primary key default gen_random_uuid(), name text not null check(length(trim(name)) between 1 and 80),
 business jsonb not null default '{"email":"","phone":"","address":""}'::jsonb check(jsonb_typeof(business)='object'),
 enabled_apps text[] not null default array['reservations','customers','tax-tracker','documents'] check(enabled_apps <@ array['reservations','customers','tax-tracker','documents']::text[]),
 created_at timestamptz not null default now()
);
create table public.workspace_members (
 workspace_id uuid references public.workspaces on delete cascade not null,
 user_id uuid references auth.users on delete cascade not null,
 role text not null check(role in ('owner','member')), primary key(workspace_id,user_id)
);
create table public.user_preferences (
 user_id uuid primary key references auth.users on delete cascade,
 appearance jsonb not null default '{}' check(jsonb_typeof(appearance)='object')
);
create table public.workspace_homes (
 workspace_id uuid not null, user_id uuid not null,
 shortcuts text[] not null default array['reservations','customers','tax-tracker','documents'] check(shortcuts <@ array['reservations','customers','tax-tracker','documents']::text[]),
 primary key(workspace_id,user_id), foreign key(workspace_id,user_id) references public.workspace_members on delete cascade
);
create index workspace_members_user_idx on public.workspace_members(user_id);
create function backendos_private.has_role(wid uuid, required_role text default null) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.workspace_members where workspace_id=wid and user_id=(select auth.uid()) and (required_role is null or role=required_role));
$$;
revoke all on function backendos_private.has_role(uuid,text) from public;
grant usage on schema backendos_private to authenticated;
grant execute on function backendos_private.has_role(uuid,text) to authenticated;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.user_preferences enable row level security;
alter table public.workspace_homes enable row level security;
create policy workspace_read on public.workspaces for select to authenticated using(backendos_private.has_role(id));
create policy workspace_edit on public.workspaces for update to authenticated using(backendos_private.has_role(id,'owner')) with check(backendos_private.has_role(id,'owner'));
create policy member_read on public.workspace_members for select to authenticated using(backendos_private.has_role(workspace_id));
create policy member_add on public.workspace_members for insert to authenticated with check(role='member' and backendos_private.has_role(workspace_id,'owner'));
create policy member_remove on public.workspace_members for delete to authenticated using(role='member' and backendos_private.has_role(workspace_id,'owner'));
create policy preferences_read on public.user_preferences for select to authenticated using(user_id=(select auth.uid()));
create policy preferences_insert on public.user_preferences for insert to authenticated with check(user_id=(select auth.uid()));
create policy preferences_update on public.user_preferences for update to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
create policy homes_read on public.workspace_homes for select to authenticated using(user_id=(select auth.uid()) and backendos_private.has_role(workspace_id));
create policy homes_insert on public.workspace_homes for insert to authenticated with check(user_id=(select auth.uid()) and backendos_private.has_role(workspace_id));
create policy homes_update on public.workspace_homes for update to authenticated using(user_id=(select auth.uid()) and backendos_private.has_role(workspace_id)) with check(user_id=(select auth.uid()) and backendos_private.has_role(workspace_id));
create function public.create_workspace(workspace_name text) returns uuid
language plpgsql security definer set search_path='' as $$
declare wid uuid;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 insert into public.workspaces(name) values(trim(workspace_name)) returning id into wid;
 insert into public.workspace_members values(wid,auth.uid(),'owner');
 insert into public.workspace_homes(workspace_id,user_id) values(wid,auth.uid());
 return wid;
end;
$$;
revoke all on function public.create_workspace(text) from public,anon;
grant execute on function public.create_workspace(text) to authenticated;
-- Explicit exposure: automatic table exposure is disabled in this project.
revoke all on public.workspaces,public.workspace_members,public.user_preferences,public.workspace_homes from anon,authenticated;
grant usage on schema public to authenticated;
grant select,update on public.workspaces to authenticated;
grant select,insert,delete on public.workspace_members to authenticated;
grant select,insert,update on public.user_preferences,public.workspace_homes to authenticated;
commit;
