# Test plan — migrations 079–086

Manual test plan for the spell-effect / trigger / rules-engine work. Migrations
**079–083** add new behavior; **084–086** are behavior-preserving refactors, so
they are validated by **regression** (Group 1) — if the old features still work
after applying them, the refactor held.

- **084** `put_in_graveyard` — single battlefield→graveyard chokepoint
- **085** `effective_script` — single face/script accessor
- **086** `apply_creature_effect` — single creature-mutation switch

All nine functions confirmed present with expected signatures (activate_ability,
apply_creature_effect, apply_targeted_triggered_ability_effects,
apply_triggered_ability_effects, effective_script, fire_card_triggers,
put_in_graveyard, register_card_continuous_effects, resolve_top_of_stack).

> Setup: a **2-player** game (two controller views) is required for every
> "opponent's creature" test. Use the Dev/Judge tools to drop `% Test` cards
> into hands/battlefields. Keep the Supabase SQL editor open for state checks.

## ⚠️ Known data issues to verify first

- [ ] **Giant Growth Test** and **Lightning Strike Test** — script shape differs
      from the others: `actions` is at the **top level**, not under
      `spell_effect`, and `schema_version` is missing. They may **fail to cast**
      (not recognized by `getSpellPlan`). If so, it's **card data**, not the
      engine — fix the seed to `{"schema_version":2,"spell_effect":{"actions":[…]}}`.
      Use **Doom Blade Test** (destroy) and **Prodigal Sorcerer Test** (damage)
      as engine-side substitutes for those paths.
- [ ] **Memory Test** (`{}`, Attraction) and **Perplexing Test** (`{}`, modal
      "Choose one") have empty scripts → **no behavior expected**. These are the
      Phase 1 (pending-decision) candidates; not testable now. (Perplexing Test
      is also seeded twice — harmless dup.)

## SQL helpers

```sql
-- Ground truth for any card
select name, type_line, oracle_text, script from public.cards where name like '% Test' order by name;

-- Board state (swap SESSION_ID)
select c.name, gc.zone, gc.zone_position, gc.is_tapped, gc.damage_marked,
       gc.plus_one_counters, gc.owner_id, gc.controller_player_id
from public.game_cards gc join public.cards c on c.id = gc.card_id
where gc.session_id = '<SESSION_ID>' order by gc.zone, gc.zone_position;

-- Life + library/graveyard counts (swap SESSION_ID)
select p.player_id, p.life_total,
  (select count(*) from public.game_cards g where g.session_id=p.session_id and g.owner_id=p.player_id and g.zone='library')   as library,
  (select count(*) from public.game_cards g where g.session_id=p.session_id and g.owner_id=p.player_id and g.zone='graveyard') as graveyard,
  (select count(*) from public.game_cards g where g.session_id=p.session_id and g.owner_id=p.player_id and g.zone='exile')     as exile
from public.game_session_players p where p.session_id='<SESSION_ID>';

-- Stack contents (swap SESSION_ID)
select position, action_type, status, payload from public.game_stack_items
where session_id='<SESSION_ID>' and status='pending' order by position desc;
```

---

## Group 1 — Regression (proves 084 / 085 / 086) — **priority**

If these all match pre-migration behavior, the refactors held. No resolution may
raise `Unsupported stack action type` or `Unsupported creature effect kind`.

- [ ] **R1 destroy via spell** — cast **Doom Blade Test** on an enemy creature →
      creature to owner's **graveyard**; controller reset to owner; tapped /
      damage_marked / plus_one_counters cleared. *(apply_creature_effect→put_in_graveyard)*
- [ ] **R2 destroy via combat** — attack into a lethal blocker → all
      lethally-damaged creatures reach graveyard in one pass. *(move_lethal snapshot+loop)*
- [ ] **R3 dies trigger still fires** — give **Parting Gift Test** (dies→gain 2)
      lethal damage or Doom Blade it → controller gains 2 life. *(dies trigger survives 084)*
- [ ] **R4 bounce** — **Unsummon Test** → creature to owner's **hand**; **no**
      dies trigger; state cleared. *(bounce stays inline)*
- [ ] **R5 tap / untap** — **Sleep Ray Test** / **Wake Up Test** → is_tapped flips.
- [ ] **R6 add counters** — **Battlegrowth Test** → target gains +1/+1 counter.
- [ ] **R7 pump** — pump_creature resolves and applies P/T (see Giant Growth caveat;
      if that card is malformed, exercise pump via any working pump source).
- [ ] **R8 activated ability** — **Prodigal Sorcerer Test** `{T}: 1 damage` to a
      creature and to a player. *(activate_ability→effective_script)*
- [ ] **R9 static keyword registers** — put **Air Elemental Test** (flying) /
      **Deathtouch Viper Test** / **Silhana Ledgewalker Test** (reach) onto the
      battlefield → keyword takes effect in combat. *(register_card_continuous_effects→effective_script)*
- [ ] **R10 other continuous** — **Exploration Test** (extra land), **Green Mana
      Vessel Test** (G mana doesn't empty) still work.
- [ ] **R11 draw** — **Divination Test** → caster draws 2.
- [ ] **R12 counterspell** — counter a permanent spell on the stack → its source
      card → graveyard; counter item resolves. *(counter_spell branch untouched)*

---

## Group 2 — 079 spell effects

Mostly covered by R4–R6, R11. Plus:

- [ ] **Targeting validation** — a "target creature" spell can't be cast with no
      legal target on the battlefield.
- [ ] **Giant Growth Test** (pump) / **Lightning Strike Test** (any-target damage)
      — see ⚠️ data caveat. Verify whether they cast at all.

---

## Group 3 — 080 / 081 targeted triggers, controller restriction, auto-resolve

- [ ] **T1 targeted ETB** — **Ravenous Chupacabra Test** ETB with an opponent
      creature present → you're prompted to choose; **pass-priority blocked**
      until chosen; on resolve the **opponent's** creature dies.
- [ ] **T2 ownership enforced** — with Chupacabra (`target_controller: opponent`)
      you **cannot** pick your **own** creature (excluded from the picker).
- [ ] **T3 no-softlock fizzle** — Chupacabra ETB when the opponent controls **no**
      creature → trigger fizzles, **no** prompt, priority not stuck.
- [ ] **T4 no controller restriction** — **Ivy Gift Test** ETB (add_counters,
      no `target_controller`) → may target **any** creature incl. your own.
- [ ] **T5 recipient-based triggers auto-resolve (the 081 fix)** — **Welcome
      Drain Test** ETB (each_opponent loses 2 / you gain 2), **Raiding Berserker
      Test** (attacks → 1 to each opponent), **Vengeful Wall Test** (blocks → 1
      to each opponent) must **auto-resolve to each opponent** — **no** creature
      target prompt, and **not** silently dropped (life actually changes). *(bug-098)*

---

## Group 4 — 082 new trigger events

- [ ] **leaves_the_battlefield** — **Farewell Token Test**: destroy/bounce/exile
      it → controller gains 3 life.
- [ ] **dies** (regression) — **Parting Gift Test** dies → gain 2 (also R3).
- [ ] **beginning_of_draw_step** — **Morning Insight Test**: advance to your draw
      step → draw a card.
- [ ] **beginning_of_end_step** — **Dawn Tithe Test**: advance to your end step →
      gain 1 life.
- [ ] **beginning_of_upkeep** (regression) — **Upkeep Scholar Test** → gain 1;
      **Saproling Marshal Test** → create a Saproling token.
- [ ] **attacks** (regression) — **Relentless Charger Test** attacks → +1/+1 on it;
      **Raiding Berserker Test** attacks → 1 dmg to each opponent.
- [ ] **blocks** — **Vengeful Wall Test** blocks an attacker → 1 dmg to each opponent.
- [ ] **becomes_targeted** — target **Spiteful Sentry Test** with a spell (e.g.
      **Sleep Ray Test** / **Doom Blade Test**) → its owner draws a card, and the
      `becomes_targeted` trigger lands **above** the targeting spell on the stack
      (resolves first). Confirm **no infinite loop**.

---

## Group 5 — 083 exile + mill

- [ ] **E1 spell exile** — **Banishing Bolt Test** → target creature to owner's
      **exile** zone; fires `leaves_the_battlefield` (e.g. on Farewell Token),
      **not** `dies`. *(apply_creature_effect exile branch)*
- [ ] **E2 targeted exile trigger** — **Banisher Priest Test** ETB → exile an
      **opponent's** creature; ownership enforced like Chupacabra (T2/T3).
- [ ] **E3 mill** — **Grinding Scholar Test** ETB → **each opponent's** library
      count drops by 3 and graveyard rises by 3 (SQL helper #3).

---

## Pass criteria

- **Refactors (084–086) pass** iff all of Group 1 matches prior behavior with no
  raised "Unsupported …" exceptions.
- **Features (079–083) pass** per the per-group expectations.
- A silent fizzle (T3) is correct; a raised RPC exception is a bug — capture the
  exact error + action_type/effect type for a buglog entry.
