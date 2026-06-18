-- 202605010311_profile_on_signup — auto-create a public.profiles row for every
-- new auth user.
--
-- Bug: signing up (supabase.auth.signUp) created an auth.users row but nothing
-- ever inserted the matching public.profiles row, so usernames / is_pro never
-- attached and every "left join public.profiles" came back empty.
--
-- Fix: the standard Supabase handle_new_user trigger. SECURITY DEFINER so the
-- insert bypasses RLS on profiles; idempotent via ON CONFLICT. Covers app
-- sign-ups, OAuth and admin-created users alike. Username defaults to the
-- supplied metadata username, else the email local-part (users can rename later
-- via the existing username RPCs).

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data->>'username', ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), '')
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill: existing users who signed up before this trigger have no profile.
insert into public.profiles (id, username)
select
  u.id,
  coalesce(
    nullif(u.raw_user_meta_data->>'username', ''),
    nullif(split_part(coalesce(u.email, ''), '@', 1), '')
  )
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null
on conflict (id) do nothing;
