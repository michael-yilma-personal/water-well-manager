-- Close two privilege-escalation paths in the initial schema.
--
-- Every RLS policy in this database ultimately trusts public.profiles.role via
-- is_admin(). Anything that lets a client choose that value hands out read
-- access to every crew's data.
--
-- 1. handle_new_user() read the role out of raw_user_meta_data, which the
--    client controls completely at signup. Signing up with
--    { "role": "Administrator" } was enough to read the whole database.
--
-- 2. profiles_update_own allowed a user to update their own row with no column
--    restriction, so a driller could simply promote themselves afterwards.
--
-- Roles are now assigned out of band - by an administrator in the dashboard or
-- via SQL - and never by the account holder.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, role, badge_number)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    -- Deliberately ignores any client-supplied role. Elevation is a manual,
    -- out-of-band action.
    'Driller',
    new.raw_user_meta_data ->> 'badge_number'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- RLS policies cannot restrict individual columns, but column privileges can,
-- and the two compose: a user may still edit their display name and badge,
-- while an UPDATE touching `role` is rejected outright.
revoke update (role) on public.profiles from authenticated;
revoke update (role) on public.profiles from anon;
