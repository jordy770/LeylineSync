-- Card script authoring (Phase 2 — lightweight approach).
--
-- Real imported cards have no behavior: the Scryfall importer deliberately leaves
-- cards.script empty and never writes that column, so authored behavior already
-- survives reimports (the upsert's ON CONFLICT DO UPDATE never touches script).
--
-- This migration adds the two pieces that approach was missing:
--   1. oracle_id on cards, so authored behavior can be re-attached if the
--      representative printing chosen for an oracle changes between imports.
--   2. set_card_script(): an authenticated RPC the authoring UI calls to write a
--      validated script onto a catalog card (the V4/judge clients already read
--      coalesce(game_cards.copied_script, cards.script) at runtime, unchanged).
--   3. relink_card_scripts(): copies a non-empty script forward to other
--      printings that share its oracle_id but have no script yet, so a changed
--      representative printing does not strand previously authored behavior.

-- 1. oracle_id (Scryfall card identity; cards.id remains the printing id).
alter table public.cards
  add column if not exists oracle_id text;

comment on column public.cards.oracle_id is
  'Scryfall oracle_id (card identity shared across printings). cards.id is the printing id. Used to re-attach authored scripts when the representative printing changes.';

create index if not exists cards_oracle_id_idx
  on public.cards (oracle_id)
  where oracle_id is not null;

-- 2. Write a behavior script onto a catalog card. The authoring UI validates the
-- script shape client-side (validateCardScript); this guards auth and existence
-- and stores the script (pass '{}'::jsonb or null to clear behavior).
create or replace function public.set_card_script(
  p_card_id uuid,
  p_script jsonb
)
returns public.cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card public.cards;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_script is not null and jsonb_typeof(p_script) <> 'object' then
    raise exception 'Card script must be a JSON object';
  end if;

  update public.cards
  set script = coalesce(nullif(p_script, '{}'::jsonb), null)
  where id = p_card_id
  returning * into v_card;

  if not found then
    raise exception 'Card not found';
  end if;

  return v_card;
end;
$$;

-- 3. Propagate authored scripts across printings of the same oracle_id. For each
-- oracle_id, pick the most recently usable script among its printings and apply
-- it to sibling printings that currently have no script. Returns rows updated.
create or replace function public.relink_card_scripts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  with scripted as (
    -- One canonical script per oracle_id (any printing that has a non-empty one).
    select distinct on (oracle_id)
      oracle_id,
      script
    from public.cards
    where oracle_id is not null
      and script is not null
      and script <> '{}'::jsonb
    order by oracle_id, id
  )
  update public.cards target
  set script = scripted.script
  from scripted
  where target.oracle_id = scripted.oracle_id
    and (target.script is null or target.script = '{}'::jsonb);

  get diagnostics v_updated = row_count;

  return v_updated;
end;
$$;

grant execute on function public.set_card_script(uuid, jsonb) to authenticated;
grant execute on function public.relink_card_scripts() to authenticated;
