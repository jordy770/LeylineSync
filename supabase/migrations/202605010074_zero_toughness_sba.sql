-- State-based action: creatures with 0 or less toughness are put into the
-- graveyard.
--
-- This is distinct from lethal marked damage:
--   * Lethal damage (rule 704.5g) destroys a creature whose marked damage is at
--     least its toughness -- but indestructible prevents it.
--   * Toughness 0 or less (rule 704.5f) puts the creature into its owner's
--     graveyard regardless of indestructible, and regardless of marked damage.
--
-- The previous mover only considered creatures with marked damage, so a creature
-- dropped to 0 toughness by a negative pump or by removing +1/+1 counters would
-- linger on the battlefield. This rewrites the mover to sweep both categories in
-- a single pass, applying the indestructible check only to the damage branch.

create or replace function public.move_lethal_damaged_creatures_to_graveyard(
  p_session_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_destroyed_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  with dying_cards as (
    select
      game_cards.id,
      game_cards.owner_id,
      row_number() over (
        partition by game_cards.owner_id
        order by game_cards.zone_position, game_cards.id
      ) - 1 as graveyard_offset
    from public.game_cards
    join public.cards
      on cards.id = game_cards.card_id
    where game_cards.session_id = p_session_id
      and game_cards.zone = 'battlefield'
      and coalesce(cards.type_line, '') ilike '%creature%'
      and (
        -- 704.5f: toughness 0 or less. Ignores indestructible and damage.
        public.card_effective_toughness(p_session_id, game_cards.id) <= 0
        or (
          -- 704.5g: lethal marked damage. Indestructible prevents this.
          game_cards.damage_marked > 0
          and not public.card_has_indestructible(p_session_id, game_cards.id)
          and (
            game_cards.dealt_deathtouch_damage = true
            or game_cards.damage_marked >= public.card_effective_toughness(p_session_id, game_cards.id)
          )
        )
      )
  ),
  graveyard_positions as (
    select
      game_cards.owner_id,
      coalesce(max(game_cards.zone_position), -1) + 1 as next_graveyard_position
    from public.game_cards
    where game_cards.session_id = p_session_id
      and game_cards.zone = 'graveyard'
    group by game_cards.owner_id
  )
  update public.game_cards
  set
    zone = 'graveyard',
    zone_position = coalesce(graveyard_positions.next_graveyard_position, 0) + dying_cards.graveyard_offset,
    is_tapped = false,
    damage_marked = 0,
    dealt_deathtouch_damage = false,
    plus_one_counters = 0
  from dying_cards
  left join graveyard_positions
    on graveyard_positions.owner_id = dying_cards.owner_id
  where game_cards.id = dying_cards.id;

  get diagnostics v_destroyed_count = row_count;

  if v_destroyed_count > 0 then
    perform public.rebuild_scripted_continuous_effects(p_session_id);
  end if;

  return v_destroyed_count;
end;
$$;

grant execute on function public.move_lethal_damaged_creatures_to_graveyard(uuid) to authenticated;
