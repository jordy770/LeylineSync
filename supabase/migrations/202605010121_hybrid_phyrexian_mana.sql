-- Phase 4 — richer mana model: HYBRID and PHYREXIAN symbols. (X already shipped,
-- mig 109.) Real Scryfall costs already arrive as {W/U} / {2/W} / {W/P}; until
-- now pay_mana_cost stripped the braces+slash and mis-tokenized them (e.g. {W/U}
-- -> "WU" demanded BOTH colors; {W/P} -> "WP" dropped the P). This teaches the
-- parser the three hybrid shapes and a per-symbol payment CHOICE:
--
--   {W/U}  two-colour hybrid  — pay 1 of EITHER colour
--   {2/W}  monocoloured hybrid — pay 2 generic OR 1 white
--   {W/P}  Phyrexian          — pay 1 white OR 2 LIFE
--
-- ONE SEAM: pay_mana_cost gains p_hybrid_payment (default null) — a JSON array of
-- choice tokens, one per hybrid symbol in left-to-right order. Each token is a
-- colour letter ('W'), 'LIFE' (Phyrexian life), or 'GENERIC'/the number (monohybrid
-- generic side). When the array is absent/short the server AUTO-resolves each
-- symbol with a sensible default: prefer paying mana you have over losing life,
-- and the cheaper colour side of a monohybrid when available. Phyrexian is the
-- first mana path that can deduct LIFE (game_session_players.life_total).
--
-- Dropped + recreated (not a new overload) so every existing 4-/5-arg caller
-- resolves to the one 6-arg function via the default. Casters (put_action_on_stack,
-- cast_card_from_hand, cast_spell_effect) are UNCHANGED — they rely on the
-- auto-default, so hybrid/Phyrexian cards are castable without a client picker.
-- Threading an explicit choice from the client (a hybrid/life picker) is a shared
-- UI follow-up, like the generic-mana picker (see fight mig 103). Verbatim from
-- mig 109 except the new param, the hybrid declares, the rewritten symbol loop,
-- and the trailing life-payment block. (IDE T-SQL false-positives on $$ — ignore.)

drop function if exists public.pay_mana_cost(uuid, uuid, text, jsonb, integer);

create or replace function public.pay_mana_cost(
  p_session_id uuid,
  p_player_id uuid,
  p_mana_cost text,
  p_generic_payment jsonb default null,
  p_x_value integer default 0,
  p_hybrid_payment jsonb default null
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

  select coalesce(mana_pool, v_empty_pool)
  into v_current_pool
  from public.game_players
  where session_id = p_session_id
    and player_id = p_player_id
  for update;

  v_new_pool := v_current_pool;
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

  update public.game_players
  set mana_pool = v_new_pool
  where session_id = p_session_id
    and player_id = p_player_id;

  return v_new_pool;
end;
$_$;

grant execute on function public.pay_mana_cost(uuid, uuid, text, jsonb, integer, jsonb) to anon;
grant execute on function public.pay_mana_cost(uuid, uuid, text, jsonb, integer, jsonb) to authenticated;
grant execute on function public.pay_mana_cost(uuid, uuid, text, jsonb, integer, jsonb) to service_role;
