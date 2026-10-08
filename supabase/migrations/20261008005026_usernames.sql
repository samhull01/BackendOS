begin;
create table public.user_profiles (
 user_id uuid primary key references auth.users on delete cascade,
 username text not null unique check(username ~ '^[a-z][a-z0-9_]{2,29}$')
);
alter table public.user_profiles enable row level security;
create policy profiles_read on public.user_profiles for select to authenticated using(
 user_id=(select auth.uid()) or exists(select 1 from public.workspace_members m where m.user_id=user_profiles.user_id and backendos_private.has_role(m.workspace_id))
);
create policy profiles_insert on public.user_profiles for insert to authenticated with check(user_id=(select auth.uid()));
create policy profiles_update on public.user_profiles for update to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
revoke all on public.user_profiles from public,anon,authenticated;
grant select,insert on public.user_profiles to authenticated;
grant update(username) on public.user_profiles to authenticated;
-- The private helper intentionally reads otherwise hidden profiles, but only for
-- an authenticated Owner and one exact normalized username. No email or directory.
create function backendos_private.lookup_username(wid uuid, requested_username text)
returns table(user_id uuid,username text) language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not backendos_private.has_role(wid,'owner') then
  raise exception 'Only workspace Owners can look up usernames' using errcode='42501';
 end if;
 return query select p.user_id,p.username from public.user_profiles p
 where p.username=lower(trim(requested_username));
end;
$$;
revoke all on function backendos_private.lookup_username(uuid,text) from public,anon,authenticated;
grant execute on function backendos_private.lookup_username(uuid,text) to authenticated;
create function public.lookup_workspace_username(target_workspace uuid, requested_username text)
returns table(user_id uuid,username text) language sql stable security invoker set search_path='' as $$
 select * from backendos_private.lookup_username(target_workspace,requested_username);
$$;
revoke all on function public.lookup_workspace_username(uuid,text) from public,anon,authenticated;
grant execute on function public.lookup_workspace_username(uuid,text) to authenticated;
-- Recheck the UUID that the Owner confirmed, so a renamed/reclaimed username
-- cannot cause the confirmation to add a different account.
create function public.add_workspace_member_by_username(target_workspace uuid, requested_username text, expected_user_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare matched_id uuid;
begin
 select user_id into matched_id from backendos_private.lookup_username(target_workspace,requested_username);
 if matched_id is null or matched_id is distinct from expected_user_id then
  raise exception 'Username changed or was not found. Look it up again.';
 end if;
 insert into public.workspace_members(workspace_id,user_id,role) values(target_workspace,matched_id,'member');
end;
$$;
revoke all on function public.add_workspace_member_by_username(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.add_workspace_member_by_username(uuid,text,uuid) to authenticated;
commit;
