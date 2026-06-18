-- supabase/functions_src/pay_mana_cost.sql
-- CANONICAL current definition (seeded from 202605010121_hybrid_phyrexian_mana.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

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
