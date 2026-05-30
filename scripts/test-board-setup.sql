-- Test board setup for the new mechanics (deathtouch, +1/+1 counters, pumps,
-- tokens, creature-targeting spells).
--
-- HOW TO USE
--   1. Apply migrations 067-071 first.
--   2. Fill in the three UUIDs below (session + the two players).
--      Find them with:
--        select id from public.game_sessions order by created_at desc limit 5;
--        select player_id, username, seat_number from public.get_session_players('<session-id>');
--      (or: select player_id, seat_number from public.game_session_players where session_id = '<session-id>';)
--   3. Paste the whole file into the Supabase SQL editor and run it.
--   4. Open /controller/<session>?v=4 as player A. You start in your main phase
--      with full mana, two creatures and two spells in hand.
--
-- This writes rows directly (no RPC auth context in the SQL editor). It is
-- idempotent-ish: re-running spawns another set of creatures/cards.

do $$
declare
  -- ───────── EDIT THESE THREE ─────────
  v_session   uuid := '00000000-0000-0000-0000-000000000000';  -- game session id
  v_player_a  uuid := '00000000-0000-0000-0000-000000000000';  -- attacker / active player
  v_player_b  uuid := '00000000-0000-0000-0000-000000000000';  -- defender
  -- ─────────────────────────────────────

  v_turn      integer;
  c_trampler  uuid;
  c_beast     uuid;
  c_viper     uuid;
  c_bolt      uuid;
  c_growth    uuid;
  v_id        uuid;
  v_pos       integer;
  v_full_pool jsonb := jsonb_build_object('W',8,'U',8,'B',8,'R',8,'G',8,'C',8);
begin
  select coalesce(turn_number, 1) into v_turn
  from public.game_turn_state where session_id = v_session;
  v_turn := coalesce(v_turn, 1);

  select id into c_trampler from public.cards where lower(name) = 'deathtouch trampler test' limit 1;
  select id into c_beast    from public.cards where lower(name) = 'beast token'              limit 1;
  select id into c_viper    from public.cards where lower(name) = 'deathtouch viper test'    limit 1;
  select id into c_bolt     from public.cards where lower(name) = 'lightning strike test'    limit 1;
  select id into c_growth   from public.cards where lower(name) = 'giant growth test'        limit 1;

  if c_trampler is null or c_beast is null or c_viper is null or c_bolt is null or c_growth is null then
    raise exception 'Seeded test cards missing — apply migrations 067-071 first';
  end if;

  -- ── Player A battlefield: a 3/3 Beast (your buff target/attacker, +2/+2 counters)
  select coalesce(max(zone_position), -1) + 1 into v_pos
  from public.game_cards where session_id = v_session and owner_id = v_player_a and zone = 'battlefield';
  insert into public.game_cards (session_id, card_id, owner_id, controller_player_id, zone, zone_position, entered_battlefield_turn_number, plus_one_counters)
  values (v_session, c_beast, v_player_a, v_player_a, 'battlefield', v_pos, 0, 2)
  returning id into v_id;
  -- (no continuous effects: vanilla beast)

  -- ── Player A battlefield: Deathtouch Trampler (5/5 deathtouch + trample)
  select coalesce(max(zone_position), -1) + 1 into v_pos
  from public.game_cards where session_id = v_session and owner_id = v_player_a and zone = 'battlefield';
  insert into public.game_cards (session_id, card_id, owner_id, controller_player_id, zone, zone_position, entered_battlefield_turn_number)
  values (v_session, c_trampler, v_player_a, v_player_a, 'battlefield', v_pos, 0)
  returning id into v_id;
  insert into public.game_continuous_effects (session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required)
  values
    (v_session, v_id, v_id, 'deathtouch', '{"registered_from_card_script":true}'::jsonb, 'battlefield'),
    (v_session, v_id, v_id, 'trample',    '{"registered_from_card_script":true}'::jsonb, 'battlefield');

  -- ── Player B battlefield: a 3/3 Beast (vanilla blocker)
  select coalesce(max(zone_position), -1) + 1 into v_pos
  from public.game_cards where session_id = v_session and owner_id = v_player_b and zone = 'battlefield';
  insert into public.game_cards (session_id, card_id, owner_id, controller_player_id, zone, zone_position, entered_battlefield_turn_number)
  values (v_session, c_beast, v_player_b, v_player_b, 'battlefield', v_pos, 0);

  -- ── Player B battlefield: Deathtouch Viper (1/1 deathtouch blocker)
  select coalesce(max(zone_position), -1) + 1 into v_pos
  from public.game_cards where session_id = v_session and owner_id = v_player_b and zone = 'battlefield';
  insert into public.game_cards (session_id, card_id, owner_id, controller_player_id, zone, zone_position, entered_battlefield_turn_number)
  values (v_session, c_viper, v_player_b, v_player_b, 'battlefield', v_pos, 0)
  returning id into v_id;
  insert into public.game_continuous_effects (session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required)
  values (v_session, v_id, v_id, 'deathtouch', '{"registered_from_card_script":true}'::jsonb, 'battlefield');

  -- ── Player A hand: Lightning Strike + Giant Growth
  select coalesce(max(zone_position), -1) + 1 into v_pos
  from public.game_cards where session_id = v_session and owner_id = v_player_a and zone = 'hand';
  insert into public.game_cards (session_id, card_id, owner_id, controller_player_id, zone, zone_position)
  values (v_session, c_bolt, v_player_a, v_player_a, 'hand', v_pos);

  select coalesce(max(zone_position), -1) + 1 into v_pos
  from public.game_cards where session_id = v_session and owner_id = v_player_a and zone = 'hand';
  insert into public.game_cards (session_id, card_id, owner_id, controller_player_id, zone, zone_position)
  values (v_session, c_growth, v_player_a, v_player_a, 'hand', v_pos);

  -- ── Give player A a full mana pool so the spells are castable
  insert into public.game_players (session_id, player_id, mana_pool)
  values (v_session, v_player_a, v_full_pool)
  on conflict (session_id, player_id) do update set mana_pool = excluded.mana_pool;

  -- ── Turn state: player A active, holding priority, in the precombat main phase
  update public.game_turn_state
  set
    active_player_id = v_player_a,
    priority_player_id = v_player_a,
    priority_cycle_started_by = null,
    priority_pass_count = 0,
    phase = 'main_1',
    step = 'precombat_main'
  where session_id = v_session;

  raise notice 'Test board ready for session %, player A %, player B %', v_session, v_player_a, v_player_b;
end $$;
