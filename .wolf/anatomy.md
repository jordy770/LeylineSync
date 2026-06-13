# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-06-13T18:51:45.826Z
> Files: 217 tracked | Anatomy hits: 0 | Misses: 0

## ../../.claude/plans/

- `glistening-fluttering-finch.md` — Auto-pass priority — expanded controls (~1999 tok)

## ../../.claude/projects/C--Users-Jordy-dev-LeylineSync/memory/

- `leylinesync-product-vision.md` (~247 tok)

## ./

- `next.config.ts` — Pin the workspace root to this project. A stray parent lockfile (~345 tok)
- `scratch-check-hosted.mjs` — Declares loadEnvFile (~567 tok)
- `scratch-ign.mjs` — Declares c (~161 tok)
- `scratch-mv.mjs` — Declares c (~215 tok)
- `tmp-anim.cjs` — Declares fs (~915 tok)
- `tmp-court.cjs` — Declares fs (~721 tok)
- `tmp-finale.cjs` — Declares fs (~1293 tok)
- `tmp-haunt.cjs` — Declares fs (~1755 tok)
- `tmp-mfinale.cjs` — Declares fs (~1179 tok)
- `tmp-obuun-batch.cjs` — Declares fs (~2351 tok)
- `tmp-payback.cjs` — Declares fs (~772 tok)
- `tmp-schemafix.cjs` — Declares fs (~944 tok)
- `tmp-spirits.cjs` — Declares fs (~1536 tok)

## .claude/


## .claude/projects/c--Users-Jordy-dev-LeylineSync/memory/


## .claude/rules/


## .claude/workflows/

- `scions-spellcraft-build.js` — Exports meta (~2826 tok)

## .git/


## Phase 1 Tier-B scry (added 2026-06-02)


## app/


## app/api/cards/generate-behavior/


## app/auth/confirm/


## app/auth/error/


## app/auth/forgot-password/


## app/auth/login/

- `page.tsx` — getSafeRedirect (~431 tok)

## app/auth/sign-up-success/


## app/auth/sign-up/


## app/auth/update-password/


## app/board/[id]/


## app/cards/behavior/


## app/controller-style-lab/


## app/controller/[id]/


## app/decks/


## app/judge/[id]/


## app/protected/


## components/

- `ControllerListV4.tsx` — Returns the single mana color to auto-produce when a card has exactly one simple tap ability. (~42358 tok)
- `GameSessionLobby.tsx` — GameSessionLobby (~4637 tok)

## components/board/


## components/controller/

- `CardActionSheet.tsx` — CardActionSheet (~18188 tok)
- `CardDisplay.tsx` — Small display atoms: ManaSymbol, KeywordBadges, ManaCostDisplay, ManaPoolDisplay. (~660 tok)
- `OpeningHandOverlay.tsx` — Full-screen opening-hand overlay (London mulligan): keep/mulligan buttons, bottom-card selection chips, waiting-for-others variant. Rendered by ControllerListV4 while any player has opening_hand_kept === false. (~1249 tok)
- `shared.ts` — Collects displayable keywords for a card from Scryfall keywords + scripted continuous effects. (~8333 tok)

## components/judge/


## components/layout/


## components/tutorial/


## components/ui/


## docs/

- `client-coverage-audit.md` — Client coverage audit — engine vs UI (June 2026) (~1033 tok)

## docs/commander-decks/

- `card-scripts.json` (~12467 tok)
- `next-deck.txt` — PASTE YOUR NEXT DECKLIST BELOW, then run:  npm run deck:triage (~164 tok)

## lib/


## lib/game/

- `actions.ts` — Exports getErrorMessage, setCardTapped, moveCardToZone, castCardFromHand + 24 more (~12283 tok)
- `card-behavior-registry.ts` — Declarative registry of the form-editable card effects. ONE entry per effect (~12304 tok)
- `card-behavior-schema.ts` — ─── Shared primitives ─────────────────────────────────────────────────────── (~19274 tok)
- `card-behavior.ts` — Classify a catalog card's rules readiness for the deck editor: (~4067 tok)
- `types.ts` — Exports ManaPool, ManaColor, GameZone, GameSessionStatus + 29 more (~2588 tok)

## lib/supabase/


## public/


## scripts/

- `fix-scions-scripts.mjs` — Declares SCRIPTS (~751 tok)
- `merge-scions-scripts.mjs` — One-off: merge the scions-spellcraft-build workflow output into card-scripts.json. (~481 tok)
- `setup-local-test-db.mjs` — Rebuilds the LOCAL test-harness database from scratch. (~912 tok)
- `triage-decklist.mjs` — Decklist triage — the planning step before implementing a deck's cards. (~3330 tok)
- `upsert-deck-scripts.mjs` — Upsert a decklist's behavior scripts onto the HOSTED card catalog (~2117 tok)
- `validate-fixtures-offline.mts` — Offline fixture validation — no DB, no credentials (unlike validate:scripts, (~332 tok)

## supabase/


## supabase/functions/spawn-deck/


## supabase/functions_src/

- `activate_ability.sql` — supabase/functions_src/activate_ability.sql (~7651 tok)
- `activate_mana_ability.sql` — supabase/functions_src/activate_mana_ability.sql (~1813 tok)
- `add_mana_from_card.sql` — basic-land/manual mana rpc (7-arg, commander identity + monarch land bonus); canonical since mig 262. (~900 tok)
- `add_mana_from_card.sql` — supabase/functions_src/add_mana_from_card.sql (~1460 tok)
- `advance_step.sql` — supabase/functions_src/advance_step.sql (~3611 tok)
- `apply_creature_effect.sql` — supabase/functions_src/apply_creature_effect.sql (~5988 tok)
- `apply_damage_allocations.sql` — supabase/functions_src/apply_damage_allocations.sql (~592 tok)
- `apply_damage_to_creature.sql` — supabase/functions_src/apply_damage_to_creature.sql (~1707 tok)
- `apply_damage_to_player.sql` — supabase/functions_src/apply_damage_to_player.sql (~1003 tok)
- `apply_mass_pump_until_eot.sql` — supabase/functions_src/apply_mass_pump_until_eot.sql (~651 tok)
- `apply_targeted_triggered_ability_effects.sql` — supabase/functions_src/apply_targeted_triggered_ability_effects.sql (~502 tok)
- `apply_trigger_effects.sql` — supabase/functions_src/apply_trigger_effects.sql (~20248 tok)
- `apply_triggered_ability_effects.sql` — supabase/functions_src/apply_triggered_ability_effects.sql (~12013 tok)
- `become_copy.sql` — supabase/functions_src/become_copy.sql (~1020 tok)
- `build_stack_payload_permanent_simple.sql` — supabase/functions_src/build_stack_payload_permanent_simple.sql (~670 tok)
- `cast_card_from_hand.sql` — supabase/functions_src/cast_card_from_hand.sql (~5432 tok)
- `cast_spell_effect.sql` — supabase/functions_src/cast_spell_effect.sql (~2775 tok)
- `cease_token_if_off_battlefield.sql` — supabase/functions_src/cease_token_if_off_battlefield.sql (~308 tok)
- `create_copy_token.sql` — supabase/functions_src/create_copy_token.sql (~943 tok)
- `cycle_card.sql` — supabase/functions_src/cycle_card.sql (~815 tok)
- `declare_attacker.sql` — supabase/functions_src/declare_attacker.sql (~3313 tok)
- `declare_blocker.sql` — supabase/functions_src/declare_blocker.sql (~1685 tok)
- `divide_damage_options.sql` — supabase/functions_src/divide_damage_options.sql (~676 tok)
- `enqueue_triggered_ability.sql` — supabase/functions_src/enqueue_triggered_ability.sql (~1069 tok)
- `fire_attack_triggers.sql` — supabase/functions_src/fire_attack_triggers.sql (~354 tok)
- `fire_becomes_target_triggers.sql` — supabase/functions_src/fire_becomes_target_triggers.sql (~801 tok)
- `fire_card_triggers.sql` — supabase/functions_src/fire_card_triggers.sql (~612 tok)
- `fire_tap_triggers.sql` — supabase/functions_src/fire_tap_triggers.sql (~297 tok)
- `fire_turn_step_triggers.sql` — supabase/functions_src/fire_turn_step_triggers.sql (~673 tok)
- `fire_watcher_triggers.sql` — supabase/functions_src/fire_watcher_triggers.sql (~3189 tok)
- `fire_zone_change_triggers.sql` — supabase/functions_src/fire_zone_change_triggers.sql (~1540 tok)
- `get_session_players.sql` — supabase/functions_src/get_session_players.sql (~406 tok)
- `handle_permanent_effect.sql` — supabase/functions_src/handle_permanent_effect.sql (~1834 tok)
- `keep_opening_hand.sql` — supabase/functions_src/keep_opening_hand.sql (~643 tok)
- `mana_value.sql` — supabase/functions_src/mana_value.sql (~258 tok)
- `mulligan_hand.sql` — supabase/functions_src/mulligan_hand.sql (~681 tok)
- `put_action_on_stack.sql` — supabase/functions_src/put_action_on_stack.sql (~2455 tok)
- `put_in_graveyard.sql` — supabase/functions_src/put_in_graveyard.sql (~1154 tok)
- `reduced_mana_cost.sql` — supabase/functions_src/reduced_mana_cost.sql (~889 tok)
- `register_card_continuous_effects.sql` — supabase/functions_src/register_card_continuous_effects.sql (~2533 tok)
- `resolve_combat_damage.sql` — supabase/functions_src/resolve_combat_damage.sql (~7219 tok)
- `resolve_count_amount.sql` — supabase/functions_src/resolve_count_amount.sql (~3450 tok)
- `resolve_dynamic_amount.sql` — supabase/functions_src/resolve_dynamic_amount.sql (~800 tok)
- `return_all_from_graveyard.sql` — supabase/functions_src/return_all_from_graveyard.sql (~838 tok)
- `revert_copy_before_leave.sql` — supabase/functions_src/revert_copy_before_leave.sql (~354 tok)
- `start_game_session.sql` — supabase/functions_src/start_game_session.sql (~1078 tok)
- `submit_decision.sql` — supabase/functions_src/submit_decision.sql (~13399 tok)
- `track_life_lost.sql` — supabase/functions_src/track_life_lost.sql (~259 tok)
- `trigger_effect_target_type.sql` — supabase/functions_src/trigger_effect_target_type.sql (~391 tok)
- `turn_manifest_up.sql` — supabase/functions_src/turn_manifest_up.sql (~655 tok)

## supabase/migrations/

- `202605010216_hot_path_indexes.sql` — Hot-path indexes (perf, no behavior change). (~299 tok)
- `202605010223_ureni_look_top.sql` — Ureni of the Unwritten (the Dragons commander) — "Whenever Ureni enters or (~13399 tok)
- `202605010229_gadrak.sql` — 202605010229_gadrak — Gadrak, the Crown-Scourge. (~9649 tok)
- `202605010230_atsushi.sql` — 202605010230_atsushi — Atsushi, the Blazing Sky. (~26980 tok)
- `202605010231_cost_reduction.sql` — 202605010231_cost_reduction — generic-mana cost reduction. (~9725 tok)
- `202605010232_monstrosity.sql` — 202605010232_monstrosity — Stormbreath Dragon's monstrosity. (~12816 tok)
- `202605010233_divide_damage.sql` — 202605010233_divide_damage — divided damage from triggers/abilities. (~21620 tok)
- `202605010234_spell_cast_watcher.sql` — 202605010234_spell_cast_watcher — "whenever you/an opponent cast a spell". (~15190 tok)
- `202605010235_becomes_target_and_power.sql` — 202605010235_becomes_target_and_power — Eshki + Thunderbreak Regent. (~10543 tok)
- `202605010236_exert_and_transform.sql` — 202605010236_exert_and_transform — Glorybringer (exert) + Nogi (transform). (~11437 tok)
- `202605010237_dragon_lands.sql` — 202605010237_dragon_lands — Path of Ancestry, Temple of the Dragon Queen, Haven. (~11022 tok)
- `202605010238_landfall.sql` — 202605010238_landfall — Nesting Dragon (landfall) + Sarkhan cost reduction. (~2096 tok)
- `202605010239_copy_permanent.sql` — 202605010239_copy_permanent — token-copy primitive (Will of the Temur, (~21363 tok)
- `202605010240_become_copy.sql` — 202605010240_become_copy — an existing card becomes a copy (Deceptive (~20948 tok)
- `202605010241_farseek_type_line_any.sql` — 202605010241_farseek_type_line_any — Farseek + Flooded Grove. (~8996 tok)
- `202605010242_kessig_chaos_warp.sql` — 202605010242_kessig_chaos_warp — Kessig Wolf Run + Chaos Warp. (~10419 tok)
- `202605010243_become_the_avalanche.sql` — 202605010243_become_the_avalanche — Become the Avalanche. (~11319 tok)
- `202605010244_tyrants_thundermane.sql` — 202605010244_tyrants_thundermane — Leyline Tyrant + Hammerhead Tyrant + (~28222 tok)
- `202605010245_siege_dragonstorm.sql` — 202605010245_siege_dragonstorm — Frontier Siege + Breaching Dragonstorm. (~30467 tok)
- `202605010246_opportunistic_dragon.sql` — 202605010246_opportunistic_dragon — "choose target Human or artifact an (~5359 tok)
- `202605010247_dragons_combat_damage.sql` — 202605010247_dragons_combat_damage — Broodcaller Scourge + Parapet Thrasher. (~29175 tok)
- `202605010248_courser_mosswort.sql` — 202605010248_courser_mosswort — Hellkite Courser + Mosswort Bridge. (~34720 tok)
- `202605010249_goad_territorial.sql` — 202605010249_goad_territorial — Vengeful Ancestor (goad) + Territorial (~24930 tok)
- `202605010250_scourge_throne.sql` — 202605010250_scourge_throne — Scourge of the Throne (dethrone + an (~24914 tok)
- `202605010251_reality_shift_manifest.sql` — 202605010251_reality_shift_manifest — Reality Shift (manifest). (~7696 tok)
- `202605010252_selvalas_stampede.sql` — 202605010252_selvalas_stampede — Selvala's Stampede (council's dilemma (~26213 tok)
- `202605010253_discover_pantlaza.sql` — 202605010253_discover_pantlaza — discover + Pantlaza, Sun-Favored (the (~17255 tok)
- `202605010254_enrage.sql` — 202605010254_enrage — the enrage event ("whenever this creature is dealt (~1219 tok)
- `202605010255_dino_manabase.sql` — 202605010255_dino_manabase — the Veloci-Ramp-Tor manabase + ramp batch (~2179 tok)
- `202605010256_dino_creatures.sql` — 202605010256_dino_creatures — the Veloci-Ramp-Tor creature batch (~14 (~30048 tok)
- `202605010257_dino_tail.sql` — 202605010257_dino_tail — the Veloci-Ramp-Tor tail batch (~10 cards; (~14931 tok)
- `202605010258_dino_statics.sql` — 202605010258_dino_statics (~20673 tok)
- `202605010259_dino_triggers.sql` — 202605010259_dino_triggers (~32896 tok)
- `202605010260_dino_combat.sql` — 202605010260_dino_combat (~35248 tok)
- `202605010261_dino_fights.sql` — 202605010261_dino_fights (~43483 tok)
- `202605010262_dino_finale.sql` — 202605010262_dino_finale (~60868 tok)
- `202605010292_noncreature_spell_filter.sql` — 202605010292_noncreature_spell_filter (~2707 tok)
- `202605010293_spell_mana_value_filter.sql` — 202605010293_spell_mana_value_filter (~2803 tok)
- `202605010294_life_lost_this_turn.sql` — 202605010294_life_lost_this_turn (~7174 tok)
- `202605010295_adventures.sql` — 202605010295_adventures (~6474 tok)
- `202605010296_adventure_counter.sql` — 202605010296_adventure_counter (~2542 tok)
- `202605010297_job_select.sql` — 202605010297_job_select (~19896 tok)
- `202605010298_syphon_mind.sql` — 202605010298_syphon_mind (~23658 tok)
- `202605010299_ardbert.sql` — 202605010299_ardbert (~14550 tok)
- `202605010300_x_permanents.sql` — 202605010300_x_permanents (~17516 tok)
- `202605010301_attack_count.sql` — 202605010301_attack_count (~3292 tok)
- `202605010303_pacify.sql` — 202605010303_pacify (~7726 tok)

## supabase/migrations/ (200-215, 2026-06-10)


## tests/


## tests/feature/

- `adventures.test.ts` — Adventure mechanic (mig 295): casting the adventure half (cast_spell_effect (~1331 tok)
- `ardbert.test.ts` — Ardbert, Warrior of Darkness (mig 299): casting a white/black spell puts a (~656 tok)
- `atsushi.test.ts` — Atsushi, the Blazing Sky (mig 230) — a MODAL dies trigger ("choose one"): (~1292 tok)
- `become-copy.test.ts` — mig 240 — become_copy: an EXISTING card becomes a copy of another. (~1756 tok)
- `become-the-avalanche.test.ts` — mig 243 — Become the Avalanche: "Draw a card for each creature you control (~662 tok)
- `becomes-target-and-power.test.ts` — mig 235 — three cards: (~1397 tok)
- `breya-core.test.ts` — mig 264 — Breya core. Engine touch: 'sacrifice_artifacts' activation cost (~1294 tok)
- `breya-core.test.ts` — mig 264 — Breya ETB Thopters + sacrifice_artifacts cost, Thopter Foundry nontoken sac, Ichor Wellspring enters/dies draws. (~900 tok)
- `breya-manabase.test.ts` — mig 263 — Breya mana base. Engine touch: bounce_up_to type_line filter (~516 tok)
- `breya-manabase.test.ts` — mig 263 — Breya karoo land bounce (bounce_up_to type_line) + double-mana tap. (~500 tok)
- `breya-recursion.test.ts` — mig 265 — Hanna artifact-or-enchantment return, Myr Retriever exclude-self dies return. (~700 tok)
- `breya-recursion.test.ts` — mig 265 — Breya recursion. Engine touch: return_from_graveyard filter (~782 tok)
- `champions-from-beyond.test.ts` — Champions from Beyond (mig 300, Stage A): an {X} permanent whose ETB creates (~721 tok)
- `checkland-min-power.test.ts` — Checklands + the watcher min_power filter (mig 225). (~972 tok)
- `circle-of-power.test.ts` — Circle of Power (no migration): the spell makes a 0/1 black Wizard token whose (~774 tok)
- `copy-permanent.test.ts` — mig 239 — token-copy primitive (Will of the Temur + Reflections of Littjara). (~2624 tok)
- `cost-reduction.test.ts` — Cost reduction (mig 231) — reduced_mana_cost shaves generic mana at cast: (~942 tok)
- `courser-mosswort.test.ts` — mig 248 — Hellkite Courser + Mosswort Bridge. (~1485 tok)
- `cruel-revival.test.ts` — Cruel Revival (mig 220) — "Destroy target non-Zombie creature. Return up to (~964 tok)
- `cycling.test.ts` — Cycling (mig 228) — "Cycling {2}: Discard this card, draw a card." The (~600 tok)
- `deal-damage-all.test.ts` — Mass damage `deal_damage_all` (mig 224) — Blasphemous Act / Storm's Wrath / (~1116 tok)
- `deck-smoke.test.ts` — Deck smoke test: every curated script in docs/commander-decks/card-scripts.json (~2578 tok)
- `dig-through-time.test.ts` — Dig Through Time (mig 302): look at the top 7, put 2 into your hand, the rest (~531 tok)
- `dino-combat.test.ts` — mig 260 — Veloci-Ramp-Tor combat batch. Engine touches: (~1512 tok)
- `dino-combat.test.ts` — mig 260 — Quartzwood X/X trample token, Wrathful Raptors damage redirect, From the Rubble end-step reanimation, Itzquinth ETB burn. (~1400 tok)
- `dino-creatures.test.ts` — mig 256 — the Veloci-Ramp-Tor creature batch (~14 cards, mostly scripts). (~1428 tok)
- `dino-fights.test.ts` — mig 261 — Savage Stomp/Wayta fight_pick, Scion per-attacker combat-damage destroy. (~1100 tok)
- `dino-fights.test.ts` — mig 261 — Veloci-Ramp-Tor fights batch. Engine touches: (~1262 tok)
- `dino-finale.test.ts` — mig 262 — Etali free-cast tops, monarch subsystem (crown/steal/draw/land bonus), Bronzebeak exile-until-leaves. (~1500 tok)
- `dino-finale.test.ts` — mig 262 — Veloci-Ramp-Tor finale (deck complete). Engine touches: (~1770 tok)
- `dino-manabase.test.ts` — mig 255 — the Veloci-Ramp-Tor manabase + ramp batch (~20 script-only (~1444 tok)
- `dino-statics.test.ts` — mig 258 — Veloci-Ramp-Tor statics batch. Engine touches: (~2042 tok)
- `dino-statics.test.ts` — mig 258 — dino statics batch: Zacama land-untap, Kinjalli enter-tapped, Runic Armasaur ability_activated watcher, Brontodon per-land pump, Atzocan Seer sac-return. (~1500 tok)
- `dino-tail.test.ts` — mig 257 — the Veloci-Ramp-Tor "tail" batch (~10 cards). Engine touches: (~1639 tok)
- `dino-triggers.test.ts` — mig 259 — Temple Altisaur damage_cap, Xenagos power_of pump, Descendants Path reveal-cast, Deathgorge graveyard exile pick, Akromas Will modal grants. (~1700 tok)
- `dino-triggers.test.ts` — mig 259 — Veloci-Ramp-Tor triggers batch. Engine touches: (~2494 tok)
- `discover.test.ts` — mig 253 — discover + Pantlaza, Sun-Favored (the Veloci-Ramp-Tor commander). (~978 tok)
- `divide-damage.test.ts` — Divided damage from triggers/abilities (mig 233): (~1212 tok)
- `docs/client-coverage-audit.md` — engine-vs-UI gap inventory (decision types, cost picks, invisible state) with a prioritized fix order. (~700 tok)
- `dragon-lands.test.ts` — mig 237 — three Dragon-deck lands: (~1000 tok)
- `dragons-combat-damage.test.ts` — mig 247 — Broodcaller Scourge + Parapet Thrasher: "Whenever one or more (~1436 tok)
- `dragons-deck.test.ts` — Dragons deck — proving tests for the Tier-0 compositions (cards authored (~2449 tok)
- `enrage.test.ts` — mig 254 — enrage: "whenever this creature is dealt damage", broadcast from (~1122 tok)
- `enters-tapped-lands.test.ts` — Enters-tapped lands (mig 217) — top-level `enters_tapped` read in (~1071 tok)
- `exert-and-transform.test.ts` — mig 236 — three cards: (~1238 tok)
- `farseek-flooded-grove.test.ts` — mig 241 — Farseek + Flooded Grove. (~809 tok)
- `fleshbag-overseer.test.ts` — Free compositions for the Gisa deck's last two creatures — no engine change, (~1286 tok)
- `gadrak.test.ts` — Gadrak, the Crown-Scourge (mig 229) — (~1191 tok)
- `game-start.test.ts` — Game start sequence (mig 221) — random first player, 7-card opening hands, (~1843 tok)
- `goad-territorial.test.ts` — mig 249 — Vengeful Ancestor (goad) + Territorial Hellkite. (~1713 tok)
- `job-select.test.ts` — Job select (mig 297): when a "Job select" Equipment enters, it creates a 1/1 (~502 tok)
- `kessig-chaos-warp.test.ts` — mig 242 — Kessig Wolf Run + Chaos Warp. (~1297 tok)
- `landfall.test.ts` — mig 238 — Nesting Dragon (landfall) + Sarkhan cost reduction. (~843 tok)
- `life-lost-this-turn.test.ts` — Life-loss-this-turn tracker (mig 294): a BEFORE UPDATE trigger accumulates (~670 tok)
- `monstrosity.test.ts` — Monstrosity (mig 232) — Stormbreath Dragon: "{5}{R}{R}: Monstrosity 3. When (~781 tok)
- `multiplayer-pods.test.ts` — 4-player pod semantics: corrupted gates, edict chains, goad redirection, monarch theft, per-player taxes. (~1100 tok)
- `multiplayer-pods.test.ts` — Four-player pod sweep: the engine grew through six decks of mostly-1v1 (~2740 tok)
- `noncreature-spell-trigger.test.ts` — Noncreature-spell watcher (mig 292): a spell_cast triggered ability with (~933 tok)
- `observed-stasis.test.ts` — Observed Stasis / pacify (mig 303): an Aura that gives the enchanted creature (~662 tok)
- `omen-casts.test.ts` — mig 289 — Flush Out from hand: discard park, draw two, shuffle-self-away. (~500 tok)
- `opportunistic-dragon.test.ts` — mig 246 — Opportunistic Dragon: "When this creature enters, choose target (~810 tok)
- `propaganda.test.ts` — Propaganda / attack tax (existing attack_tax mechanism): creatures can't (~511 tok)
- `ramp.test.ts` — Temur Dragons ramp package (free compositions, no new engine): (~925 tok)
- `reality-shift.test.ts` — mig 251 — Reality Shift (manifest): "Exile target creature. Its controller (~1052 tok)
- `reflexive-watcher.test.ts` — Reflexive watchers (mig 227) — the entering/attacking creature ITSELF gains (~953 tok)
- `scourge-throne.test.ts` — mig 250 — Scourge of the Throne: dethrone + an additional combat phase. (~979 tok)
- `selvalas-stampede.test.ts` — mig 252 — Selvala's Stampede (council's dilemma voting): starting with the (~1095 tok)
- `siege-dragonstorm.test.ts` — mig 245 — Frontier Siege + Breaching Dragonstorm. (~1740 tok)
- `spell-cast-watcher.test.ts` — Spell-cast watcher (mig 234): (~722 tok)
- `syphon-mind.test.ts` — Syphon Mind (mig 298): each other player discards a card (each_opponent, at (~488 tok)
- `treasure.test.ts` — Treasure tokens (mig 226) — "{T}, Sacrifice this artifact: Add one mana of (~660 tok)
- `tyrants-thundermane.test.ts` — mig 244 — Leyline Tyrant + Hammerhead Tyrant + Thundermane Dragon. (~1802 tok)
- `undying.test.ts` — Undying (mig 219) — "When this creature dies, if it had no +1/+1 counters on (~820 tok)
- `ureni.test.ts` — Ureni of the Unwritten (mig 223) — "Whenever Ureni enters or attacks, look at (~1186 tok)
- `victimize.test.ts` — Victimize (mig 218) — "Choose two target creature cards in your graveyard. (~849 tok)
- `zenith-festival.test.ts` — Zenith Festival — "Exile the top X cards of your library. You may play (~503 tok)
- `zz-debug.test.ts` — Declares s (~385 tok)

## tests/fixtures/

- `test-cards.json` (~33915 tok)

## tests/harness/

- `scenario.ts` — Create a session. Seat A is the creator + active player; B/C/D join in seat (~10025 tok)

## tests/regression/


## tests/unit/

- `card-config-status.test.ts` — getCardConfigStatus — the deck editor's "scripted / vanilla / needs behaviour" (~891 tok)
- `card-scripts-validation.test.ts` — Every curated entry in docs/commander-decks/card-scripts.json must pass (~458 tok)
- `card-scripts-validation.test.ts` — validates every docs/commander-decks/card-scripts.json entry against validateCardScript (the hosted upsert gate), added after bug-687/688. (~350 tok)
- `registry-schema-drift.test.ts` — Drift guard for the card-behavior authoring stack's two type vocabularies: (~2928 tok)

## vercel/


## vercel/app/


## vercel/components/


## vercel/components/mtg/


## vercel/components/ui/


## vercel/hooks/


## vercel/lib/


## vercel/lib/mtg/


## vercel/styles/

