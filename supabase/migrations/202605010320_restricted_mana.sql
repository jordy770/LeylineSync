-- 202605010320_restricted_mana
-- Model "spend only" restricted mana (Haven of the Spirit Dragon, Drover of the
-- Mighty, Unclaimed Territory, Relic of Legends, …). An add_mana effect with a
-- `restriction` produces mana into game_players.restricted_mana instead of the
-- open pool; pay_mana_cost only spends it (restricted-first) when the pay context
-- matches (cast type_line / ability-source type_line / commander). Restricted
-- mana empties each step like normal mana.
-- Generated from supabase/functions_src (pay_mana_cost, activate_mana_ability, activate_ability, cast_card_from_hand, cast_spell_effect, cast_commander, put_action_on_stack, clear_mana_pool_for_step) — those files are
-- the canonical current definitions; edit them, not past migrations.

-- New per-player store for restricted ("spend only") mana.
alter table public.game_players
  add column if not exists restricted_mana jsonb not null default '[]'::jsonb;

-- pay_mana_cost gains a 7th parameter (p_pay_context). CREATE OR REPLACE with an
-- added parameter makes a NEW overload, so drop the prior 6-arg definition first
-- (else casts hit an ambiguous-function / stale-overload error).
drop function if exists public.pay_mana_cost(uuid, uuid, text, jsonb, integer, jsonb);

create or replace function public.pay_mana_cost(
  p_session_id uuid,
  p_player_id uuid,
  p_mana_cost text,
  p_generic_payment jsonb default null,
  p_x_value integer default 0,
  p_hybrid_payment jsonb default null,
  -- Pay context (restricted "spend only" mana, e.g. Haven of the Spirit Dragon):
  -- { "kind": "cast"|"ability", "type_line": text, "is_commander": bool }. When
  -- null (cycling, manifest face-up, …) restricted mana is NOT usable.
  p_pay_context jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $_$
declare
  v_empty_pool jsonb := jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0);
  v_current_pool jsonb;
  v_new_pool jsonb;
  -- Restricted ("spend only") mana reconciliation.
  v_restricted jsonb;
  v_restricted_new jsonb := '[]'::jsonb;
  v_orig_plain jsonb;
  v_elig jsonb := jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0);
  v_remove jsonb := jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0);
  v_final_plain jsonb;
  v_entry jsonb;
  v_kind text := p_pay_context ->> 'kind';
  v_ctx_type text := coalesce(p_pay_context ->> 'type_line', '');
  v_ctx_cmd boolean := coalesce((p_pay_context ->> 'is_commander')::boolean, false);
  v_e_color text;
  v_e_amt integer;
  v_eligible boolean;
  v_spent integer;
  v_from_restricted integer;
  v_keep integer;
  v_clean_cost text;
  v_symbol text;
  v_generic_cost integer := 0;
  v_x_count integer := 0;
  v_available_generic integer := 0;
  v_declared_generic_payment integer := 0;
  v_pay_amount integer;
  v_color text;
  -- Hybrid / Phyrexian state
  v_left text;
  v_right text;
  v_choice text;
  v_hybrid_index integer := 0;
  v_life_cost integer := 0;
  v_current_life integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_player_id <> auth.uid() then
    raise exception 'Cannot pay mana for another player';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if p_mana_cost is null or btrim(p_mana_cost) = '' then
    return v_empty_pool;
  end if;

  insert into public.game_players (session_id, player_id, mana_pool)
  values (p_session_id, p_player_id, v_empty_pool)
  on conflict (session_id, player_id) do nothing;

  select coalesce(mana_pool, v_empty_pool), coalesce(restricted_mana, '[]'::jsonb)
  into v_current_pool, v_restricted
  from public.game_players
  where session_id = p_session_id
    and player_id = p_player_id
  for update;

  -- Restricted ("spend only") mana: fold the entries ELIGIBLE for this pay
  -- context into the working pool so the normal algorithm can spend them; track
  -- the eligible amount per colour so we can deduct restricted-first afterwards
  -- (use-it-or-lose-it). Eligibility:
  --   commander entry      → context.is_commander (commander spell OR ability of a commander)
  --   kind='cast'          → no spell_type_line, or cast card type_line matches it
  --   kind='ability'       → ability_source_type_line present and source type_line matches it
  v_orig_plain := v_current_pool;
  for v_entry in select * from jsonb_array_elements(v_restricted)
  loop
    if p_pay_context is null then
      v_eligible := false;
    elsif coalesce((v_entry ->> 'commander')::boolean, false) then
      v_eligible := v_ctx_cmd;
    elsif v_kind = 'cast' then
      v_eligible := (v_entry ->> 'spell_type_line') is null
        or v_ctx_type ilike '%' || (v_entry ->> 'spell_type_line') || '%';
    elsif v_kind = 'ability' then
      v_eligible := (v_entry ->> 'ability_source_type_line') is not null
        and v_ctx_type ilike '%' || (v_entry ->> 'ability_source_type_line') || '%';
    else
      v_eligible := false;
    end if;

    if v_eligible then
      v_e_color := upper(coalesce(v_entry ->> 'color', 'C'));
      v_e_amt := greatest(0, coalesce((v_entry ->> 'amount')::integer, 0));
      if v_e_color in ('W', 'U', 'B', 'R', 'G', 'C') and v_e_amt > 0 then
        v_elig := v_elig || jsonb_build_object(
          v_e_color, coalesce((v_elig ->> v_e_color)::integer, 0) + v_e_amt);
      end if;
    end if;
  end loop;

  -- Working pool = plain pool + eligible restricted mana.
  v_new_pool := v_current_pool;
  foreach v_e_color in array array['W', 'U', 'B', 'R', 'G', 'C']
  loop
    v_new_pool := v_new_pool || jsonb_build_object(
      v_e_color,
      coalesce((v_current_pool ->> v_e_color)::integer, 0)
        + coalesce((v_elig ->> v_e_color)::integer, 0));
  end loop;
  -- Strip braces + whitespace but KEEP slashes so hybrid symbols stay intact
  -- ({W/U} -> "W/U", {2/W} -> "2/W", {W/P} -> "W/P", {2}{R} -> "2R").
  v_clean_cost := upper(regexp_replace(p_mana_cost, '[{}\s]', '', 'g'));

  -- Longest-match-first alternation: hybrid (with slash) before bare symbols.
  for v_symbol in
    select token[1]
    from regexp_matches(
      v_clean_cost,
      '([0-9]+/[WUBRGC]|[WUBRGC]/[WUBRGCP]|[0-9]+|[WUBRGC])',
      'g'
    ) as token
  loop
    if v_symbol ~ '^[0-9]+$' then
      v_generic_cost := v_generic_cost + v_symbol::integer;

    elsif v_symbol ~ '^[WUBRGC]$' then
      v_pay_amount := coalesce((v_new_pool ->> v_symbol)::integer, 0);
      if v_pay_amount <= 0 then
        raise exception 'Not enough % mana to pay %', v_symbol, p_mana_cost;
      end if;
      v_new_pool := v_new_pool || jsonb_build_object(v_symbol, v_pay_amount - 1);

    else
      -- Hybrid / Phyrexian symbol "left/right". Pull this symbol's choice (if any).
      v_left := split_part(v_symbol, '/', 1);
      v_right := split_part(v_symbol, '/', 2);
      v_choice := upper(coalesce(nullif(p_hybrid_payment ->> v_hybrid_index, ''), ''));
      v_hybrid_index := v_hybrid_index + 1;

      if v_right = 'P' then
        -- Phyrexian {C/P}: 1 of colour v_left OR 2 life. Default: colour if held.
        if v_choice = '' then
          v_choice := case
            when coalesce((v_new_pool ->> v_left)::integer, 0) >= 1 then v_left
            else 'LIFE'
          end;
        end if;

        if v_choice in ('LIFE', 'P') then
          v_life_cost := v_life_cost + 2;
        elsif v_choice = v_left then
          v_pay_amount := coalesce((v_new_pool ->> v_left)::integer, 0);
          if v_pay_amount <= 0 then
            raise exception 'Not enough % mana to pay Phyrexian % in %', v_left, v_symbol, p_mana_cost;
          end if;
          v_new_pool := v_new_pool || jsonb_build_object(v_left, v_pay_amount - 1);
        else
          raise exception 'Invalid Phyrexian payment choice "%" for %', v_choice, v_symbol;
        end if;

      elsif v_left ~ '^[0-9]+$' then
        -- Monohybrid {N/C}: N generic OR 1 of colour v_right. Default: colour if held.
        if v_choice = '' then
          v_choice := case
            when coalesce((v_new_pool ->> v_right)::integer, 0) >= 1 then v_right
            else 'GENERIC'
          end;
        end if;

        if v_choice = v_right then
          v_pay_amount := coalesce((v_new_pool ->> v_right)::integer, 0);
          if v_pay_amount <= 0 then
            raise exception 'Not enough % mana to pay % in %', v_right, v_symbol, p_mana_cost;
          end if;
          v_new_pool := v_new_pool || jsonb_build_object(v_right, v_pay_amount - 1);
        elsif v_choice in ('GENERIC', v_left) then
          v_generic_cost := v_generic_cost + v_left::integer;
        else
          raise exception 'Invalid hybrid payment choice "%" for %', v_choice, v_symbol;
        end if;

      else
        -- Two-colour hybrid {X/Y}: 1 of EITHER colour. Default: left if held, else right.
        if v_choice = '' then
          if coalesce((v_new_pool ->> v_left)::integer, 0) >= 1 then
            v_choice := v_left;
          elsif coalesce((v_new_pool ->> v_right)::integer, 0) >= 1 then
            v_choice := v_right;
          else
            raise exception 'Not enough mana to pay hybrid % in %', v_symbol, p_mana_cost;
          end if;
        end if;

        if v_choice not in (v_left, v_right) then
          raise exception 'Invalid hybrid payment choice "%" for %', v_choice, v_symbol;
        end if;
        v_pay_amount := coalesce((v_new_pool ->> v_choice)::integer, 0);
        if v_pay_amount <= 0 then
          raise exception 'Not enough % mana to pay hybrid % in %', v_choice, v_symbol, p_mana_cost;
        end if;
        v_new_pool := v_new_pool || jsonb_build_object(v_choice, v_pay_amount - 1);
      end if;
    end if;
  end loop;

  -- {X}: each X symbol costs the caster-chosen value in generic mana. The regex
  -- above never matches X, so it contributed nothing until now.
  v_x_count := length(v_clean_cost) - length(replace(v_clean_cost, 'X', ''));
  if v_x_count > 0 then
    v_generic_cost := v_generic_cost + v_x_count * greatest(coalesce(p_x_value, 0), 0);
  end if;

  if v_generic_cost > 0 then
    select sum(coalesce((v_new_pool ->> color_symbol)::integer, 0))
    into v_available_generic
    from unnest(array['C', 'W', 'U', 'B', 'R', 'G']) as color_symbol;

    if coalesce(v_available_generic, 0) < v_generic_cost then
      raise exception 'Not enough mana to pay generic cost % for %', v_generic_cost, p_mana_cost;
    end if;

    if p_generic_payment is not null and p_generic_payment <> 'null'::jsonb then
      foreach v_color in array array['C', 'W', 'U', 'B', 'R', 'G']
      loop
        v_pay_amount := coalesce((p_generic_payment ->> v_color)::integer, 0);

        if v_pay_amount < 0 then
          raise exception 'Generic mana payment cannot be negative';
        end if;

        v_declared_generic_payment := v_declared_generic_payment + v_pay_amount;
      end loop;

      if v_declared_generic_payment <> v_generic_cost then
        raise exception 'Generic mana payment must total %, got %', v_generic_cost, v_declared_generic_payment;
      end if;

      foreach v_color in array array['C', 'W', 'U', 'B', 'R', 'G']
      loop
        v_pay_amount := coalesce((p_generic_payment ->> v_color)::integer, 0);

        if v_pay_amount > coalesce((v_new_pool ->> v_color)::integer, 0) then
          raise exception 'Not enough % mana to pay chosen generic cost', v_color;
        end if;

        if v_pay_amount > 0 then
          v_new_pool := v_new_pool || jsonb_build_object(
            v_color,
            coalesce((v_new_pool ->> v_color)::integer, 0) - v_pay_amount
          );
        end if;
      end loop;
    else
      foreach v_color in array array['C', 'W', 'U', 'B', 'R', 'G']
      loop
        exit when v_generic_cost <= 0;

        v_pay_amount := least(coalesce((v_new_pool ->> v_color)::integer, 0), v_generic_cost);

        if v_pay_amount > 0 then
          v_new_pool := v_new_pool || jsonb_build_object(
            v_color,
            coalesce((v_new_pool ->> v_color)::integer, 0) - v_pay_amount
          );
          v_generic_cost := v_generic_cost - v_pay_amount;
        end if;
      end loop;
    end if;
  end if;

  -- Phyrexian life payment (resolved last, once, after all symbols are tallied).
  if v_life_cost > 0 then
    select life_total
    into v_current_life
    from public.game_session_players
    where session_id = p_session_id
      and player_id = p_player_id
    for update;

    if not found then
      raise exception 'Player life total not found';
    end if;

    if v_current_life < v_life_cost then
      raise exception 'Not enough life to pay Phyrexian cost % for %', v_life_cost, p_mana_cost;
    end if;

    update public.game_session_players
    set life_total = life_total - v_life_cost
    where session_id = p_session_id
      and player_id = p_player_id;
  end if;

  -- Reconcile: split each colour's spend between restricted (first) and plain.
  v_final_plain := v_orig_plain;
  foreach v_e_color in array array['W', 'U', 'B', 'R', 'G', 'C']
  loop
    v_spent := coalesce((v_orig_plain ->> v_e_color)::integer, 0)
             + coalesce((v_elig ->> v_e_color)::integer, 0)
             - coalesce((v_new_pool ->> v_e_color)::integer, 0);
    if v_spent < 0 then v_spent := 0; end if;
    v_from_restricted := least(v_spent, coalesce((v_elig ->> v_e_color)::integer, 0));
    v_remove := v_remove || jsonb_build_object(v_e_color, v_from_restricted);
    v_final_plain := v_final_plain || jsonb_build_object(
      v_e_color,
      coalesce((v_orig_plain ->> v_e_color)::integer, 0) - (v_spent - v_from_restricted));
  end loop;

  -- Rebuild the restricted array: reduce ELIGIBLE entries by what we spent
  -- (FIFO per colour); drop emptied entries; keep ineligible entries untouched.
  for v_entry in select * from jsonb_array_elements(v_restricted)
  loop
    if p_pay_context is null then
      v_eligible := false;
    elsif coalesce((v_entry ->> 'commander')::boolean, false) then
      v_eligible := v_ctx_cmd;
    elsif v_kind = 'cast' then
      v_eligible := (v_entry ->> 'spell_type_line') is null
        or v_ctx_type ilike '%' || (v_entry ->> 'spell_type_line') || '%';
    elsif v_kind = 'ability' then
      v_eligible := (v_entry ->> 'ability_source_type_line') is not null
        and v_ctx_type ilike '%' || (v_entry ->> 'ability_source_type_line') || '%';
    else
      v_eligible := false;
    end if;

    v_e_color := upper(coalesce(v_entry ->> 'color', 'C'));
    v_e_amt := greatest(0, coalesce((v_entry ->> 'amount')::integer, 0));
    v_keep := v_e_amt;
    if v_eligible and v_e_color in ('W', 'U', 'B', 'R', 'G', 'C')
       and coalesce((v_remove ->> v_e_color)::integer, 0) > 0 then
      v_from_restricted := least(v_e_amt, coalesce((v_remove ->> v_e_color)::integer, 0));
      v_keep := v_e_amt - v_from_restricted;
      v_remove := v_remove || jsonb_build_object(
        v_e_color, coalesce((v_remove ->> v_e_color)::integer, 0) - v_from_restricted);
    end if;
    if v_keep > 0 then
      v_restricted_new := v_restricted_new
        || jsonb_build_array(v_entry || jsonb_build_object('amount', v_keep));
    end if;
  end loop;

  update public.game_players
  set mana_pool = v_final_plain,
      restricted_mana = v_restricted_new
  where session_id = p_session_id
    and player_id = p_player_id;

  return v_final_plain;
end;
$_$;
grant execute on function public.pay_mana_cost(uuid, uuid, text, jsonb, integer, jsonb, jsonb) to anon;
grant execute on function public.pay_mana_cost(uuid, uuid, text, jsonb, integer, jsonb, jsonb) to authenticated;
grant execute on function public.pay_mana_cost(uuid, uuid, text, jsonb, integer, jsonb, jsonb) to service_role;

create or replace function public.activate_mana_ability(
  p_session_id uuid,
  p_source_card_id uuid,
  p_ability_index integer default 0,
  p_generic_payment jsonb default null,
  -- The colour chosen for an "any colour" producer (Treasure, mig 226).
  p_chosen_color text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_zone text;
  v_script jsonb;
  v_ability jsonb;
  v_cost jsonb;
  v_effect jsonb;
  v_has_tap boolean := false;
  v_has_sac boolean := false;
  v_mana_cost text := null;
  v_life_cost integer := 0;
  v_player_life integer;
  v_color text;
  v_amount integer;
  v_pool jsonb;
  -- Restricted ("spend only") mana: an add_mana effect may carry a `restriction`
  -- ({spell_type_line?, ability_source_type_line?, commander?}); such mana goes
  -- to game_players.restricted_mana instead of the open pool.
  v_restricted jsonb;
  v_restriction jsonb;
  v_produced_restricted boolean := false;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select game_cards.zone
  into v_zone
  from public.game_cards
  where game_cards.id = p_source_card_id
    and game_cards.session_id = p_session_id
    and game_cards.owner_id = auth.uid();
  if not found then
    raise exception 'Source card not found or not owned by current user';
  end if;
  if v_zone <> 'battlefield' then
    raise exception 'Mana ability source must be on the battlefield';
  end if;

  v_script := public.effective_script(p_session_id, p_source_card_id);
  v_ability := v_script -> 'activated_abilities' -> p_ability_index;
  if v_ability is null then
    raise exception 'Activated ability not found at index %', p_ability_index;
  end if;
  if not coalesce((v_ability ->> 'is_mana_ability')::boolean, false) then
    raise exception 'Not a mana ability';
  end if;

  -- Parse costs (tap_self / mana / pay_life).
  for v_cost in select * from jsonb_array_elements(coalesce(v_ability -> 'costs', '[]'::jsonb))
  loop
    case v_cost ->> 'type'
      when 'tap_self' then v_has_tap := true;
      when 'sacrifice_self' then v_has_sac := true;
      when 'mana' then v_mana_cost := v_cost ->> 'amount';
      when 'pay_life' then v_life_cost := greatest(0, coalesce((v_cost ->> 'amount')::integer, 0));
      else raise exception 'Unsupported mana-ability cost: %', v_cost ->> 'type';
    end case;
  end loop;

  if v_has_tap and exists (
    select 1 from public.game_cards where id = p_source_card_id and is_tapped = true
  ) then
    raise exception 'Source is already tapped';
  end if;

  -- Life cost (CR 119.4): the player must have at least that much life to pay it.
  if v_life_cost > 0 then
    select life_total into v_player_life
    from public.game_session_players
    where session_id = p_session_id and player_id = auth.uid();
    if coalesce(v_player_life, 0) < v_life_cost then
      raise exception 'Not enough life to pay % life (have %)', v_life_cost, coalesce(v_player_life, 0);
    end if;
  end if;

  -- Pay the activation mana cost (the {1}) BEFORE producing.
  if v_mana_cost is not null and btrim(v_mana_cost) <> '' then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_mana_cost, p_generic_payment);
  end if;

  -- Pay the life cost.
  if v_life_cost > 0 then
    update public.game_session_players
    set life_total = life_total - v_life_cost
    where session_id = p_session_id and player_id = auth.uid();
  end if;

  if v_has_tap then
    update public.game_cards
    set is_tapped = true
    where id = p_source_card_id and session_id = p_session_id;
  end if;

  -- Ensure a pool row exists, then add every add_mana effect's mana.
  insert into public.game_players (session_id, player_id, mana_pool)
  values (p_session_id, auth.uid(), jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0))
  on conflict (session_id, player_id) do nothing;

  select coalesce(mana_pool, jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0)),
         coalesce(restricted_mana, '[]'::jsonb)
  into v_pool, v_restricted
  from public.game_players
  where session_id = p_session_id and player_id = auth.uid()
  for update;

  for v_effect in select * from jsonb_array_elements(coalesce(v_ability -> 'effects', '[]'::jsonb))
  loop
    if lower(coalesce(v_effect ->> 'type', '')) = 'add_mana' then
      v_color := upper(coalesce(v_effect ->> 'color', 'C'));
      -- "Any colour" (Treasure, mig 226): the caller picks the colour.
      if v_color = 'ANY' then
        v_color := upper(coalesce(p_chosen_color, ''));
        if v_color not in ('W', 'U', 'B', 'R', 'G', 'C') then
          raise exception 'Choose a colour for this mana ability';
        end if;
      elsif v_color not in ('W', 'U', 'B', 'R', 'G', 'C') then
        raise exception 'A multi-mana ability must produce fixed colours (got %)', v_color;
      end if;
      v_amount := greatest(1, coalesce((v_effect ->> 'amount')::integer, 1));
      v_restriction := v_effect -> 'restriction';
      if v_restriction is not null and jsonb_typeof(v_restriction) = 'object' then
        -- "Spend only to cast …": stash as restricted mana, not open mana.
        v_produced_restricted := true;
        v_restricted := v_restricted || jsonb_build_array(
          jsonb_build_object('color', v_color, 'amount', v_amount) || v_restriction);
      else
        v_pool := v_pool || jsonb_build_object(v_color, coalesce((v_pool ->> v_color)::integer, 0) + v_amount);
      end if;
    end if;
  end loop;

  -- Monarch land bonus (mig 262, Regal Behemoth: "whenever you tap a land for
  -- mana while you're the monarch, add an additional one mana of any color").
  -- Approximations: the bonus is one mana of the colour this ability just
  -- produced (no separate colour pick), once per activation.
  if v_color is not null
     and v_has_tap
     and not v_produced_restricted
     and exists (select 1 from public.game_turn_state ts
                 where ts.session_id = p_session_id and ts.monarch_player_id = auth.uid())
     and exists (select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
                 where gc.id = p_source_card_id and gc.session_id = p_session_id
                   and c.type_line ilike '%land%')
     and exists (select 1 from public.game_cards gc
                 where gc.session_id = p_session_id and gc.zone = 'battlefield'
                   and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
                   and coalesce((public.effective_script(p_session_id, gc.id) ->> 'monarch_land_bonus')::boolean, false))
  then
    v_pool := v_pool || jsonb_build_object(v_color, coalesce((v_pool ->> v_color)::integer, 0) + 1);
  end if;

  update public.game_players
  set mana_pool = v_pool,
      restricted_mana = v_restricted
  where session_id = p_session_id and player_id = auth.uid();

  -- Sacrifice cost (mig 226, Treasure): the source goes to the graveyard after
  -- producing — a token then ceases to exist via the usual cleanup trigger.
  if v_has_sac then
    perform public.put_in_graveyard(p_session_id, p_source_card_id);
  end if;

  return v_pool;
end;
$$;
grant execute on function public.activate_mana_ability(uuid, uuid, integer, jsonb, text) to authenticated;

create or replace function public.activate_ability(
  p_session_id uuid,
  p_source_card_id uuid,
  p_ability_index integer default 0,
  p_target_player_id uuid default null,
  p_target_card_id uuid default null,
  p_generic_payment jsonb default null,
  p_x_value integer default null,
  -- Chosen cost payments (mig 284): for pick-able costs (sacrifice_artifacts,
  -- return_land, tap_creatures) the client passes the exact cards to pay
  -- with, in cost order. Null = the engine auto-picks (legacy behaviour).
  p_cost_card_ids uuid[] default null
) returns public.game_stack_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn public.game_turn_state;
  v_zone text;
  v_script jsonb;
  v_ability jsonb;
  v_cost jsonb;
  v_effect jsonb;
  v_eff_type text;
  v_target_controller text;
  v_has_tap boolean := false;
  v_has_sac boolean := false;
  v_has_sac_creature boolean := false;
  v_has_gy_exile boolean := false;
  v_gy_filter text;
  v_tap_creatures_count integer := 0;
  v_tap_creatures_type text;
  v_discard_cost integer := 0;
  v_sac_artifacts_count integer := 0;
  v_sac_artifacts_nontoken boolean := false;
  v_sac_artifact uuid;
  v_return_land_count integer := 0;
  v_cost_pick_i integer := 0;
  v_i integer;
  v_remove_counter_type text;
  v_remove_counter_amount integer := 0;
  v_bag_count integer;
  v_mana_cost text := null;
  v_source_type_line text;
  v_source_is_commander boolean := false;
  v_energy_cost integer := 0;
  v_player_energy integer;
  v_amount integer;
  v_next_position integer;
  v_stack public.game_stack_items;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select *
  into v_turn
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn.priority_player_id, v_turn.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can activate abilities';
  end if;

  select game_cards.zone
  into v_zone
  from public.game_cards
  where game_cards.id = p_source_card_id
    and game_cards.session_id = p_session_id
    and game_cards.owner_id = auth.uid();

  if not found then
    raise exception 'Source card not found or not owned by current user';
  end if;

  -- Restricted-mana pay context (Haven: "activate abilities of Dragon sources";
  -- Relic of Legends: "an ability of a commander").
  select c.type_line, coalesce(gc.is_commander, false)
  into v_source_type_line, v_source_is_commander
  from public.game_cards gc join public.cards c on c.id = gc.card_id
  where gc.id = p_source_card_id and gc.session_id = p_session_id;

  v_script := public.effective_script(p_session_id, p_source_card_id);
  v_ability := v_script -> 'activated_abilities' -> p_ability_index;

  -- Zone gate (mig 289): battlefield by default, but an ability may declare
  -- its own source zone (omen back-faces cast from HAND: Flush Out /
  -- Dynamic Soar; the adventure pattern generally).
  if v_zone <> coalesce(v_ability ->> 'source_zone_required', 'battlefield') then
    raise exception 'Ability source must be in its required zone (%)',
      coalesce(v_ability ->> 'source_zone_required', 'battlefield');
  end if;

  if v_ability is null then
    raise exception 'Activated ability not found at index %', p_ability_index;
  end if;

  if coalesce((v_ability ->> 'is_mana_ability')::boolean, false) then
    raise exception 'Use the mana ability flow for mana abilities';
  end if;

  -- Activation condition (mig 233, Skarrgan Hellkite: "Activate only if this
  -- creature has a +1/+1 counter on it"). A {counters, of, at_least} spec read
  -- via resolve_dynamic_amount before any cost is paid.
  if v_ability -> 'condition' is not null then
    if public.resolve_dynamic_amount(p_session_id, p_source_card_id, auth.uid(), v_ability -> 'condition')
       < coalesce((v_ability -> 'condition' ->> 'at_least')::integer, 1)
    then
      raise exception 'This ability cannot be activated right now';
    end if;
  end if;

  -- Parse costs
  for v_cost in select * from jsonb_array_elements(coalesce(v_ability -> 'costs', '[]'::jsonb))
  loop
    case v_cost ->> 'type'
      when 'tap_self' then v_has_tap := true;
      when 'sacrifice_self' then v_has_sac := true;
      when 'sacrifice_creature' then v_has_sac_creature := true;
      when 'exile_from_graveyard' then
        v_has_gy_exile := true;
        v_gy_filter := lower(coalesce(v_cost ->> 'type_line', 'creature'));
      when 'mana' then v_mana_cost := v_cost ->> 'amount';
      when 'energy' then v_energy_cost := greatest(0, coalesce((v_cost ->> 'amount')::integer, 0));
      -- "Tap five untapped Zombies you control" (mig 212, Gravespawn Sovereign).
      -- The engine auto-picks the N untapped matching creatures (incl. the
      -- source); a client-chosen set is a future refinement.
      when 'tap_creatures' then
        v_tap_creatures_count := greatest(1, coalesce((v_cost ->> 'count')::integer, 1));
        v_tap_creatures_type := lower(coalesce(v_cost ->> 'type_line', 'creature'));
      -- "Discard a card" as a cost (mig 214, Grimoire of the Dead): the chosen
      -- hand card rides p_target_card_id (these abilities' effect is untargeted,
      -- like the exile_from_graveyard cost).
      when 'discard' then v_discard_cost := greatest(1, coalesce((v_cost ->> 'amount')::integer, 1));
      -- "Sacrifice N artifacts" (mig 264, Breya / Thopter Foundry). The engine
      -- auto-picks the N cheapest-MV artifacts you control other than the
      -- source (tokens are MV 0, so they go first — matching real play);
      -- nontoken:true restricts to nontoken artifacts. A client-chosen set is
      -- a future refinement.
      when 'sacrifice_artifacts' then
        v_sac_artifacts_count := greatest(1, coalesce((v_cost ->> 'count')::integer, 1));
        v_sac_artifacts_nontoken := coalesce((v_cost ->> 'nontoken')::boolean, false);
      -- 'Return a land you control to its owner's hand' as a cost (mig 277,
      -- Mina and Denn). Auto-picks: tapped lands first.
      when 'return_land' then
        v_return_land_count := greatest(1, coalesce((v_cost ->> 'count')::integer, 1));
      -- "Remove three study counters from ~" as a cost (mig 214).
      when 'remove_counters' then
        v_remove_counter_type := lower(coalesce(v_cost ->> 'counter_type', 'study'));
        v_remove_counter_amount := greatest(1, coalesce((v_cost ->> 'amount')::integer, 1));
      else raise exception 'Unsupported ability cost: %', v_cost ->> 'type';
    end case;
  end loop;

  -- {X} in the activation cost (mig 242, Kessig Wolf Run): the activator
  -- chooses X (p_x_value); it is paid as that much generic mana and every
  -- literal 'X' power/toughness/amount in the effects becomes the chosen
  -- value before the effects are put on the stack.
  if v_mana_cost is not null and position('{X}' in v_mana_cost) > 0 then
    if coalesce(p_x_value, -1) < 0 then
      raise exception 'This ability requires a chosen X';
    end if;
    v_mana_cost := replace(v_mana_cost, '{X}', '{' || p_x_value::text || '}');
    select jsonb_set(v_ability, '{effects}', coalesce(jsonb_agg(
      e.value
      || case when e.value ->> 'power' = 'X' then jsonb_build_object('power', p_x_value) else '{}'::jsonb end
      || case when e.value ->> 'toughness' = 'X' then jsonb_build_object('toughness', p_x_value) else '{}'::jsonb end
      || case when e.value ->> 'amount' = 'X' then jsonb_build_object('amount', p_x_value) else '{}'::jsonb end
    ), '[]'::jsonb))
    into v_ability
    from jsonb_array_elements(coalesce(v_ability -> 'effects', '[]'::jsonb)) e;
  end if;

  if v_has_tap and exists (
    select 1 from public.game_cards where id = p_source_card_id and is_tapped = true
  ) then
    raise exception 'Source is already tapped';
  end if;

  -- Energy: the activating player must have enough in their pool.
  if v_energy_cost > 0 then
    select coalesce((counters ->> 'energy')::integer, 0)
    into v_player_energy
    from public.game_session_players
    where session_id = p_session_id and player_id = auth.uid();

    if coalesce(v_player_energy, 0) < v_energy_cost then
      raise exception 'Not enough energy: need % (have %)', v_energy_cost, coalesce(v_player_energy, 0);
    end if;
  end if;

  -- Graveyard-exile cost: validate the chosen card BEFORE paying anything (it is
  -- passed as p_target_card_id; the effect of such abilities is untargeted).
  if v_has_gy_exile then
    if p_target_card_id is null then
      raise exception 'Choose a card in a graveyard to exile for this ability';
    end if;
    if not exists (
      select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = p_target_card_id and gc.session_id = p_session_id and gc.zone = 'graveyard'
        and (v_gy_filter = '' or c.type_line ilike '%' || v_gy_filter || '%')
    ) then
      raise exception 'That card is not a matching card in a graveyard';
    end if;
  end if;

  -- Sacrifice-a-creature cost: validate the chosen creature you control (passed as
  -- p_target_card_id; the effect is untargeted).
  if v_has_sac_creature then
    if p_target_card_id is null then
      raise exception 'Choose a creature to sacrifice for this ability';
    end if;
    if not exists (
      select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = p_target_card_id and gc.session_id = p_session_id and gc.zone = 'battlefield'
        and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
        and c.type_line ilike '%creature%'
    ) then
      raise exception 'You must sacrifice a creature you control';
    end if;
  end if;

  -- Discard cost: the chosen hand card rides p_target_card_id (untargeted-effect
  -- abilities only, like the graveyard-exile cost). Single-card discard only.
  if v_discard_cost > 0 then
    if v_discard_cost > 1 then
      raise exception 'Multi-card discard costs are not supported yet';
    end if;
    if p_target_card_id is null then
      raise exception 'Choose a card in your hand to discard for this ability';
    end if;
    if not exists (
      select 1 from public.game_cards
      where id = p_target_card_id and session_id = p_session_id
        and zone = 'hand' and owner_id = auth.uid()
    ) then
      raise exception 'You must discard a card from your own hand';
    end if;
    update public.game_cards gc
    set zone = 'graveyard', is_tapped = false,
        zone_position = (select coalesce(max(zone_position), -1) + 1
                         from public.game_cards x
                         where x.session_id = p_session_id and x.owner_id = gc.owner_id and x.zone = 'graveyard')
    where gc.id = p_target_card_id and gc.session_id = p_session_id;
    -- The cost consumed the target slot; the effect is untargeted.
    p_target_card_id := null;
  end if;

  -- Remove-counters cost (mig 214): the SOURCE must carry enough bag counters.
  if v_remove_counter_amount > 0 then
    select coalesce((counters ->> v_remove_counter_type)::integer, 0)
    into v_bag_count
    from public.game_cards
    where id = p_source_card_id and session_id = p_session_id;
    if coalesce(v_bag_count, 0) < v_remove_counter_amount then
      raise exception 'Not enough % counters: need % (have %)', v_remove_counter_type, v_remove_counter_amount, coalesce(v_bag_count, 0);
    end if;
    update public.game_cards
    set counters = public.adjust_counter_bag(counters, v_remove_counter_type, -v_remove_counter_amount)
    where id = p_source_card_id and session_id = p_session_id;
  end if;

  -- Tap-creatures cost: validate there are enough untapped matching creatures,
  -- then tap the first N (zone-position order).
  if v_tap_creatures_count > 0 then
    if (select count(*) from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.session_id = p_session_id and gc.zone = 'battlefield' and gc.is_tapped = false
          and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
          and c.type_line ilike '%creature%'
          and c.type_line ilike '%' || v_tap_creatures_type || '%') < v_tap_creatures_count
    then
      raise exception 'You need % untapped % creatures to activate this', v_tap_creatures_count, v_tap_creatures_type;
    end if;
    if p_cost_card_ids is not null then
      -- Chosen payment (mig 284): tap exactly the provided creatures.
      for v_i in 1..v_tap_creatures_count loop
        v_cost_pick_i := v_cost_pick_i + 1;
        v_sac_artifact := p_cost_card_ids[v_cost_pick_i];
        if v_sac_artifact is null or not exists (
          select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
          where gc.id = v_sac_artifact and gc.session_id = p_session_id
            and gc.zone = 'battlefield' and gc.is_tapped = false
            and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
            and c.type_line ilike '%creature%'
            and c.type_line ilike '%' || v_tap_creatures_type || '%'
        ) then
          raise exception 'Chosen cost card is not a legal creature to tap';
        end if;
        update public.game_cards set is_tapped = true where id = v_sac_artifact;
      end loop;
    else
    update public.game_cards
    set is_tapped = true
    where id in (
      select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.zone = 'battlefield' and gc.is_tapped = false
        and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
        and c.type_line ilike '%creature%'
        and c.type_line ilike '%' || v_tap_creatures_type || '%'
      order by gc.zone_position, gc.id
      limit v_tap_creatures_count
    );
    end if;
  end if;

  if v_mana_cost is not null then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_mana_cost, p_generic_payment,
      p_pay_context := jsonb_build_object(
        'kind', 'ability',
        'type_line', coalesce(v_source_type_line, ''),
        'is_commander', v_source_is_commander));
  end if;

  if v_energy_cost > 0 then
    update public.game_session_players
    set counters = public.adjust_counter_bag(counters, 'energy', -v_energy_cost)
    where session_id = p_session_id and player_id = auth.uid();
  end if;

  if v_has_tap then
    update public.game_cards
    set is_tapped = true
    where id = p_source_card_id and session_id = p_session_id;
  end if;

  -- Sacrifice the source as a cost (after the other costs are paid).
  if v_has_sac then
    perform public.put_in_graveyard(p_session_id, p_source_card_id);
  end if;

  -- Pay the graveyard-exile cost: exile the chosen card (controller := owner).
  if v_has_gy_exile then
    update public.game_cards gc
    set zone = 'exile', controller_player_id = gc.owner_id, is_tapped = false, damage_marked = 0,
        zone_position = (select coalesce(max(zone_position), -1) + 1
                         from public.game_cards x
                         where x.session_id = p_session_id and x.owner_id = gc.owner_id and x.zone = 'exile')
    where gc.id = p_target_card_id and gc.session_id = p_session_id;
  end if;

  -- Pay the sacrifice-a-creature cost.
  if v_has_sac_creature then
    perform public.put_in_graveyard(p_session_id, p_target_card_id);
  end if;

  -- Pay the sacrifice-N-artifacts cost (mig 264): cheapest MV first, source
  -- excluded; raise when you control too few matching artifacts.
  if v_sac_artifacts_count > 0 then
    for v_i in 1..v_sac_artifacts_count loop
      if p_cost_card_ids is not null then
        -- Chosen payment (mig 284): consume the next provided card; it must
        -- be a legal artifact payment or the activation fails whole.
        v_cost_pick_i := v_cost_pick_i + 1;
        v_sac_artifact := p_cost_card_ids[v_cost_pick_i];
        if v_sac_artifact is null or not exists (
          select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
          where gc.id = v_sac_artifact and gc.session_id = p_session_id
            and gc.zone = 'battlefield'
            and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
            and gc.id <> p_source_card_id
            and c.type_line ilike '%artifact%'
            and (not v_sac_artifacts_nontoken
                 or (not coalesce(c.is_token, false) and not coalesce(gc.is_token, false)))
        ) then
          raise exception 'Chosen cost card is not a legal artifact to sacrifice';
        end if;
      else
      select gc.id into v_sac_artifact
      from public.game_cards gc
      join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.zone = 'battlefield'
        and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
        and gc.id <> p_source_card_id
        and c.type_line ilike '%artifact%'
        and (not v_sac_artifacts_nontoken
             or (not coalesce(c.is_token, false) and not coalesce(gc.is_token, false)))
      order by public.mana_value(c.mana_cost) asc, gc.zone_position asc, gc.id asc
      limit 1;
      end if;
      if v_sac_artifact is null then
        raise exception 'You must sacrifice % artifact(s) you control', v_sac_artifacts_count;
      end if;
      perform public.put_in_graveyard(p_session_id, v_sac_artifact);
    end loop;
  end if;

  -- Pay the return-a-land cost (mig 277, Mina and Denn): tapped lands first.
  if v_return_land_count > 0 then
    for v_i in 1..v_return_land_count loop
      if p_cost_card_ids is not null then
        v_cost_pick_i := v_cost_pick_i + 1;
        v_sac_artifact := p_cost_card_ids[v_cost_pick_i];
        if v_sac_artifact is null or not exists (
          select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
          where gc.id = v_sac_artifact and gc.session_id = p_session_id
            and gc.zone = 'battlefield'
            and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
            and c.type_line ilike '%land%'
        ) then
          raise exception 'Chosen cost card is not a legal land to return';
        end if;
      else
      select gc.id into v_sac_artifact
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.zone = 'battlefield'
        and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
        and c.type_line ilike '%land%'
      order by gc.is_tapped desc, gc.zone_position asc, gc.id asc
      limit 1;
      end if;
      if v_sac_artifact is null then
        raise exception 'You must return % land(s) you control to pay this cost', v_return_land_count;
      end if;
      update public.game_cards gc
      set zone = 'hand', is_tapped = false, attached_to = null,
          controller_player_id = gc.owner_id,
          zone_position = (select coalesce(max(x.zone_position), -1) + 1
                           from public.game_cards x
                           where x.session_id = p_session_id
                             and x.owner_id = gc.owner_id and x.zone = 'hand')
      where gc.id = v_sac_artifact;
    end loop;
  end if;

  v_effect := v_ability -> 'effects' -> 0;
  if v_effect is null then
    raise exception 'Activated ability has no effect';
  end if;

  -- Non-mana activation broadcast (mig 258, Runic Armasaur: "whenever an
  -- opponent activates an ability of a creature or land that isn't a mana
  -- ability, you may draw a card"). Mana abilities route through
  -- activate_mana_ability and never reach here, so every fire is non-mana.
  -- Approximation: the watcher's type filter defaults to '' for this event
  -- (any permanent type, not just creature-or-land).
  perform public.fire_watcher_triggers(
    p_session_id, p_source_card_id, auth.uid(), 'ability_activated');

  -- A MULTI-effect ability (Vampiric Rites: draw + lose life; Kessig Wolf
  -- Run: targeted pump + trample) resolves its whole program via a
  -- spell_effect stack item. A provided target rides the payload — the
  -- program resolver routes each targeted effect to it.
  if jsonb_array_length(coalesce(v_ability -> 'effects', '[]'::jsonb)) > 1 then
    select coalesce(max(position), 0) + 1 into v_next_position
    from public.game_stack_items where session_id = p_session_id;
    insert into public.game_stack_items (
      session_id, controller_player_id, source_card_id, action_type, payload, position, status
    ) values (
      p_session_id, auth.uid(), p_source_card_id, 'spell_effect',
      jsonb_build_object('effects', v_ability -> 'effects', 'controller_player_id', auth.uid(), 'timing', 'instant')
        || case when p_target_card_id is not null
                then jsonb_build_object('target_card_id', p_target_card_id) else '{}'::jsonb end,
      v_next_position, 'pending'
    )
    returning * into v_stack;
    return v_stack;
  end if;

  v_eff_type := lower(coalesce(v_effect ->> 'type', ''));
  v_target_controller := coalesce(lower(nullif(v_effect ->> 'target_controller', '')), 'any');
  -- Dynamic amount resolved NOW against the source permanent / controller / target.
  v_amount := public.resolve_dynamic_amount(
    p_session_id, p_source_card_id, auth.uid(), v_effect -> 'amount', p_target_card_id);

  if v_eff_type = 'draw' then
    v_stack := public.put_action_on_stack(
      p_session_id, 'draw_cards',
      jsonb_build_object('amount', greatest(1, v_amount), 'timing', 'instant'),
      p_source_card_id
    );

  elsif v_eff_type in ('create_token', 'search_library', 'grant_keyword_all', 'return_all_from_graveyard', 'deal_damage_all', 'monstrosity', 'divide_damage', 'return_from_graveyard', 'play_hideaway', 'choose_one', 'gain_life', 'fight_pick', 'destroy_all', 'proliferate') then
    -- A single create_token / search_library / grant_keyword_all effect
    -- routes through a spell_effect stack item so it reuses the spell-effect
    -- resolver (incl. the `tapped` flag and tutor `filter`). Wayfarer's Bauble.
    -- A provided target rides the payload (mig 261, Wayta's fight_pick: the
    -- activation target is the fighter).
    select coalesce(max(position), 0) + 1 into v_next_position
    from public.game_stack_items where session_id = p_session_id;
    insert into public.game_stack_items (
      session_id, controller_player_id, source_card_id, action_type, payload, position, status
    ) values (
      p_session_id, auth.uid(), p_source_card_id, 'spell_effect',
      jsonb_build_object('effects', jsonb_build_array(v_effect), 'controller_player_id', auth.uid(), 'timing', 'instant')
        || case when p_target_card_id is not null
                then jsonb_build_object('target_card_id', p_target_card_id) else '{}'::jsonb end,
      v_next_position, 'pending'
    )
    returning * into v_stack;

  elsif v_eff_type = 'exile_from_graveyard' then
    -- Withered Wretch: target is a card in ANY graveyard (not consumed as a cost).
    if p_target_card_id is null then
      raise exception 'A target card in a graveyard is required';
    end if;
    if not exists (
      select 1 from public.game_cards
      where id = p_target_card_id and session_id = p_session_id and zone = 'graveyard'
    ) then
      raise exception 'Target must be a card in a graveyard';
    end if;
    -- Direct-insert the stack item (the dispatcher resolves it via the registered
    -- handle_exile_from_graveyard handler). put_action_on_stack's hardcoded action
    -- allowlist doesn't carry this type, so mirror the create_token path above.
    select coalesce(max(position), 0) + 1 into v_next_position
    from public.game_stack_items where session_id = p_session_id;
    insert into public.game_stack_items (
      session_id, controller_player_id, source_card_id, action_type, payload, position, status
    ) values (
      p_session_id, auth.uid(), p_source_card_id, 'exile_from_graveyard',
      jsonb_build_object('target_card_id', p_target_card_id, 'timing', 'instant'),
      v_next_position, 'pending'
    )
    returning * into v_stack;

  elsif v_eff_type = 'grant_cast_from_graveyard' and p_target_card_id is not null then
    -- Havengul Lich (mig 215): "{1}: You may cast target creature card in a
    -- graveyard this turn." The chosen card gets a card-specific until-EOT
    -- cast-from-graveyard permission (the ATAE branch writes the row). The
    -- "gains all activated abilities of that card" rider is NOT modelled.
    -- Engine limitation: the cast path only casts cards you OWN, so targeting
    -- an opponent's graveyard grants a permission that can't be used yet.
    if not exists (
      select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = p_target_card_id and gc.session_id = p_session_id and gc.zone = 'graveyard'
        and c.type_line ilike '%creature%'
    ) then
      raise exception 'Target must be a creature card in a graveyard';
    end if;
    select coalesce(max(position), 0) + 1 into v_next_position
    from public.game_stack_items where session_id = p_session_id;
    insert into public.game_stack_items (
      session_id, controller_player_id, source_card_id, action_type, payload, position, status
    ) values (
      p_session_id, auth.uid(), p_source_card_id, 'spell_effect',
      jsonb_build_object(
        'effects', jsonb_build_array(v_effect || jsonb_build_object('card_id', p_target_card_id)),
        'controller_player_id', auth.uid(), 'timing', 'instant'),
      v_next_position, 'pending'
    )
    returning * into v_stack;

  elsif v_eff_type = 'reanimate_from_graveyard' then
    -- Gravespawn Sovereign (mig 212): "Put target creature card from a
    -- graveyard onto the battlefield under your control." Same direct-insert
    -- route as exile_from_graveyard; the registered handler moves the card.
    if p_target_card_id is null then
      raise exception 'A target creature card in a graveyard is required';
    end if;
    if not exists (
      select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = p_target_card_id and gc.session_id = p_session_id and gc.zone = 'graveyard'
        and c.type_line ilike '%creature%'
    ) then
      raise exception 'Target must be a creature card in a graveyard';
    end if;
    select coalesce(max(position), 0) + 1 into v_next_position
    from public.game_stack_items where session_id = p_session_id;
    insert into public.game_stack_items (
      session_id, controller_player_id, source_card_id, action_type, payload, position, status
    ) values (
      p_session_id, auth.uid(), p_source_card_id, 'reanimate_from_graveyard',
      jsonb_build_object('target_card_id', p_target_card_id, 'timing', 'instant'),
      v_next_position, 'pending'
    )
    returning * into v_stack;

  elsif v_eff_type = 'deal_damage' then
    if v_amount <= 0 then
      raise exception 'Invalid damage amount';
    end if;
    if p_target_card_id is not null then
      v_stack := public.put_action_on_stack(
        p_session_id, 'deal_damage_creature',
        jsonb_build_object('target_card_id', p_target_card_id, 'amount', v_amount, 'target_controller', v_target_controller, 'timing', 'instant'),
        p_source_card_id
      );
    elsif p_target_player_id is not null then
      v_stack := public.put_action_on_stack(
        p_session_id, 'deal_damage_player',
        jsonb_build_object('target_player_id', p_target_player_id, 'amount', v_amount, 'timing', 'instant'),
        p_source_card_id
      );
    else
      raise exception 'A target is required for this ability';
    end if;

  elsif v_eff_type in ('destroy', 'exile', 'bounce', 'tap', 'untap') then
    if p_target_card_id is null then
      raise exception 'A target is required for this ability';
    end if;
    if public.behavior_target_type_is_creature_only(v_effect -> 'target_type') then
      v_stack := public.put_action_on_stack(
        p_session_id, v_eff_type || '_creature',
        jsonb_build_object('target_card_id', p_target_card_id, 'target_controller', v_target_controller, 'timing', 'instant'),
        p_source_card_id
      );
    else
      -- A non-creature / any-permanent target (Unstable Obelisk) goes through the
      -- type-flexible permanent_effect action; apply_creature_effect's removal
      -- kinds operate on any permanent.
      v_stack := public.put_action_on_stack(
        p_session_id, 'permanent_effect',
        jsonb_build_object('kind', v_eff_type, 'target_card_id', p_target_card_id,
          'target_type', coalesce(v_effect -> 'target_type', '"permanent"'::jsonb),
          'target_controller', v_target_controller, 'timing', 'instant'),
        p_source_card_id
      );
    end if;

  elsif v_eff_type = 'add_counters' then
    if v_amount <= 0 then
      raise exception 'Invalid counter amount';
    end if;
    if p_target_card_id is null then
      -- Untargeted (mig 214, Grimoire of the Dead "put a study counter on ~"):
      -- route through a spell_effect stack item — the trigger resolver's
      -- add_counters defaults to the SOURCE (incl. bag counter_type).
      select coalesce(max(position), 0) + 1 into v_next_position
      from public.game_stack_items where session_id = p_session_id;
      insert into public.game_stack_items (
        session_id, controller_player_id, source_card_id, action_type, payload, position, status
      ) values (
        p_session_id, auth.uid(), p_source_card_id, 'spell_effect',
        jsonb_build_object('effects', jsonb_build_array(v_effect), 'controller_player_id', auth.uid(), 'timing', 'instant'),
        v_next_position, 'pending'
      )
      returning * into v_stack;
    else
      v_stack := public.put_action_on_stack(
        p_session_id, 'add_counters_creature',
        jsonb_build_object('target_card_id', p_target_card_id, 'amount', v_amount, 'target_controller', v_target_controller, 'timing', 'instant'),
        p_source_card_id
      );
    end if;

  elsif v_eff_type = 'pump' then
    if p_target_card_id is null then
      raise exception 'A target is required for this ability';
    end if;
    v_stack := public.put_action_on_stack(
      p_session_id, 'pump_creature',
      jsonb_build_object('target_card_id', p_target_card_id,
        'power', coalesce((v_effect ->> 'power')::integer, 0),
        'toughness', coalesce((v_effect ->> 'toughness')::integer, 0),
        'target_controller', v_target_controller, 'timing', 'instant'),
      p_source_card_id
    );

  elsif v_eff_type = 'grant_keyword' then
    if p_target_card_id is null then
      raise exception 'A target is required for this ability';
    end if;
    v_stack := public.put_action_on_stack(
      p_session_id, 'grant_keyword_creature',
      jsonb_build_object('target_card_id', p_target_card_id, 'keyword', lower(coalesce(v_effect ->> 'keyword', '')),
        'target_controller', v_target_controller, 'timing', 'instant'),
      p_source_card_id
    );

  elsif v_eff_type = 'equip' then
    -- Equip {N} (mig 266, Breya Equipment cluster): attach this Equipment to
    -- target creature you control. register_card_continuous_effects already
    -- lands affected:'equipped' rows on attached_to, so a re-register after
    -- the move grants the Equipment's bonuses to the new host. Sorcery-speed
    -- timing is not enforced (consistent with the engine's loose timing).
    if p_target_card_id is null then
      raise exception 'Equip needs a target creature you control';
    end if;
    if not exists (
      select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = p_target_card_id and gc.session_id = p_session_id
        and gc.zone = 'battlefield'
        and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
        and c.type_line ilike '%creature%'
    ) then
      raise exception 'Equip target must be a creature you control';
    end if;
    update public.game_cards
    set attached_to = p_target_card_id
    where id = p_source_card_id and session_id = p_session_id;
    perform public.rebuild_scripted_continuous_effects(p_session_id);
    v_stack := null;

  elsif v_eff_type = 'gain_control' then
    if p_target_card_id is null then
      raise exception 'A target is required for this ability';
    end if;
    v_stack := public.put_action_on_stack(
      p_session_id, 'gain_control_creature',
      jsonb_build_object('target_card_id', p_target_card_id,
        'duration', coalesce(v_effect ->> 'duration', 'permanent'),
        'untap', coalesce((v_effect ->> 'untap')::boolean, false),
        'haste', coalesce((v_effect ->> 'haste')::boolean, false),
        'target_controller', v_target_controller, 'timing', 'instant'),
      p_source_card_id
    );

  else
    raise exception 'Unsupported ability effect: %', v_eff_type;
  end if;

  return v_stack;
end;
$$;
grant execute on function public.activate_ability(uuid, uuid, integer, uuid, uuid, jsonb, integer, uuid[]) to authenticated;
grant execute on function public.activate_ability(uuid, uuid, integer, uuid, uuid, jsonb, integer, uuid[]) to service_role;

create or replace function public.cast_card_from_hand(
  p_session_id uuid,
  p_game_card_id uuid,
  p_generic_payment jsonb default null,
  p_target_card_id uuid default null,
  p_kicked boolean default false,
  p_sacrifice_ids uuid[] default null,
  -- The chosen X for an {X} permanent (mig 300). Stamped on the card's counter
  -- bag so its ETB can read it (create_token count:'X' → counters.x).
  p_x_value integer default null
) returns public.game_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_card public.game_cards;
  v_cast_zone text;
  v_card_type_line text;
  v_card_mana_cost text;
  v_is_aura boolean;
  v_pending_stack_count integer := 0;
  v_land_play_limit integer := 1;
  v_next_battlefield_position integer;
  v_next_stack_position integer;
  v_perm_id uuid;
  v_perm_once boolean;
  v_perm_source uuid;
  v_alt_cost jsonb;
  v_use_alt boolean := false;
  v_sac_needed integer := 0;
  v_sac_id uuid;
  v_enters_tapped jsonb;
  v_land_tapped boolean := false;
  v_unless jsonb;
  v_lib_perm jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status
  into v_session_status
  from public.game_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    raise exception 'Cannot cast cards in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can cast cards';
  end if;

  -- Source is normally the hand; a cast_from_graveyard permission also unlocks the
  -- graveyard (validated against the card's type below).
  select game_cards.*
  into v_card
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id
    and game_cards.owner_id = auth.uid()
    and game_cards.zone in ('hand', 'graveyard', 'exile', 'library')
  for update of game_cards;

  -- Original cast zone (v_card is later overwritten by the stack-move RETURNING).
  v_cast_zone := v_card.zone;

  if not found then
    raise exception 'Card not found in hand or not owned by current user';
  end if;

  select cards.type_line, cards.mana_cost
  into v_card_type_line, v_card_mana_cost
  from public.cards
  where cards.id = v_card.card_id;

  -- A graveyard source requires an active permission whose type filter matches.
  -- A permission may be ONCE-PER-TURN (mig 207, Gisa and Geralf "Once during
  -- each of your turns, you may cast a Zombie creature spell from your
  -- graveyard"): payload.once_per_turn:true, with the usage turn stamped in the
  -- SOURCE permanent's counter bag ('gy_cast_turn' — survives rebuilds, like the
  -- planeswalker loyalty_turn marker). Unrestricted permissions are preferred
  -- so a once-row isn't consumed needlessly.
  if v_card.zone = 'graveyard' then
    -- SELF-granted alternative graveyard cast (mig 213, Scourge of Nel Toth:
    -- "You may cast this creature from your graveyard by paying {B}{B} and
    -- sacrificing two creatures rather than paying its mana cost"). A card
    -- whose own script carries `graveyard_cast_cost` needs no permission row;
    -- the alternative cost replaces the printed one (paid below).
    v_alt_cost := public.effective_script(p_session_id, p_game_card_id) -> 'graveyard_cast_cost';
    if v_alt_cost is not null and jsonb_typeof(v_alt_cost) = 'object' then
      v_use_alt := true;
    end if;
  end if;

  if v_card.zone = 'graveyard' and not v_use_alt then
    select ce.id,
           coalesce((ce.payload ->> 'once_per_turn')::boolean, false),
           ce.source_card_id
    into v_perm_id, v_perm_once, v_perm_source
    from public.game_continuous_effects ce
    left join public.game_cards sc on sc.id = ce.source_card_id
    where ce.session_id = p_session_id
      and ce.effect_type = 'cast_from_graveyard'
      and ce.affected_player_id = auth.uid()
      and (
        coalesce(ce.payload ->> 'type_line', '') = ''
        or coalesce(v_card_type_line, '') ilike '%' || (ce.payload ->> 'type_line') || '%'
      )
      -- Card-specific permission (mig 215, Havengul Lich): only that card.
      and (
        ce.payload ->> 'card_id' is null
        or (ce.payload ->> 'card_id')::uuid = p_game_card_id
      )
      and (
        coalesce((ce.payload ->> 'once_per_turn')::boolean, false) is false
        or coalesce((sc.counters ->> 'gy_cast_turn')::integer, -1)
           is distinct from v_turn_state.turn_number
      )
    order by coalesce((ce.payload ->> 'once_per_turn')::boolean, false), ce.id
    limit 1;

    if v_perm_id is null then
      raise exception 'You do not have permission to cast that card from your graveyard';
    end if;

    if v_perm_once and v_perm_source is not null then
      update public.game_cards
      set counters = coalesce(counters, '{}'::jsonb)
            || jsonb_build_object('gy_cast_turn', v_turn_state.turn_number)
      where id = v_perm_source and session_id = p_session_id;
    end if;
  end if;

  -- Turn-stamped graveyard-cast tracker (mig 206, Laboratory Drudge) — counts
  -- permission casts AND alternative-cost self casts.
  if v_card.zone = 'graveyard' then
    perform public.note_graveyard_cast(p_session_id, auth.uid());
  end if;

  -- An EXILE source requires a play_from_exile permission (mig 230, Atsushi
  -- impulse) whose payload.card_ids includes this card. The permission is left
  -- in place (advance_step expires it at the end of the player's next turn); the
  -- card simply leaves exile when it resolves onto the battlefield.
  if v_card.zone = 'exile' then
    if not exists (
      select 1 from public.game_continuous_effects ce
      where ce.session_id = p_session_id
        and ce.effect_type = 'play_from_exile'
        and ce.affected_player_id = auth.uid()
        and (ce.payload -> 'card_ids') ? p_game_card_id::text
    ) then
      raise exception 'You do not have permission to play that card from exile';
    end if;
  end if;

  -- A LIBRARY source must be the TOP card of the owner's library, unlocked by
  -- a cast_from_library_top permission (mig 244, Thundermane Dragon) whose
  -- payload filter matches ({creature, min_power} read against the card).
  -- payload.grant_haste gives the cast card haste until end of turn ("if you
  -- cast a creature spell this way, it gains haste").
  if v_card.zone = 'library' then
    if exists (
      select 1 from public.game_cards lib
      where lib.session_id = p_session_id and lib.owner_id = auth.uid() and lib.zone = 'library'
        and (lib.zone_position < v_card.zone_position
             or (lib.zone_position = v_card.zone_position and lib.id < v_card.id))
    ) then
      raise exception 'Only the top card of your library can be cast this way';
    end if;
    select ce.payload into v_lib_perm
    from public.game_continuous_effects ce
    left join public.game_cards sc on sc.id = ce.source_card_id
    where ce.session_id = p_session_id
      and ce.effect_type = 'cast_from_library_top'
      and ce.affected_player_id = auth.uid()
      and (ce.source_zone_required is null or sc.zone = ce.source_zone_required)
      and (not coalesce((ce.payload ->> 'creature')::boolean, false)
           or coalesce(v_card_type_line, '') ilike '%creature%')
      and ((ce.payload ->> 'min_power') is null
           or coalesce(public.card_effective_power(p_session_id, p_game_card_id), -1)
              >= (ce.payload ->> 'min_power')::integer)
    limit 1;
    if v_lib_perm is null then
      raise exception 'You do not have permission to cast that card from your library';
    end if;
    if coalesce((v_lib_perm ->> 'grant_haste')::boolean, false) then
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_card_id, effect_type, payload,
        source_zone_required, expires_at_phase, expires_at_step)
      values (p_session_id, p_game_card_id, p_game_card_id, 'haste',
        jsonb_build_object('until_end_of_turn', true), 'battlefield', 'ending', 'cleanup');
    end if;
  end if;

  if coalesce(v_card_type_line, '') ilike '%instant%'
    or coalesce(v_card_type_line, '') ilike '%sorcery%'
  then
    raise exception 'Use this spell action to cast instant and sorcery cards';
  end if;

  if v_turn_state.active_player_id <> auth.uid() then
    raise exception 'Cards can only be played by the active player in this first implementation';
  end if;

  if v_turn_state.step not in ('precombat_main', 'postcombat_main') then
    raise exception 'Cards can only be played during a main phase';
  end if;

  select count(*)
  into v_pending_stack_count
  from public.game_stack_items
  where session_id = p_session_id
    and status = 'pending';

  if v_pending_stack_count > 0 then
    raise exception 'Cards can only be played while the stack is empty';
  end if;

  if coalesce(v_card_type_line, '') ilike '%land%' then
    v_land_play_limit := public.get_land_play_limit(p_session_id, auth.uid());

    if coalesce(v_turn_state.lands_played_this_turn, 0) >= v_land_play_limit then
      raise exception 'You have already used all land plays this turn';
    end if;

    update public.game_turn_state
    set lands_played_this_turn = lands_played_this_turn + 1
    where session_id = p_session_id;

    -- "This land enters tapped" (mig 217). Top-level script `enters_tapped`:
    --   true                                            — always tapped
    --   { "unless": { "count": <source>, "type_line"?, "at_least": N } }
    --     — untapped when the count condition holds (Sunken Hollow:
    --       basic_lands_you_control >= 2)
    --   { "unless": { "hand_has_type": ["Island","Swamp"] } }
    --     — untapped when your hand has a matching card (Choked Estuary's
    --       reveal, auto-applied — the reveal choice itself isn't modelled).
    v_enters_tapped := public.effective_script(p_session_id, p_game_card_id) -> 'enters_tapped';
    if v_enters_tapped is not null then
      if jsonb_typeof(v_enters_tapped) = 'boolean' then
        v_land_tapped := (v_enters_tapped)::text = 'true';
      elsif jsonb_typeof(v_enters_tapped) = 'object' then
        v_land_tapped := true;
        v_unless := v_enters_tapped -> 'unless';
        -- Each condition is independent so a card may OR several (Temple of the
        -- Dragon Queen: enters tapped unless you revealed a Dragon from hand OR
        -- you control a Dragon). Any satisfied condition untaps it.
        if v_unless ? 'count' then
          if public.resolve_count_amount(p_session_id, auth.uid(), v_unless)
             >= coalesce((v_unless ->> 'at_least')::integer, 1) then
            v_land_tapped := false;
          end if;
        end if;
        if v_unless ? 'hand_has_type' then
          if exists (
            select 1
            from public.game_cards gc
            join public.cards c on c.id = gc.card_id
            cross join lateral jsonb_array_elements_text(v_unless -> 'hand_has_type') as want(t)
            where gc.session_id = p_session_id and gc.owner_id = auth.uid()
              and gc.zone = 'hand' and gc.id <> p_game_card_id
              and c.type_line ilike '%' || want.t || '%'
          ) then
            v_land_tapped := false;
          end if;
        end if;
        if v_unless ? 'control_type' then
          -- Checklands (mig 225): "enters tapped unless you control a Forest or
          -- an Island." Untapped when you control a battlefield permanent whose
          -- type line matches any of the listed types.
          if exists (
            select 1
            from public.game_cards gc
            join public.cards c on c.id = gc.card_id
            cross join lateral jsonb_array_elements_text(v_unless -> 'control_type') as want(t)
            where gc.session_id = p_session_id
              and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
              and gc.zone = 'battlefield' and gc.id <> p_game_card_id
              and c.type_line ilike '%' || want.t || '%'
          ) then
            v_land_tapped := false;
          end if;
        end if;
      end if;
    end if;

    select coalesce(max(zone_position), -1) + 1
    into v_next_battlefield_position
    from public.game_cards
    where session_id = p_session_id
      and owner_id = auth.uid()
      and zone = 'battlefield';

    update public.game_cards
    set
      zone = 'battlefield',
      zone_position = v_next_battlefield_position,
      entered_battlefield_turn_number = v_turn_state.turn_number,
      controller_player_id = coalesce(controller_player_id, owner_id),
      is_tapped = v_land_tapped,
      damage_marked = 0
    where id = p_game_card_id
    returning * into v_card;

    perform public.rebuild_scripted_continuous_effects(p_session_id);

    return v_card;
  end if;

  -- Aura: validate the enchant target (a legal creature without protection from the
  -- Aura's colour) at announce; it rides in the cast_permanent payload to resolution.
  v_is_aura := coalesce(v_card_type_line, '') ilike '%aura%';
  if v_is_aura then
    if p_target_card_id is null then
      raise exception 'An Aura must target a creature to enchant';
    end if;
    if not public.creature_target_controller_ok(p_session_id, p_target_card_id, auth.uid(), 'any') then
      raise exception 'An Aura can only enchant a creature on the battlefield';
    end if;
    if public.card_has_protection_from_any(
         p_session_id, p_target_card_id, public.card_color_set(v_card_mana_cost)
       ) then
      raise exception 'Target creature has protection from this Aura''s colour and can''t be enchanted by it';
    end if;
  end if;

  if v_use_alt then
    -- Alternative graveyard cast cost (mig 213, Scourge of Nel Toth): pay the
    -- alternative mana RATHER THAN the printed cost, then sacrifice N creatures
    -- — the caster's chosen set (p_sacrifice_ids) when provided, else the
    -- engine auto-picks (zone order; client refinement). Sacrifices route
    -- through put_in_graveyard so dies triggers fire.
    if nullif(v_alt_cost ->> 'mana', '') is not null then
      perform public.pay_mana_cost(p_session_id, auth.uid(), v_alt_cost ->> 'mana', p_generic_payment,
        p_pay_context := jsonb_build_object('kind', 'cast', 'type_line', coalesce(v_card_type_line, ''),
          'is_commander', coalesce(v_card.is_commander, false)));
    end if;
    v_sac_needed := greatest(0, coalesce((v_alt_cost ->> 'sacrifice_creatures')::integer, 0));
    if v_sac_needed > 0 then
      if p_sacrifice_ids is not null then
        if cardinality(p_sacrifice_ids) <> v_sac_needed then
          raise exception 'This cast requires sacrificing exactly % creature(s)', v_sac_needed;
        end if;
        if (select count(*) from public.game_cards gc join public.cards c on c.id = gc.card_id
            where gc.id = any(p_sacrifice_ids) and gc.session_id = p_session_id
              and gc.zone = 'battlefield'
              and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
              and c.type_line ilike '%creature%') <> v_sac_needed
        then
          raise exception 'You can only sacrifice creatures you control';
        end if;
        foreach v_sac_id in array p_sacrifice_ids loop
          perform public.put_in_graveyard(p_session_id, v_sac_id);
        end loop;
      else
        if (select count(*) from public.game_cards gc join public.cards c on c.id = gc.card_id
            where gc.session_id = p_session_id and gc.zone = 'battlefield'
              and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
              and c.type_line ilike '%creature%') < v_sac_needed
        then
          raise exception 'You need % creature(s) to sacrifice for this cast', v_sac_needed;
        end if;
        for v_sac_id in
          select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
          where gc.session_id = p_session_id and gc.zone = 'battlefield'
            and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
            and c.type_line ilike '%creature%'
          order by gc.zone_position, gc.id
          limit v_sac_needed
        loop
          perform public.put_in_graveyard(p_session_id, v_sac_id);
        end loop;
      end if;
    end if;
  else
    -- Cost reduction (mig 231): reduce the generic portion before paying (e.g.
    -- "Dragon spells you cast cost {1} less" — Dragonlord's Servant).
    perform public.pay_mana_cost(
      p_session_id, auth.uid(),
      public.reduced_mana_cost(p_session_id, auth.uid(), p_game_card_id, v_card_mana_cost),
      p_generic_payment,
      p_pay_context := jsonb_build_object('kind', 'cast', 'type_line', coalesce(v_card_type_line, ''),
        'is_commander', coalesce(v_card.is_commander, false)));
  end if;

  -- Kicker (mig 211, Josu Vess): an OPTIONAL additional cost from the script's
  -- top-level `kicker` mana string. Paying it stamps 'kicked' in the card's
  -- counter bag (survives the stack→battlefield move and rebuilds); an ETB
  -- conditional reads it via { "counters": "kicked", "of": "self" }. Casting
  -- kicked without a kicker cost on the card is an error.
  if p_kicked then
    if nullif(public.effective_script(p_session_id, p_game_card_id) ->> 'kicker', '') is null then
      raise exception 'This card has no kicker cost';
    end if;
    perform public.pay_mana_cost(
      p_session_id, auth.uid(),
      public.effective_script(p_session_id, p_game_card_id) ->> 'kicker', null,
      p_pay_context := jsonb_build_object('kind', 'cast', 'type_line', coalesce(v_card_type_line, ''),
        'is_commander', coalesce(v_card.is_commander, false)));
    update public.game_cards
    set counters = coalesce(counters, '{}'::jsonb) || jsonb_build_object('kicked', 1)
    where id = p_game_card_id and session_id = p_session_id;
  end if;

  -- {X} permanent (mig 300, Champions from Beyond): stamp the chosen X in the
  -- counter bag so it survives the stack→battlefield move and its ETB can read
  -- it (create_token count:'X' → counters.x).
  if p_x_value is not null then
    update public.game_cards
    set counters = coalesce(counters, '{}'::jsonb) || jsonb_build_object('x', p_x_value)
    where id = p_game_card_id and session_id = p_session_id;
  end if;

  select coalesce(max(position), -1) + 1
  into v_next_stack_position
  from public.game_stack_items
  where session_id = p_session_id;

  update public.game_cards
  set
    zone = 'stack',
    zone_position = v_next_stack_position,
    is_tapped = false,
    damage_marked = 0
  where id = p_game_card_id
  returning * into v_card;

  insert into public.game_stack_items (
    session_id,
    controller_player_id,
    source_card_id,
    action_type,
    payload,
    position
  )
  values (
    p_session_id,
    auth.uid(),
    p_game_card_id,
    'cast_permanent',
    jsonb_build_object(
      'timing', 'sorcery',
      'card_id', v_card.card_id,
      'type_line', v_card_type_line
    ) || case when v_is_aura
            then jsonb_build_object('target_card_id', p_target_card_id)
            else '{}'::jsonb end,
    v_next_stack_position
  );

  -- "Whenever you/an opponent cast a spell" (mig 234, Taurean Mauler): a permanent
  -- spell is a spell too. (Lands return earlier, so they don't reach here.)
  perform public.fire_watcher_triggers(p_session_id, p_game_card_id, auth.uid(), 'spell_cast');

  -- "Whenever you cast a spell from exile" (mig 307, Urianger Augurelt): the
  -- source's ORIGINAL cast zone (v_card.zone is now 'stack' after the move).
  if v_cast_zone = 'exile' then
    perform public.fire_watcher_triggers(p_session_id, p_game_card_id, auth.uid(), 'cast_from_exile');
  end if;

  update public.game_turn_state
  set
    priority_player_id = active_player_id,
    priority_cycle_started_by = null,
    priority_pass_count = 0
  where session_id = p_session_id;

  return v_card;
end;
$$;
grant execute on function public.cast_card_from_hand(uuid, uuid, jsonb, uuid, boolean, uuid[], integer) to authenticated;

create or replace function public.cast_spell_effect(
  p_session_id uuid,
  p_actions jsonb,
  p_source_card_id uuid default null,
  p_x_value integer default null,
  p_target_card_id uuid default null,
  -- Adventure (mig 295): casting the adventure HALF of a card. On resolution the
  -- source goes to exile (not the graveyard) with a non-expiring play_from_exile
  -- permission, so the creature face can be cast from exile later.
  p_adventure boolean default false
)
returns public.game_stack_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn public.game_turn_state;
  v_session_status text;
  v_source_type_line text;
  v_source_is_commander boolean := false;
  v_source_zone text;
  v_source_mana_cost text;
  v_source_script jsonb;
  v_flashback_cost text;
  v_flashback_life integer;
  v_is_flashback boolean := false;
  v_program jsonb;
  v_timing text;
  v_pending integer;
  v_next_position integer;
  v_next_graveyard integer;
  v_next_exile integer;
  v_resolved_actions jsonb;
  v_stack public.game_stack_items;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if jsonb_typeof(p_actions) <> 'array' or jsonb_array_length(p_actions) < 1 then
    raise exception 'Spell effect needs at least one action';
  end if;

  select status into v_session_status
  from public.game_sessions where id = p_session_id for update;
  if not found then
    raise exception 'Game session not found';
  end if;
  if v_session_status = 'finished' then
    raise exception 'Cannot cast in a finished game session';
  end if;

  select * into v_turn
  from public.game_turn_state where session_id = p_session_id for update;
  if not found then
    raise exception 'Turn state not found';
  end if;
  if coalesce(v_turn.priority_player_id, v_turn.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can cast';
  end if;

  if p_source_card_id is not null then
    select cards.type_line, cards.mana_cost, game_cards.zone, cards.script,
           coalesce(game_cards.is_commander, false)
      into v_source_type_line, v_source_mana_cost, v_source_zone, v_source_script,
           v_source_is_commander
    from public.game_cards
    join public.cards on cards.id = game_cards.card_id
    where game_cards.id = p_source_card_id
      and game_cards.session_id = p_session_id
      and game_cards.owner_id = auth.uid();
    if not found then
      raise exception 'Source card not found or not owned by current user';
    end if;
  end if;

  -- Timing: instants any time the caster has priority; sorceries main-phase only,
  -- empty stack, active player. A sourceless cast (tests) defaults to instant.
  if v_source_type_line ilike '%sorcery%' then
    v_timing := 'sorcery';
  else
    v_timing := 'instant';
  end if;

  if v_timing = 'sorcery' then
    if v_turn.active_player_id <> auth.uid() then
      raise exception 'Sorcery actions can only be used by the active player';
    end if;
    if v_turn.step not in ('precombat_main', 'postcombat_main') then
      raise exception 'Sorcery actions can only be used during a main phase';
    end if;
    select count(*) into v_pending
    from public.game_stack_items
    where session_id = p_session_id and status = 'pending';
    if v_pending > 0 then
      raise exception 'Sorcery actions can only be used while the stack is empty';
    end if;
  end if;

  -- The spell program. A FLASHBACK (graveyard) cast uses the script's
  -- `flashback_effect` actions when present, REPLACING the normal effect (the
  -- "Increasing …" cards do more / different on flashback). The engine selects by
  -- cast zone — it does not trust the client's actions for the flashback effect.
  if v_source_zone = 'graveyard'
     and jsonb_typeof(v_source_script -> 'flashback_effect' -> 'actions') = 'array'
     and jsonb_array_length(v_source_script -> 'flashback_effect' -> 'actions') > 0 then
    v_program := v_source_script -> 'flashback_effect' -> 'actions';
  else
    v_program := p_actions;
  end if;

  -- Resolve any top-level "X" amount/count to the caster-chosen x_value before it
  -- is stored on the stack item (resolution code never sees the "X" token).
  select coalesce(jsonb_agg(
    case
      when (elem ->> 'amount') = 'X' or (elem ->> 'count') = 'X' then
        elem
          || (case when (elem ->> 'amount') = 'X'
                then jsonb_build_object('amount', greatest(coalesce(p_x_value, 0), 0)) else '{}'::jsonb end)
          || (case when (elem ->> 'count') = 'X'
                then jsonb_build_object('count', greatest(coalesce(p_x_value, 0), 0)) else '{}'::jsonb end)
      else elem
    end
    order by ord
  ), '[]'::jsonb)
  into v_resolved_actions
  from jsonb_array_elements(v_program) with ordinality as t(elem, ord);

  -- Pay the cast cost. A hand cast pays the printed mana cost (incl {X}). A graveyard
  -- cast is a FLASHBACK: it requires the card's script to carry a `flashback` cost,
  -- pays that instead, and marks the card for exile (below). No-op when the source is
  -- sourceless or free (the free-cast test fixtures).
  if p_source_card_id is not null and v_source_zone = 'hand' then
    if v_source_mana_cost is not null and btrim(v_source_mana_cost) <> '' then
      -- Cost reduction (mig 231, Draconic Lore: "costs {2} less if you control a
      -- Dragon"). Generic mana is auto-paid here (null generic payment), so the
      -- reduced cost is consumed with no client change.
      perform public.pay_mana_cost(
        p_session_id, auth.uid(),
        public.reduced_mana_cost(p_session_id, auth.uid(), p_source_card_id, v_source_mana_cost),
        null, coalesce(p_x_value, 0),
        p_pay_context := jsonb_build_object('kind', 'cast', 'type_line', coalesce(v_source_type_line, ''),
          'is_commander', v_source_is_commander));
    end if;
  elsif p_source_card_id is not null and v_source_zone = 'graveyard' then
    v_flashback_cost := v_source_script ->> 'flashback';
    if v_flashback_cost is null then
      raise exception 'This card cannot be cast from your graveyard';
    end if;
    v_is_flashback := true;
    if btrim(v_flashback_cost) <> '' then
      perform public.pay_mana_cost(p_session_id, auth.uid(), v_flashback_cost, null, coalesce(p_x_value, 0),
        p_pay_context := jsonb_build_object('kind', 'cast', 'type_line', coalesce(v_source_type_line, ''),
          'is_commander', v_source_is_commander));
    end if;
    -- Additional "Pay N life" flashback cost (Deep Analysis). You cannot pay life
    -- you do not have.
    v_flashback_life := coalesce((v_source_script ->> 'flashback_life')::integer, 0);
    if v_flashback_life > 0 then
      if (select life_total from public.game_session_players
          where session_id = p_session_id and player_id = auth.uid()) < v_flashback_life then
        raise exception 'Not enough life to pay the flashback cost (need %)', v_flashback_life;
      end if;
      update public.game_session_players
      set life_total = life_total - v_flashback_life
      where session_id = p_session_id and player_id = auth.uid();
    end if;
    -- Turn-stamped graveyard-cast tracker (mig 206, Laboratory Drudge).
    perform public.note_graveyard_cast(p_session_id, auth.uid());
  end if;

  select coalesce(max(position), 0) + 1 into v_next_position
  from public.game_stack_items where session_id = p_session_id;

  insert into public.game_stack_items (
    session_id, controller_player_id, source_card_id, action_type, payload, position, status
  )
  values (
    p_session_id,
    auth.uid(),
    p_source_card_id,
    'spell_effect',
    jsonb_build_object('effects', v_resolved_actions, 'controller_player_id', auth.uid(), 'timing', v_timing)
      || (case when p_target_card_id is not null
               then jsonb_build_object('target_card_id', p_target_card_id) else '{}'::jsonb end),
    v_next_position,
    'pending'
  )
  returning * into v_stack;

  -- "Whenever you/an opponent cast a spell" (mig 234, Taurean Mauler): broadcast
  -- the cast to spell_cast watchers. The caster is the source's controller.
  if p_source_card_id is not null then
    perform public.fire_watcher_triggers(p_session_id, p_source_card_id, auth.uid(), 'spell_cast');
    -- "Whenever you cast a spell from exile" (mig 307, Urianger Augurelt).
    if v_source_zone = 'exile' then
      perform public.fire_watcher_triggers(p_session_id, p_source_card_id, auth.uid(), 'cast_from_exile');
    end if;
  end if;

  -- Adventure (mig 295): the card is exiled with a non-expiring play_from_exile
  -- permission so its creature face can be cast from exile later. Checked before
  -- the type_line graveyard rule because the source is a CREATURE card.
  if p_adventure and p_source_card_id is not null then
    select coalesce(max(zone_position), -1) + 1 into v_next_exile
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'exile';

    update public.game_cards
    set zone = 'exile', zone_position = v_next_exile, controller_player_id = owner_id,
        is_tapped = false, damage_marked = 0
    where id = p_source_card_id;

    insert into public.game_continuous_effects (
      session_id, source_card_id, affected_player_id, effect_type, payload
    ) values (
      p_session_id, p_source_card_id, auth.uid(), 'play_from_exile',
      jsonb_build_object('card_ids', jsonb_build_array(p_source_card_id), 'permanent', true)
    );

  -- Non-permanent spell leaves its cast zone on cast: a hand cast goes to the
  -- graveyard; a flashback cast (from the graveyard) is exiled instead.
  elsif v_is_flashback then
    select coalesce(max(zone_position), -1) + 1 into v_next_exile
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'exile';

    update public.game_cards
    set zone = 'exile', zone_position = v_next_exile, controller_player_id = owner_id,
        is_tapped = false, damage_marked = 0
    where id = p_source_card_id;

  elsif p_source_card_id is not null
    and v_source_zone = 'hand'
    and (v_source_type_line ilike '%instant%' or v_source_type_line ilike '%sorcery%')
  then
    select coalesce(max(zone_position), -1) + 1 into v_next_graveyard
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'graveyard';

    update public.game_cards
    set zone = 'graveyard', zone_position = v_next_graveyard, is_tapped = false, damage_marked = 0
    where id = p_source_card_id;
  end if;

  return v_stack;
end;
$$;
grant execute on function public.cast_spell_effect(uuid, jsonb, uuid, integer, uuid, boolean) to authenticated;

create or replace function public.cast_commander(
  p_session_id uuid,
  p_game_card_id uuid,
  p_generic_payment jsonb default null
) returns public.game_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn public.game_turn_state;
  v_card public.game_cards;
  v_type_line text;
  v_mana_cost text;
  v_tax integer;
  v_pending integer := 0;
  v_next_stack_position integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status into v_session_status
  from public.game_sessions where id = p_session_id for update;
  if not found then
    raise exception 'Game session not found';
  end if;
  if v_session_status = 'finished' then
    raise exception 'Cannot cast in a finished game session';
  end if;

  select * into v_turn
  from public.game_turn_state where session_id = p_session_id for update;
  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn.priority_player_id, v_turn.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can cast';
  end if;
  if v_turn.active_player_id <> auth.uid() then
    raise exception 'A commander can only be cast by the active player';
  end if;
  if v_turn.step not in ('precombat_main', 'postcombat_main') then
    raise exception 'A commander can only be cast during a main phase';
  end if;

  select count(*) into v_pending
  from public.game_stack_items
  where session_id = p_session_id and status = 'pending';
  if v_pending > 0 then
    raise exception 'A commander can only be cast while the stack is empty';
  end if;

  -- The caster's commander, in their command zone.
  select game_cards.* into v_card
  from public.game_cards
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id
    and game_cards.owner_id = auth.uid()
    and game_cards.is_commander = true
    and game_cards.zone = 'command'
  for update of game_cards;
  if not found then
    raise exception 'Commander not found in your command zone';
  end if;

  select cards.type_line, cards.mana_cost
  into v_type_line, v_mana_cost
  from public.cards where cards.id = v_card.card_id;

  v_tax := 2 * v_card.command_zone_casts;

  -- Pay the printed cost (after static cost reductions — mig 291: Nogi /
  -- Dragonlord's Servant discount command-zone casts too), then the tax
  -- (extra generic). Two calls keep the math simple; both run in this RPC's
  -- transaction, so either failing rolls back. Nuance: the reduction applies
  -- to the printed part only — by strict rules it could also eat commander
  -- tax when the printed generic runs out.
  perform public.pay_mana_cost(p_session_id, auth.uid(),
    public.reduced_mana_cost(p_session_id, auth.uid(), p_game_card_id, v_mana_cost),
    p_generic_payment,
    p_pay_context := jsonb_build_object('kind', 'cast', 'type_line', coalesce(v_type_line, ''),
      'is_commander', true));
  if v_tax > 0 then
    perform public.pay_mana_cost(p_session_id, auth.uid(), '{' || v_tax || '}', null,
      p_pay_context := jsonb_build_object('kind', 'cast', 'type_line', coalesce(v_type_line, ''),
        'is_commander', true));
  end if;

  -- A cast from the command zone bumps the tax for next time (CR 903.8).
  update public.game_cards
  set command_zone_casts = command_zone_casts + 1,
      zone = 'stack',
      zone_position = 0,
      is_tapped = false,
      damage_marked = 0
  where id = p_game_card_id;

  select coalesce(max(position), -1) + 1
  into v_next_stack_position
  from public.game_stack_items
  where session_id = p_session_id;

  insert into public.game_stack_items (
    session_id, controller_player_id, source_card_id, action_type, payload, position
  )
  values (
    p_session_id, auth.uid(), p_game_card_id, 'cast_permanent',
    jsonb_build_object('timing', 'sorcery', 'card_id', v_card.card_id, 'type_line', v_type_line),
    v_next_stack_position
  );

  update public.game_turn_state
  set priority_player_id = active_player_id,
      priority_cycle_started_by = null,
      priority_pass_count = 0
  where session_id = p_session_id;

  select * into v_card from public.game_cards where id = p_game_card_id;
  return v_card;
end;
$$;
grant execute on function public.cast_commander(uuid, uuid, jsonb) to authenticated;

create or replace function public.put_action_on_stack(
  p_session_id uuid,
  p_action_type text,
  p_payload jsonb,
  p_source_card_id uuid default null
)
returns public.game_stack_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_action_timing text;
  v_target_controller text;
  v_source_type_line text;
  v_source_is_commander boolean := false;
  v_source_zone text;
  v_source_mana_cost text;
  v_generic_payment jsonb;
  v_x_value integer;
  v_pending_stack_count integer;
  v_next_graveyard_position integer;
  v_next_position integer;
  v_builder_fn text;
  v_built_payload jsonb;
  v_stack_item public.game_stack_items;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status
  into v_session_status
  from public.game_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    raise exception 'Cannot put actions on the stack in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can put actions on the stack';
  end if;

  select builder_fn
  into v_builder_fn
  from public.stack_action_handlers
  where action_type = p_action_type;

  if v_builder_fn is null then
    raise exception 'Unsupported stack action type: %', p_action_type;
  end if;

  if p_source_card_id is not null then
    select cards.type_line, cards.mana_cost, game_cards.zone,
           coalesce(game_cards.is_commander, false)
    into v_source_type_line, v_source_mana_cost, v_source_zone,
         v_source_is_commander
    from public.game_cards
    join public.cards
      on cards.id = game_cards.card_id
    where game_cards.id = p_source_card_id
      and game_cards.session_id = p_session_id
      and game_cards.owner_id = auth.uid();

    if not found then
      raise exception 'Source card not found or not owned by current user';
    end if;
  end if;

  v_action_timing := lower(nullif(p_payload ->> 'timing', ''));

  if v_action_timing is null then
    if v_source_type_line ilike '%instant%' then
      v_action_timing := 'instant';
    elsif v_source_type_line ilike '%sorcery%' then
      v_action_timing := 'sorcery';
    else
      raise exception 'Action timing is required for non-Instant and non-Sorcery sources';
    end if;
  end if;

  if v_action_timing not in ('instant', 'sorcery') then
    raise exception 'Unsupported action timing: %', v_action_timing;
  end if;

  if p_action_type = 'counter_spell' and v_action_timing <> 'instant' then
    raise exception 'Counterspell actions must use instant timing';
  end if;

  if v_action_timing = 'sorcery' then
    if v_turn_state.active_player_id <> auth.uid() then
      raise exception 'Sorcery actions can only be used by the active player';
    end if;

    if v_turn_state.step not in ('precombat_main', 'postcombat_main') then
      raise exception 'Sorcery actions can only be used during a main phase';
    end if;

    select count(*)
    into v_pending_stack_count
    from public.game_stack_items
    where session_id = p_session_id
      and status = 'pending';

    if v_pending_stack_count > 0 then
      raise exception 'Sorcery actions can only be used while the stack is empty';
    end if;
  end if;

  v_generic_payment := p_payload -> 'generic_payment';
  v_x_value := coalesce((p_payload ->> 'x_value')::integer, 0);
  v_target_controller := coalesce(lower(nullif(p_payload ->> 'target_controller', '')), 'any');

  execute format('select public.%I($1, $2, $3, $4, $5)', v_builder_fn)
    into v_built_payload
    using p_session_id, auth.uid(), p_payload, v_action_timing, v_target_controller;

  -- Protection (CR 702.16e): a creature with protection from any of the source's
  -- colours can't be targeted. The target rode through the builder as target_card_id.
  if v_built_payload ? 'target_card_id'
     and public.card_has_protection_from_any(
           p_session_id,
           nullif(v_built_payload ->> 'target_card_id', '')::uuid,
           public.card_color_set(v_source_mana_cost))
  then
    raise exception 'Target has protection from this spell''s colour';
  end if;

  -- Hexproof: a permanent can't be targeted by a spell/ability an OPPONENT controls
  -- (the actor here is auth.uid(); you can still target your own hexproof permanents).
  if v_built_payload ? 'target_card_id'
     and public.card_has_hexproof(p_session_id, nullif(v_built_payload ->> 'target_card_id', '')::uuid)
     and (select coalesce(gc.controller_player_id, gc.owner_id)
          from public.game_cards gc
          where gc.id = nullif(v_built_payload ->> 'target_card_id', '')::uuid
            and gc.session_id = p_session_id) is distinct from auth.uid()
  then
    raise exception 'Target has hexproof and can''t be targeted by an opponent';
  end if;

  -- PLAYER hexproof (mig 203, Lazotep Plating "You … gain hexproof"): a player
  -- covered by an active hexproof grant with payload.includes_player can't be
  -- targeted by an opponent's spell/ability (targeting yourself stays legal).
  if v_built_payload ? 'target_player_id'
     and nullif(v_built_payload ->> 'target_player_id', '')::uuid is distinct from auth.uid()
     and exists (
       select 1 from public.game_continuous_effects effects
       where effects.session_id = p_session_id
         and effects.effect_type = 'hexproof'
         and effects.affected_card_id is null
         and (effects.payload ->> 'includes_player')::boolean is true
         and (effects.affected_player_id is null
              or effects.affected_player_id = nullif(v_built_payload ->> 'target_player_id', '')::uuid)
     )
  then
    raise exception 'Target player has hexproof and can''t be targeted by an opponent';
  end if;

  if p_source_card_id is not null and v_source_zone = 'hand' then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_source_mana_cost, v_generic_payment, v_x_value,
      p_pay_context := jsonb_build_object('kind', 'cast', 'type_line', coalesce(v_source_type_line, ''),
        'is_commander', v_source_is_commander));
  end if;

  select coalesce(max(position), -1) + 1
  into v_next_position
  from public.game_stack_items
  where session_id = p_session_id;

  insert into public.game_stack_items (
    session_id,
    controller_player_id,
    source_card_id,
    action_type,
    payload,
    position
  )
  values (
    p_session_id,
    auth.uid(),
    p_source_card_id,
    p_action_type,
    v_built_payload,
    v_next_position
  )
  returning * into v_stack_item;

  -- "Becomes the target of a spell or ability an opponent controls" (mig 235,
  -- Thunderbreak Regent). The target is locked in; the actor is auth.uid().
  if v_built_payload ? 'target_card_id' then
    perform public.fire_becomes_target_triggers(
      p_session_id, nullif(v_built_payload ->> 'target_card_id', '')::uuid, auth.uid());
  end if;

  if p_source_card_id is not null
     and coalesce((p_payload ->> 'adventure')::boolean, false)
  then
    -- Adventure (mig 296): the action is the adventure half of a creature card —
    -- exile the source with a non-expiring play_from_exile permission so its
    -- creature face can be cast from exile later (Hypnotic Sprite // Mesmeric
    -- Glare). Mirrors cast_spell_effect's p_adventure path (mig 295).
    update public.game_cards
    set
      zone = 'exile',
      zone_position = (
        select coalesce(max(zone_position), -1) + 1 from public.game_cards
        where session_id = p_session_id and owner_id = auth.uid() and zone = 'exile'),
      controller_player_id = owner_id,
      is_tapped = false,
      damage_marked = 0
    where id = p_source_card_id;

    insert into public.game_continuous_effects (
      session_id, source_card_id, affected_player_id, effect_type, payload
    ) values (
      p_session_id, p_source_card_id, auth.uid(), 'play_from_exile',
      jsonb_build_object('card_ids', jsonb_build_array(p_source_card_id), 'permanent', true));

  elsif p_source_card_id is not null
    and v_source_zone = 'hand'
    and (
      v_source_type_line ilike '%instant%'
      or v_source_type_line ilike '%sorcery%'
    )
  then
    select coalesce(max(zone_position), -1) + 1
    into v_next_graveyard_position
    from public.game_cards
    where session_id = p_session_id
      and owner_id = auth.uid()
      and zone = 'graveyard';

    update public.game_cards
    set
      zone = 'graveyard',
      zone_position = v_next_graveyard_position,
      is_tapped = false,
      damage_marked = 0
    where id = p_source_card_id;
  end if;

  return v_stack_item;
end;
$$;
grant execute on function public.put_action_on_stack(uuid, text, jsonb, uuid) to authenticated;

create or replace function public.clear_mana_pool_for_step(
  p_session_id uuid,
  p_phase text,
  p_step text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empty_pool jsonb := jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0);
  v_player record;
  v_retained_colors text[];
  v_new_pool jsonb;
  v_color text;
  v_updated_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  for v_player in
    select
      player_id,
      coalesce(mana_pool, v_empty_pool) as mana_pool,
      coalesce(restricted_mana, '[]'::jsonb) as restricted_mana
    from public.game_players
    where session_id = p_session_id
    for update
  loop
    select coalesce(array_agg(distinct retained.color), '{}'::text[])
    into v_retained_colors
    from public.game_continuous_effects effects
    left join public.game_cards source_card
      on source_card.id = effects.source_card_id
    cross join lateral jsonb_array_elements_text(
      coalesce(effects.payload -> 'colors', '[]'::jsonb)
    ) as retained(color)
    where effects.session_id = p_session_id
      and effects.effect_type = 'mana_does_not_empty'
      and (effects.affected_player_id is null or effects.affected_player_id = v_player.player_id)
      and (
        effects.source_zone_required is null
        or source_card.zone = effects.source_zone_required
      );

    v_new_pool := v_empty_pool;

    foreach v_color in array array['W', 'U', 'B', 'R', 'G', 'C']
    loop
      if v_color = any(v_retained_colors) then
        v_new_pool := v_new_pool || jsonb_build_object(
          v_color,
          coalesce((v_player.mana_pool ->> v_color)::integer, 0)
        );
      end if;
    end loop;

    if v_new_pool <> v_player.mana_pool or v_player.restricted_mana <> '[]'::jsonb then
      update public.game_players
      set mana_pool = v_new_pool,
          restricted_mana = '[]'::jsonb
      where session_id = p_session_id
        and player_id = v_player.player_id;

      v_updated_count := v_updated_count + 1;
    end if;
  end loop;

  return v_updated_count;
end;
$$;
grant execute on function public.clear_mana_pool_for_step(uuid, text, text) to authenticated;
grant execute on function public.clear_mana_pool_for_step(uuid, text, text) to service_role;
