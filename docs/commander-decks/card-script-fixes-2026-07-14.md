# Card-script fixes — 14 juli 2026

Vervolg op `card-script-audit-2026-07-14.md`: de 87 kaarten met verdict wrong/inert of severity high zijn getriaged en waar mogelijk gefixt. Elke concept-fix is gevalideerd (Zod-parse + deep-diff + unknown-action-type sweep) en de wijzigingen zijn toegepast op `card-scripts.json` en lokaal geseed.

## Uitkomst in één oogopslag

| Bucket | Aantal |
|---|---|
| Script gewijzigd | 45 |
| — volledig gefixt (geen restpunten) | 4 |
| — gefixt met klein restpunt | 6 |
| — substantieel verbeterd, rest wacht op engine | 35 |
| Audit-false-positive (script was al correct) | 3 |
| Onveranderd — kern heeft engine-feature nodig | 36 |
| Onveranderd — fundamenteel niet uitdrukbaar | 3 |

### Audit-false-positives (géén fix nodig)

- **Shared Animosity** — `shared_type_attackers` is wél geïmplementeerd (mig 340, eigen migratie voor deze kaart).
- **Splinter Twin** — `copy_self` via `granted_ability` is end-to-end bedraad (mig 357/358).
- **Vampire Nocturnus** — `condition_top_card_color` wordt wél afgedwongen (mig 342); alleen de top-card-reveal ontbreekt (engine-need).

## Volledig gefixt (4)

- **Fetid Heath** — Added the {W/B},{T} filter ability as three mana-ability variants ({W}{W} / {W}{B} / {B}{B}), mirroring the proven Flooded Grove script.
- **Gadwick, the Wizened** — Added ETB draw reading the cast-time X via {counters:'x', of:'self'} (literal 'X' resolves to 0 in trigger effects per resolve_dynamic_amount); X=0 when not cast is rules-correct.
- **Hellkite Igniter** — Replaced the wrong free attack-trigger with a repeatable {1}{R} activated self-pump; verified activate_ability's single-effect pump branch casts power::integer (breaks on {count}), so a second documented no-op pump (+0/+0) routes the ability through the multi-effect spell_effect program where untargeted dynamic-count self-pump is fully supported (apply_triggered_ability_effects → apply_creature_effect); schema-validated.
- **White Auracite** — Added the missing ETB exile: exile_until_leaves with target_type nonland_permanent works on ETB triggers (mig 377 added nonland_permanent to behavior_target_type_is_permanent_only); mana ability kept.

## Gefixt met klein restpunt (6)

| Kaart | Was | Restpunt |
|---|---|---|
| Aurelia, the Warleader | partial/high | Approximation: fires the first time any Angel you control attacks each turn (a watcher can watch its own attack, but there is no source-only watcher filter), so another attacking Angel can consume/trigger it without Aurelia attacking |
| Bloodline Necromancer | partial/high | types filter matches the type line substring, so a rare noncreature card with Vampire/Wizard in its type line would also qualify (no 'creature card' conjunct) |
| Caress of Phyrexia | partial/high | 'target player' is modeled as a resolution-time choose_player pick rather than stack targeting (engine's standard pattern for player-directed spell effects) |
| Coalition Relic | partial/high | Trigger mana is all one chosen color; the card allows a different color per removed counter; Color-choice prompt appears each of your precombat mains even with zero charge counters (resolves to 0 mana, harmless) |
| Fellwar Stone | wrong/high | Produces any color rather than only colors a land an opponent controls could produce (engine has no such color constraint); a slight superset, rarely relevant in EDH. |
| Juri, Master of the Revue | partial/high | 'Any target' modeled as creature-or-player per the corpus pattern (Omnath, Locus of Rage); planeswalkers/battles not offered as damage targets |

## Substantieel verbeterd — rest wacht op engine (35)

| Kaart | Was | Blijft open |
|---|---|---|
| Abzan Falconer | partial/high | Static 'each creature you control with a +1/+1 counter on it has flying' not implemented — keyword continuous-effect payload filters (creature_type/exclude_source/token_only/condition_top_card_color) have no has-counter filter; 'Outlast only as a sorcery' timing restriction not enforced |
| Astrologian's Planisphere | partial/high | 'whenever you draw your third card each turn' half of the granted trigger not implemented (no draw watcher event); Equipped creature becoming a Wizard not implemented (added types not modelled) |
| Bronzebeak Foragers | partial/high | Exiles a single opposing nonland permanent instead of up to one per opponent; {X}{W} activated ability (exiled card with MV X to its owner's graveyard + gain X life) unimplemented |
| Cut a Deal | partial/high | 'Each opponent draws a card' not implemented — draw.recipient is dead at runtime, and keeping that action would wrongly draw an extra card for the caster instead |
| Disorder in the Court | wrong/high | Exile X target creatures + return them tapped at next end step not implemented (no X-count targeting, no delayed-return exile) |
| Dragon Tempest | partial/high | Dragon-ETB damage can only hit creatures, not players or planeswalkers (the card's main win line); Damage target is declinable (optional) to avoid forcing self-damage when only your creatures are on the battlefield; the card's trigger is mandatory |
| Drana, Liberator of Malakir | partial/high | Counter lands only on Drana herself; other attacking creatures you control get nothing (add_counters_all would wrongly hit non-attackers too) |
| Ethereal Investigator | partial/high | 'Whenever you draw your second card each turn, create a 1/1 white flying Spirit' remains unimplemented — no own-draw-count watcher event exists. |
| Ethersworn Adjudicator | partial/high | Untap ability lets the player untap any creature they control instead of only this creature (narrowed from any permanent; exact self-untap is not expressible). |
| Everflowing Chalice | partial/high | Only 0 or 1 kicks are modeled (kicker is once-only), so it never enters with 2+ charge counters via kicking.; Mana ability adds a fixed {C} when at least 1 charge counter is present; it does not scale with 2+ counters (e.g. after proliferate). |
| Ghostly Pilferer | inert/high | untapped-may-pay-{2}-draw ability unimplemented (no becomes_untapped event); opponent non-hand casts only caught when cast from exile — graveyard/command-zone/library casts missed; 'Discard a card: can't be blocked this turn' unimplemented (no unblockable grant) |
| Godo, Bandit Warlord | partial/high | untap_all_attackers still misses non-attacking Samurai and untaps non-Samurai attackers; creature_attacks watcher approximation can fire off another attacking Barbarian you control, not only Godo |
| Hraesvelgr of the First Brood | partial/high | 'can't be blocked this turn' rider on both triggers not enforced; ward {2} present only as inert keyword text |
| Idol of Oblivion | partial/high | '{T}: Draw a card. Activate only if you created a token this turn' omitted — no such count exists in the activated condition enum, and shipping it ungated is strictly stronger than the card |
| Kaalia of the Vast | partial/high | Put creature enters untapped and not attacking — the tempo half of the ability is lost; Trigger fires on any attack declaration, not only attacks against an opponent; A subtype mode must be picked before the (declinable, min 0) hand pick — slight UX detour but mechanically enforces the Angel/Demon/Dragon restriction |
| Kami of the Crescent Moon | wrong/high | Only the controller's own draw step grants the extra card; opponents' draw steps do nothing (no each-player draw-step event) |
| Multiversal Passage | partial/high | Mana ability produces any color per activation instead of being locked to the single type chosen as it entered (slightly over-flexible approximation); The land never actually has the chosen basic land type (Domain, land-type counts, etc.) |
| Occult Epiphany | partial/high | Discard is fixed at 2 because discard.count accepts only a plain number, so it does not scale with X.; Token count is fixed at 1 instead of one per card type among cards discarded this way. |
| Phyresis Outbreak | wrong/high | The -1/-1-per-poison-counter debuff on opponents' creatures is unimplemented: pump_all has no opponent-only scope and no per-creature controller-poison scaling. |
| Professional Face-Breaker | partial/high | The 'Sacrifice a Treasure: exile top card, may play it this turn' activated ability remains unimplemented — the sacrifice cost cannot be restricted to Treasures.; once_per_turn approximates the 'one or more creatures' batching; with an extra combat step the real card would trigger again but the script will not. |
| Scion of Calamity | partial/high | Destroy targets any opponent's artifact or enchantment, not only the player it dealt combat damage to (no way to bind the target pool to the triggering player). |
| Slobad, Goblin Tinkerer | wrong/medium | Picking a NONCREATURE artifact still fails at activation ('Target is not a legal creature for this spell' — transaction rolls back, cost refunded); the grant only actually lands on artifact creatures. |
| Sydri, Galvanic Genius | partial/high | {U} noncreature-artifact animation ability unimplemented (P/T = mana value inexpressible).; {W}{B} grant can target any creature, not only artifact creatures (restriction not mechanically enforceable). |
| Tataru Taru | partial/high | Scions' Secretary (tapped Treasure when an opponent draws off-turn, once per turn) unimplemented — no card-draw watcher event exists.; ETB opponent draw is forced on the chosen opponent rather than 'may draw' (choose_player applies effects unconditionally). |
| Thancred Waters | partial/high | Royal Guard grant lasts only until end of turn instead of while you control Thancred, can only hit legendary CREATURES, and cannot enforce 'another' (may target Thancred himself; made optional to allow declining).; Flash present only as inert text — the card still cannot actually be cast at instant speed. |
| The Mending of Dominaria | partial/high | Chapters I/II 'you may return a creature card from your graveyard to your hand' dropped — a graveyard pick cannot run inside a saga chapter program.; Chapter III's 'then shuffle your graveyard into your library' missing — no such action exists. |
| Together Forever | partial/high | '{1}: Choose target creature with a counter on it. When that creature dies this turn, return that card to its owner's hand' unimplemented — grant_dies_effect exists but its death payload cannot return the card to hand, cannot filter countered creatures, and never expires. |
| Torrential Gearhulk | partial/high | grant_flashback approximation charges the card's own mana cost instead of casting it free; grant_flashback also offers sorcery cards, broader than the card's instant-only text |
| Transpose | partial/high | token is created unconditionally — the cast-from-hand gate is unenforceable (practically moot while rebound is unimplemented, since every cast is from hand); rebound not implemented |
| Trial // Error | partial/high | Error half counters any spell — the multicolored restriction is not enforceable; Trial half entirely unimplemented |
| Trinket Mage | partial/high | 'mana value 1 or less' restriction unenforced — can still tutor any artifact |
| Tuskguard Captain | partial/high | 'Each creature you control with a +1/+1 counter on it has trample' not implemented — card_has_trample's payload filters (creature_type/exclude_source/token_only) have no counter predicate; granting trample unconditionally would be wrong |
| Twilight Prophet | partial/high | drain half (each opponent loses X, you gain X = that card's mana value) not implemented — no dynamic amount reads the drawn card's MV; city's blessing approximated as a live 'ten or more permanents' check at each upkeep, not sticky; the card is drawn rather than revealed-then-put-into-hand |
| Wildborn Preserver | partial/high | Pay-{X}-for-X-counters approximated as a fixed pay-{1}-for-1-counter may per trigger (may.cost is a fixed mana string; no X payment exists).; Flash kept only as inert keyword text; sorcery-speed casting is enforced by cast_card_from_hand so the card cannot actually be cast at instant speed. |
| Wurmquake | partial/high | Token size baked as 4 (normal cast) / 10 (flashback cast via flashback_effect) — correct when exactly the printed cost is paid, wrong under cost modifiers or additional mana.; Corrupted clause still creates one extra token total when ANY opponent has 3+ poison (opponent_poison_counters = max among opponents), not one per qualifying opponent.; Toxic 1 on the tokens is not modeled. |

## Onveranderd — kern heeft een engine-feature nodig (36)

| Kaart | Was | Nodig |
|---|---|---|
| Angel of Serenity | partial/high | 'up to N' multi-target selection on trigger effects (exile_until_leaves takes exactly one target); trigger targets spanning graveyard creature cards (mixed battlefield/graveyard targeting); exile_until_leaves variant that returns the exiled cards to owners' HANDS on LTB (current one returns to battlefield) |
| Archaeomancer's Map | partial/high | condition gate comparing two dynamic counts relative to the triggering player (e.g. 'that player controls more lands than you' on a land_entered watcher) |
| Breath of the Sleepless | inert/high | static permission: cast spells of a given subtype as though they had flash; watcher filter: event occurred during an opponent's turn (turn-owner filter on spell_cast) |
| Chromatic Lantern | partial/high | class-wide granted_ability continuous effect: grant an activated/mana ability to all permanents matching a filter (e.g. lands you control), not just a single affected_card_id |
| Condescend | partial/high | X-valued counter unless_pays: handle_counter_spell reads the escape cost as a static string from the catalog script, so a cast-time-chosen {X} cost cannot be modeled |
| Curse of Vengeance | inert/high | generic enchant-player (aura attached to a chosen player) with enchanted-player-relative trigger filters; 'player loses the game' trigger event |
| Drana and Linvala | partial/high | static suppression: activated abilities of opponents' creatures can't be activated; static ability theft: source has all activated abilities of all opponents' creatures, with spend-as-any-color for those activations |
| Emet-Selch of the Third Seat | partial/high | watcher trigger event for 'one or more opponents lose life' (only lifegain triggers exist); cast-from-graveyard grant with exile-instead-of-graveyard replacement on a targeted instant/sorcery |
| Estinien Varlineau | partial/high | second-main-phase-specific turn-step trigger event (beginning_of_main fires on both main phases); count: number of opponents dealt combat damage this turn by the source or by creatures of a given subtype |
| Fandaniel, Telophoroi Ascian | partial/high | per-opponent punisher choice: each opponent may sacrifice (with a nontoken/type filter) or else suffer an effect (existing sacrifice action is a forced edict with no decline branch) |
| Frost Titan | partial/high | counter the targeting spell/ability from a becomes_target trigger (fire_becomes_target_triggers does not pass the triggering stack item, and trigger effects have no counter handler — counter{unless_pays} works only in spell_effect.actions); stun / doesn't-untap-during-its-controller's-next-untap-step primitive |
| G'raha Tia, Scion Reborn | partial/high | may-cost of paying life scaled to the triggering spell's mana value (may.cost is a mana string only; mana_value_of:'triggering_creature' resolves only in the discover path); create a token that enters with N +1/+1 counters (create_token has no counters field) |
| Geist of Saint Traft | partial/high | create_token flag: token enters attacking; create_token cleanup: exile the created token at end of combat |
| Gisela, Blade of Goldnight | partial/high | damage replacement: double damage dealt to opponents and permanents they control; damage replacement: prevent half (rounded up) of damage dealt to you and your permanents |
| Grafted Exoskeleton | partial/high | infect as an engine-honored/grantable keyword (damage as -1/-1 counters to creatures and poison counters to players); becomes_unattached trigger event carrying the formerly attached permanent as subject |
| Haunting Imitation | inert/high | each player reveals the top card of their library with per-revealed-card conditional effects; create a token copy of a revealed library card with P/T/added-type/keyword overrides; return the spell to its owner's hand when its effect produced no result |
| Kalitas, Traitor of Ghet | partial/high | replacement effect: nontoken creature an opponent controls would die -> exile it and create a token instead; type_line restriction on the sacrifice_creature activation cost (e.g. 'another Vampire or Zombie') |
| Krile Baldesion | partial/high | graveyard-return filter: mana value EQUAL to the triggering spell's mana value (spell MV carried on the spell_cast watcher payload) |
| Midnight Clock | partial/high | broadcast each-upkeep trigger event (all players' upkeeps); trigger on the Nth counter being placed on the source permanent; effect: shuffle hand and graveyard into library, then draw N |
| Mirage Phalanx | partial/high | soulbond pairing state with a paired-condition gate on triggers; granting a triggered ability to another permanent (both paired creatures get the ability); copy_permanent self-target usable from turn-step triggers (no triggering_creature at begin_combat) |
| Mirkwood Bats | partial/high | token_created watcher event (whenever you create a token); positive token-only filter on permanent_sacrificed (only nontoken exists today) |
| Mirror Entity | inert/high | creature-type granting / changeling (is every creature type); set_pt with an 'X' amount and an all-your-creatures scope (mass base-P/T setting from an {X} activation) |
| Naru Meha, Master Wizard | partial/high | copy target instant or sorcery spell on the stack (with option to choose new targets); honor flash keyword (cast permanents at instant speed) |
| Ophiomancer | partial/high | broadcast each-upkeep trigger event (turn-step events fire for the active player only); enforceable 'you control no <type>' condition (conditional supports only at_least >= 1, no zero/at-most check) |
| Ragavan, Nimble Pilferer | partial/high | impulse-exile from another player's library (exile top card of the damaged player's library, castable until end of turn) — impulse acts only on your own library; dash alternative cost (gains haste, returns to hand at the beginning of the next end step) |
| Read the Runes | partial/high | per-card-drawn repeated choice: discard a card unless you sacrifice a permanent (pay-or-else loop, X iterations) |
| Reaper's Scythe | partial/high | continuous equipped-creature pump scaling with counters on the source Equipment (power_count reads only the fixed count enum, not the source's counter bag); type-adding continuous effect (equipped creature is an Assassin in addition to its other types) |
| Reckless Fireweaver | partial/high | watcher event for any artifact (or permanent) entering the battlefield, not just creatures |
| Rogue's Passage | partial/high | grant 'can't be blocked this turn' to a target creature (unblockable is absent from the grant_keyword enum and not modelled as a continuous effect) |
| Ruinous Ultimatum | partial/high | controller/scope filter on destroy_all's types-array branch (mass destroy of multiple types limited to opponents' permanents) |
| Scavenging Ooze | partial/high | +1/+1-counter rider on graveyard exile when the exiled card is a creature (exile_from_any_graveyard gain rider currently gives life only, and pumps EOT on noncreature); exile_from_any_graveyard reachable from a single-effect activated ability (activate_ability's single-effect dispatch raises 'Unsupported ability effect' for it; only >1-effect programs reach apply_trigger_effects) |
| Shimmer Myr | inert/medium | flash keyword honored by the cast timing gate (cast at instant speed); static continuous effect: controller may cast <filter, e.g. artifact> spells as though they had flash |
| Thundermaw Hellkite | partial/high | controller scope on deal_damage_all's filter (opponents-only mass damage — current filter is flying/exclude_source/exclude_type only and hits ALL players' creatures); 'tap those creatures' rider on mass damage |
| Trove Warden | partial/high | linked exile tracking ('exiled with this') with return-to-battlefield under owners' control when the source dies; mana-value filter on targeted graveyard exile |
| Urianger Augurelt | partial/high | face-down linked exile pool ('exiled with this') with a later 'play those cards this turn' unlock and {2} cost reduction; watcher event for playing a LAND from exile (not just casting a spell); impulse/look_top effects dispatchable from single-effect activated abilities |
| Vampire Nocturnus | partial/high | persistent 'play with the top card of your library revealed' state (public library-top visibility) |
| Vandalblast | partial/high | controller-scoped mass artifact destruction (destroy each artifact your opponents control) |

## Fundamenteel niet uitdrukbaar (3)

- **Abundance** — Draw-replacement effect (choose land or nonland, reveal until a card of the chosen kind, hand it, bottom the rest) is a pure replacement effect with no engine primitive
- **Imprisoned in the Moon** — Type-change + ability-removal lock inexpressible — enchanted permanent keeps its types, abilities and mana production; only a 0/1 set_pt neutralizer applies (and does nothing against lands/planeswalkers)
- **Mirror Gallery** — 'The legend rule doesn't apply' is a rules-modification replacement the engine cannot express (§5 — no legend-rule suppression); the card stays inert.
## Engine-fixes die tijdens het toepassen nodig bleken

- **mig 202605010393 `effective_script_scalar_guard`** — `effective_script` crashte ("cannot set path in scalar") wanneer een granted ability landde op een kaart met jsonb-`null` als catalogscript (Hero-token uit `job_select`, blootgelegd door Astrologian's Planisphere). Guard toegevoegd; ook op de lokale speel-DB toegepast.
- **deck-smoke driver** — leverde blind een victim als trigger-target en negeerde `target_filter` (mig 310); bij een optioneel gefilterd effect (Thancred Waters, Legendary-filter) declinet hij nu, wat meteen het fizzle-pad test.

## Engine-shortlist — features gerangschikt op ontsloten kaarten

Gebundeld uit de `engine_needs` van alle 87 triages. Aantallen = kaarten uit déze fix-lijst; de medium/low-lijst van de audit bevat er vaak meer.

1. **`draw.recipient` honoreren (each_opponent/each_player)** — feitelijk een engine-bug: het veld bestaat in schema en scripts maar de runtime trekt altijd voor de controller. Ontgrendelt Cut a Deal (rest), Tataru Taru; corpus-breed elke "each player draws"-kaart.
2. **Opponent-scope op mass-effecten** (`pump_all` scope opponent, `deal_damage_all` controller-filter, scope op de types-branch van `destroy_all`) — Phyresis Outbreak, Thundermaw Hellkite, Ruinous Ultimatum, Vandalblast.
3. **Broadcast each-upkeep / each-draw-step events** (nu vuurt alleen `beginning_of_each_end_step` voor iedereen) — Ophiomancer, Midnight Clock, Kami of the Crescent Moon; audit-breed ±7 kaarten.
4. **Unblockable-grant** ('can't be blocked this turn' in grant_keyword of als continuous effect) — Rogue's Passage, Ghostly Pilferer, Hraesvelgr, Breath of the Sleepless.
5. **Flash in de cast-timing gate** (+ statisch "as though they had flash") — Shimmer Myr, Naru Meha, Wildborn Preserver, Thancred Waters, Breath of the Sleepless.
6. **`token_created` watcher-event + count `tokens_created_this_turn`** — Mirkwood Bats, Idol of Oblivion.
7. **Draw-count watchers** (Nth kaart per beurt; opponent trekt) — Ethereal Investigator, Astrologian's Planisphere, Tataru Taru.
8. **Mana-value filters op picks** (search_library max MV; graveyard-return MV-gelijk; graveyard-exile MV) — Trinket Mage, Krile Baldesion, Trove Warden.
9. **Per-opponent herhaling** ("for each opponent, ...") — Bronzebeak Foragers, Wurmquake, Caress-klasse multiplayer-schaal uit de audit.
10. **Linked exile ("exiled with this") met terugkeer** — Trove Warden, Urianger Augurelt, Bronzebeak Foragers.
11. **Subtype-filter op sacrifice-kosten** — Professional Face-Breaker (Treasure), Kalitas (Vampire/Zombie).
12. **`once_per_turn` op self-events** (attacks) — Aurelia en Godo zijn nu omgelegd naar de watcher; een self-event-stempel maakt die workaround overbodig.
13. **create_token riders** (enters attacking; met N counters; exile at end of combat; grootte = mana spent) — Geist of Saint Traft, G'raha Tia, Wurmquake.
14. **Stun/niet-untappen volgende untap step** — Frost Titan.
15. **Generieke replacement effects** — Abundance, Kalitas, Gisela (grootste maar duurste gat).
16. **Type-changing layer** (changeling, added types, animate met MV-P/T, land wordt gekozen type) — Mirror Entity, Imprisoned in the Moon, Sydri, Multiversal Passage, Reaper's Scythe, Astrologian's.


## Engine-batch 1 — uitgevoerd (mig 394–397, zelfde dag)

De top-4 van de shortlist is dezelfde dag geïmplementeerd; suite 2321/2321 groen.

| Mig | Feature | Ontgrendeld |
|---|---|---|
| 394 | `draw.recipient` gehonoreerd (each_opponent / each_player) + client: dynamische draw via programmapad | **Cut a Deal** volledig (opponents trekken nu echt; bug-2684) |
| 395 | Opponent-scope op mass-effecten: `pump_all` scope 'opponent' (rij per opponent), `deal_damage_all` filter.controller + `tap_damaged`, `destroy_all` types-branch honoreert `scope`; schema-catch-up voor `destroy_all.types`/`min_power` | **Phyresis Outbreak** (-X/-X alleen opponents, schaalt met poison), **Thundermaw Hellkite** (ETB 1 dmg + tap op vliegers van opponents), **Ruinous Ultimatum** (volledige nonland-wipe alleen bij opponents) |
| 396 | Broadcast events `beginning_of_each_upkeep` / `beginning_of_each_draw_step` (patroon mig 206) + draw recipient 'active_player' | **Midnight Clock** (tikt elke upkeep), **Ophiomancer** (may-Snake elke upkeep), **Kami of the Crescent Moon** (elke speler trekt in eigen draw step) |
| 397 | `grant_keyword 'unblockable'` + `card_has_unblockable` + declare_blocker-guard + CHECK-constraint | **Rogue's Passage** ({4},{T} werkt), **Hraesvelgr** (can't-be-blocked riders) |

Nieuwe tests: `draw-recipient` (3), `mass-effect-opponent-scope` (4), `broadcast-turn-step-events` (2), `unblockable-grant` (1); fixtures `Each Upkeep Ticker Test`, `Each Draw Gifter Test`. Migrations staan ook op de lokale speel-DB; scripts opnieuw geseed.

Nog open van de shortlist: punten 5–16 (o.a. flash-timing gate, token_created watcher, draw-count watchers, MV-filters, per-opponent herhaling, replacement effects).


## Engine-batch 2 — uitgevoerd (mig 398–400, 15 juli)

| Mig | Feature | Ontgrendeld |
|---|---|---|
| 398 | **Flash in de cast-timing gate**: `card_has_flash` (printed/script keyword + `flash_permission` statics), bypass van de sorcery-gate in `cast_card_from_hand`, client-castbaarheid (getCanQuickCast/canCardRespond/sheet) | Elke kaart met printed Flash werkt nu op instant speed (o.a. **Snapcaster**, **Torrential Gearhulk**, **Naru Meha**, **Wildborn Preserver**, **Thancred**); **Shimmer Myr** geeft al je artifacts flash; **Breath of the Sleepless** geeft Spirits flash |
| 399 | **`token_created` watcher + `tokens_created_this_turn` count**: AFTER INSERT-trigger op game_cards (centraal — vangt create_token, copy-tokens, job_select, amass), turn-stamped tally (note_spell_cast-patroon), default-typefilter '' voor token-events | **Mirkwood Bats** (drain bij token maken én token offeren), **Idol of Oblivion** (draw-gate mechanisch afgedwongen) |
| 400 | **`max_mana_value` op search_library** (opties = submit-whitelist) | **Trinket Mage** kan alleen nog MV≤1 artifacts tutoren |

Bijvangst: `functions_src/fire_watcher_triggers.sql` bleek stale t.o.v. mig 388 (adventure-face blok ontbrak — bug-2689, bug-1280-klasse); gebackfilled vóór regeneratie. Nieuwe tests: flash-timing (2), token-created-watcher (3), search-max-mana-value (1); fixtures Flash Bear / Artifact Flash Grantor / Token Toll / Token Gated Draw / Cheap Bauble / Trinket Tutor.

Nog open van de shortlist: draw-count watchers (Nth kaart per beurt), per-opponent herhaling, linked exile, subtype-sacrifice-kosten, stun, replacement effects, type-changing layer.


## Engine-batch 3 — uitgevoerd (mig 401–403, 15 juli)

| Mig | Feature | Ontgrendeld |
|---|---|---|
| 401 | **`card_drawn` watcher** met per-turn index (`note_card_drawn`, spell_number-patroon) + filters `draw_number` en `off_turn`; alle echte draw-sites geïnstrumenteerd (natural draw, draw-effect, cycling) | **Ethereal Investigator** (Spirit op je tweede draw), **Astrologian's Planisphere** (counter op je derde draw, via tweede granted ability), **Tataru Taru** (Scions' Secretary: tapped Treasure bij off-turn opponent-draws, once per turn) |
| 402 | **Subtype/another-filters op sacrifice-kosten** (`sacrifice_artifacts.type_line`, `sacrifice_creature.type_line_any`+`another`) + fix: de kost-keuze lekte door als effect-target | **Professional Face-Breaker** (Sacrifice a Treasure → impulse werkt volledig), **Kalitas** (alleen nog een andere Vampire/Zombie als voer) |
| 403 | **Stun** — `tap` met `stun:true` legt een stun-counter; de untap-stap slaat het permanent één keer per counter over (exert-patroon, decrementerend) | **Frost Titan**'s tap-rider ("doesn't untap during its controller's next untap step") op ETB én attack |

Bekende randjes: Etchings of the Chosen's sac-ability geeft nu een eerlijke "target required"-fout i.p.v. de grant op het geofferde lijk te richten (twee-picks-support voor sac-kost + targeted effect staat op de shortlist); Goblin Bombardment's creature-mode heeft hetzelfde dubbelrol-probleem. Nieuwe tests: card-drawn-watcher (2), sacrifice-filters-and-stun (3); fixtures Second Draw Spirit / Off Turn Secretary / Treasure Cracker / Tribal Butcher.


## Engine-batch 4 — uitgevoerd (mig 404, 15 juli)

| Mig | Feature | Ontgrendeld |
|---|---|---|
| 404 | **exile_until_leaves: multi-target + `return_to`** — de `exiled_until_leaves`-terugkeer splitst nu op payload.return_to (battlefield default / hand), en de optionele multi-target-picker (`choose_triggered_ability_targets`) accepteert nu ook optionele "up to N"-triggers (was required-only; bug-2691, tevens uit mig 116 naar functions_src gebackfilld) | **Angel of Serenity** (battlefield-helft volledig: exile up to three, keer terug naar de handen van de eigenaars bij vertrek) |

Resteert voor Angel: de graveyard-helft ("and/or creature cards from graveyards") — dat vergt graveyard-targeting voor triggers (zie hieronder). Nieuwe test: exile-until-leaves-return-to (2); fixture Serenity Angel.

## Nog open — grote subsystemen (aparte scope aanbevolen)

De resterende auditkaarten hangen elk aan een substantieel nieuw subsysteem, niet aan een losse veldtoevoeging:

- **Replacement effects** (generiek raamwerk): Kalitas (would-die → exile + Zombie), Gisela (schade verdubbelen/halveren), Abundance (draw-replacement). Grootste brok; raakt de schade- en zone-change-pijplijn breed.
- **Type-changing / layer-systeem**: Mirror Entity (changeling + X/X), Sydri (animate met P/T = mana value), Multiversal Passage (land wordt gekozen type), Imprisoned in the Moon (word land, strip abilities), Reaper's Scythe (Assassin + counter-schaal).
- **Graveyard-targeting voor triggers**: Trove Warden (landfall exile uit je graveyard, terug bij dood — de terugkeer-helft werkt al via exiled_until_leaves), Angel of Serenity graveyard-helft.
- **Twee-picks abilities** (sac-kost ÉN effect-target): Etchings of the Chosen, Goblin Bombardment creature-mode — geven nu een eerlijke fout i.p.v. mis-targeting (bug-2690); volledige fix vergt client-side twee picks.
- **Per-opponent dynamische target-count** + **mana-spent-to-cast** amount: Bronzebeak Foragers (exile per opponent), Wurmquake (token-grootte = betaalde mana).

Aanbeveling: elk hiervan als eigen mini-project scopen; replacement effects en het layer-systeem zijn de duurste en het risicovolst voor regressies.

## Schema-achterstand (bevinding, geen blokker)

`optional`, `target_filter` en `targets` op trigger-effecten worden door de SQL-runtime gehonoreerd (enqueue_triggered_ability, mig 310, mig 116) maar door de Zod-parse gestript. Het corpus bevat al ±15 kaarten die deze velden gebruiken (o.a. Opportunistic Dragon — nota bene het mig 310-voorbeeld). De upsert/seed-flow slaat het rúwe script op, dus runtime-gedrag klopt; maar elk toekomstig gereedschap dat via de Zod-parse round-tript verliest ze stilletjes (bug-1484-klasse). Kandidaat-fix: velden toevoegen aan de betreffende Zod-varianten, met de registry-variant-matching gotcha (cerebrum 2026-06-07) in het achterhoofd.

## Toegepast & geverifieerd

- 45 gewijzigde scripts in `docs/commander-decks/card-scripts.json` (bron van waarheid).
- Lokaal geseed met `seed-scripts-local.mjs --force` (speel-DB :54322/postgres).
- Validatie: Zod-parse + deep-diff + unknown-action-type sweep op alle 45; getSpellPlan-dekking gecheckt voor de gewijzigde instants/sorceries.
- Testsuite: volledige suite groen na de fixes — 2311/2311 (incl. deck-smoke: alle 954 curated scripts draaien op ETB/dies/cast).
- Hosted push gebeurt bewust NIET automatisch: draai `node --import tsx scripts/upsert-deck-scripts.mjs --apply --force` wanneer je de fixes live wil.
