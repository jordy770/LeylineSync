-- 202605010312_username_unique — enforce case-insensitive unique usernames and
-- expose an availability check for the sign-up form.

-- 1. Resolve any existing case-insensitive collisions (e.g. email local-parts
--    backfilled by migration 311) before adding the constraint: keep the
--    earliest profile, suffix the rest with a short slice of their id so the
--    unique index can be created without error.
with ranked as (
  select
    id,
    row_number() over (
      partition by lower(username)
      order by updated_at nulls last, id
    ) as rn
  from public.profiles
  where username is not null
)
update public.profiles p
set username = p.username || '_' || substr(replace(p.id::text, '-', ''), 1, 6)
from ranked r
where p.id = r.id and r.rn > 1;

-- 2. Case-insensitive uniqueness, ignoring NULL usernames (multiple NULLs ok).
create unique index if not exists profiles_username_lower_key
  on public.profiles (lower(username))
  where username is not null;

-- 3. Anonymous-callable availability check for the sign-up form. SECURITY
--    DEFINER so it reads past RLS. This is a best-effort pre-check; the unique
--    index above is the real guard against a check-then-insert race.
create or replace function public.is_username_available(p_username text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select not exists (
    select 1
    from public.profiles
    where lower(username) = lower(trim(p_username))
  );
$$;

grant execute on function public.is_username_available(text) to anon, authenticated;
