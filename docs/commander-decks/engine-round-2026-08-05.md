# Engine-ronde 5–6 augustus 2026 — migs 428–441 (v0.20)

Zestien feature-slices in één doorlopende sessie, aansluitend op de
landcycling-slice (mig 427). **68 backlog-kaarten dicht (280 → 212)**, suite
gegroeid van 2494 naar 2566 tests. Buckets 2 t/m 8 van
`engine-blocked-backlog-2026-07-18.md` zijn afgewerkt; wat per bucket rest
staat onderaan. Elke slice is RED-first getest, per slice gecommit
(feat + aparte chore(wolf)), en beide lokale DB's (play + `leyline_test`)
lopen mee t/m mig 441. **Niets is gepusht of gedeployed.**

## Migratie-overzicht

| Mig | Slice | Kaarten dicht |
|---|---|---|
| 428 | Overload | Cyclonic Rift, Vandalblast |
| 429 | Conditionele gratis cast | Deadly Rollick |
| 430 | Buyback | Disturbed Burial, Mind Games |
| 431 | Delve | Treasure Cruise, Dig Through Time |
| 432 | Convoke (+ grant) | Hour of Reckoning, Triplicate Spirits, Markov Baron (convoke), Chief Engineer |
| 433 | Evoke / blitz / spectacle | Mulldrifter, Mayhem Patrol, Light Up the Stage |
| 434 | Madness | From Under the Floorboards, Markov Baron (madness) |
| 435 | Per-opponent amounts/targets | Exsanguinate, Malakir Bloodwitch, Sanguine Bond, Vito, Priest of the Blessed Graf, Struggle // Survive |
| 436 | Corrupted per-opponent, goad-all | Feed the Infection, Phyrexian Atlas, Geth's Summons, Geode Rager, Fiery Confluence |
| 437 | Situationele cost-reduction | Baral, Into the Story, Lyse Hext, Nogi (+ script-fixes Marauding Raptor, Undead Warchief; Alisaie bleek al gedekt) |
| 438 | Damage replacement & self-damage | Gisela, Eshki, Drogskol Reinforcements, 4 talismans, Sulfurous Springs, Underground River (+ Yavimaya Coast, b2) |
| 439 | Planeswalker-eligible effects | Hour of Revelation, Sorin (+ script-fixes Banishing Light, Demon's Disciple, Plaguecrafter, Haven; Norn's Annex bleek al gedekt) |
| 440 | Other/another-exclusies & sorcery-timing | End-Raze Forerunners, Xenagos, Majestic Heliopterus, Orthion (+ 4 vacuous/stale, zie onder) |
| 441 | Mana-ability-riders | Glistening Sphere, Drover of the Mighty, Labyrinth of Skophos, Rupture Spire (+ Elves of Deep Shadow script-only, + Transguild Promenade uit b26) |

## Nieuwe script-vocabulaire (voor kaart-auteurs)

### Cast-modifiers (top-level script-velden)

Alle cast-modifiers zijn engine-geverifieerd: de client stuurt alleen de
intentie (RPC-param), de engine valideert het script en betaalt/handhaaft.

| Veld | Vorm | Betekenis | RPC-param |
|---|---|---|---|
| `overload` + `overload_effect` | mana-string + spell_effect | Alternatieve cost; engine draait het overload-programma (massa, untargeted) i.p.v. het client-programma — flashback_effect-precedent | `cast_spell_effect(p_overload)` |
| `free_cast_condition` | `{controls_commander: true}` | "Cast gratis als je een commander controleert" — alleen de betaling vervalt; priority/timing/targeting blijven | `put_action_on_stack(p_free_cast)` |
| `buyback` | mana-string | Additionele cost; de kaart keert bij resolutie terug naar de hand (finalize_stack_resolution leest de payload-stamp; countered = graf) | `p_buyback` op cast_spell_effect én put_action_on_stack |
| `delve` | `true` | Gekozen graf-kaarten (distinct, eigen graf, ≤ generic-deel) gaan naar exile en betalen elk {1} | `p_delve_card_ids` op beide cast-RPC's |
| `convoke` | `true` | Gekozen untapped creatures tappen en betalen elk een passende kleur-pip of {1} (apply_convoke; token zonder mana-cost = alleen generic) | `p_convoke_card_ids` op cast_spell_effect én cast_card_from_hand |
| `evoke` / `blitz` | mana-string | Alternatieve cost op permanents; rider bij resolutie (evoke: sac na ETB; blitz: haste + dies-draw + end-step-sac) | `cast_card_from_hand(p_alt_cost)` — whitelisted key |
| `spectacle` | mana-string | Alternatieve cost, alleen zolang een opponent deze beurt leven verloor (life_lost_this_turn) | `cast_spell_effect(p_spectacle)` |
| `madness` + `madness_effect` | mana-string + spell_effect | Discard → exile + madness_cast-decision; cast vanuit exile voor de madness-cost ({X} ondersteund), madness_effect vervangt het basisprogramma | discard_card-helper + submit_decision |

De statische tegenhanger: continuous effect `grants_convoke` (payload
`{type_line}`) geeft matchende casts convoke (Chief Engineer).

### Overige nieuwe velden & acties

- **Acties**: `shuffle_graveyards_into_libraries` (Survive), `goad_all`
  (genest onder choose_player; goader = source-controller),
  `corrupted_summons` (stack-loze pick per corrupted opponent), `grant_type`
  (until-EOT granted_type-add op de source), `remove_from_combat` (targeted;
  eigen stack-actietype), `sacrifice_unless_pay` (ETB pay-or-sacrifice).
- **Effect-riders**: `times_opponents` (bedrag × aantal opponents),
  `recipient_filter {poison_at_least}` (per-opponent corrupted-gate op
  lose_life/deal_damage), `if_target_type_line` (add_counters-rider, checkt
  de effective type line), `target_filter {type_line, type_line_any,
  exclude_self}` op targeted trigger-effects (pump/grant_keyword),
  `exclude_self` op pump_all/grant_keyword_all, `required` op destroy_up_to,
  `scope: 'opponent'` op bounce_all.
- **Kosten**: `self_damage` (mana-ability-cost; échte damage door
  apply_damage_to_player — nooit meer pay_life voor "deals N damage to you").
- **Condities**: activation-`condition` werkt nu ook op mana-abilities;
  card-scoped pump-statics dragen een payload-`condition` die de P/T-fold
  live evalueert ("as long as you control a Dinosaur"); activated-ability
  `timing: 'sorcery'` wordt afgedwongen.
- **Nieuwe counts** (resolve_count_amount): `opponents_with_more_lands`,
  `opponent_graveyard_cards`, `nonland_permanents_on_battlefield`,
  `opponents_attacked_this_combat`.
- **Nieuwe statics**: `damage_double_to_opponents` en `damage_prevent_half`
  (Gisela) — toegepast in apply_damage_to_player én apply_damage_to_creature
  vóór de shields, verdubbelen vóór halveren.
- **Nieuw watcher-event**: `spell_countered` (gevuurd door
  handle_counter_spell na een geslaagde counter; type-filter-default '').
- **Structureel**: scripted `deal_damage` naar spelers routeert door
  apply_damage_to_player (prevention/statics gelden); `event_amount` wordt
  pre-resolved in choose_player-parkeringen; `discard_card` is het enige
  hand→graf-discard-pad (madness-interceptie).

### Nieuwe helpers (functions_src)

`reduce_generic_cost(cost, by)`, `apply_convoke(session, caster, cost, ids)`,
`discard_card(session, card)`; nieuw canoniek gemaakt (uit oude migraties
geseed): `finalize_stack_resolution`, `build_stack_payload_add_counters_creature`.

## Client-toevoegingen (CardActionSheet / ControllerListV5)

- **Cast-knoppen**: Overload (sky), Cast free (emerald), Buyback (fuchsia),
  Delve (teal, met graf-picker), Convoke (orange, met creature-picker),
  Evoke (cyan), Blitz (rose), Spectacle (yellow) — naast de bestaande
  kicker/adventure-knoppen. Delve/convoke-pickers tonen live de herrekende
  cost (`reduceGenericCost` / `convokeReducedCost` in shared.ts, mirrors van
  de engine-herschrijving).
- **Decisions**: `MadnessBody` (cast met {X}-invoer / to graveyard),
  `sacrifice_unless_pay` → ConfirmBody, `corrupted_summons_pick` →
  generieke CardPickBody.
- **autoPay** kent nu drie smaken: `extra` (additioneel: kicker/buyback),
  `override` (alternatief: adventure/overload/evoke/blitz/spectacle) en
  override-met-berekende-cost (delve/convoke).
- `remove_from_combat` in ABILITY_EFFECT_TYPES/ABILITY_VERB.
- **Let op: geen van deze UI is al in een echt potje bekeken** — dat is de
  aanbevolen eerste stap vóór verdere UI of een OVH-deploy.

## Gevonden bugs (buglog)

- **bug-2702** — overbodige @ts-expect-error brak repo-brede tsc.
- **bug-2703** — PL/pgSQL NULL-propagation liet de free-cast-guard passeren
  (`jsonb_typeof(ontbrekende key) <> 'x'` is NULL); coalesce-fix, door de
  RED-test gevangen vóór commit.
- **bug-2704** — PS 5.1 Get-Content/Set-Content dubbel-codeerde 176
  comment-tekens in CardActionSheet.tsx (mojibake); generiek hersteld.
- **bug-2705** — de onSpellEffect-render-site droppte de convoke/delve-args
  (korter-getypeerde callback slikt extra args); convoke op spell-programma's
  deed daardoor niets convoke-achtigs.

## Bewuste benaderingen (nieuw in deze ronde)

- Convoke: token-creatures zonder mana-cost betalen alleen generic (catalog
  heeft geen kleuren-kolom); kleur-pip-matching is greedy per creature.
- Gisela: volgorde verdubbelen→halveren benadert de CR-spelerskeuze.
- Spectacle-knop toont client-side op script+timing; de server handhaaft de
  life-loss-conditie (get_controller_state exposeert de tracker niet).
- Madness hookt alle discard-paden behalve cycling-discards (geen overlap in
  de huidige kaartpool).
- "Another target"-triggers: de resolve-guard kent filters niet — een
  board-wijziging tussen enqueue en resolve kan in theorie klemmen
  (pre-existing klasse, geldt ook voor type-filters).
- Plaguecrafter: de "who can't sacrifices discards a card"-fallback ontbreekt
  nog (speler zonder creature/planeswalker wordt geskipt).
- Drogskol: "other Spirits have melee" en de noncombat-preventie voor Spirits
  blijven ongescript (alleen de melee-schaal is gefixt).

## Open rest na deze ronde (per bucket)

- **b2 (11)**: Ancient Excavation, Blasphemous Edict, Blinkmoth Urn,
  Counterflux, Ezuri (regenerate), March of Wretched Sorrow, New Blood,
  Ragavan, Regal Behemoth, Sylvan Reclamation, Thunderherd Migration —
  misfits die inhoudelijk in andere buckets horen.
- **b3 (1)**: Emet-Selch — vergt een life-loss-watcher-event;
  track_life_lost is een BEFORE-row-trigger, daar horen geen stack-inserts
  (ontwerp: expliciete fire-punten of AFTER-statement-mechanisme).
- **b4 (2)**: Savage Stomp (target-afhankelijke cost — de betaalketen kent
  het target niet), Wayta (trigger-verdubbeling — replacement op
  enqueue_triggered_ability).
- **b6 (2)**: Myr Battlesphere (tap-X-Myr = multi-pick-cost-UI +
  defending-player-recipient), Xantcha (forced attacks — zelfde
  onafgedwongen klasse als goads must-attack-helft).
- **b8 (1)**: Coveted Jewel (unblocked-attackers-watcher + controlewissel).
- **Vacuous zolang er geen legend rule is** (b7, afgevinkt met notitie):
  Mirror Gallery, The Masters legend-clausule, Helms except-legendary.
- **b9 t/m b34**: onaangeroerd deze ronde (behalve b26: Transguild
  Promenade dicht); zie de backlog-doc.

## Registratie-checklists (de drie vindplaatsen-lessen)

Bij een **nieuw continuous-effect-type**: allowlist in
register_card_continuous_effects + CHECK op game_continuous_effects
(hand-DDL, herbouw de lijst). Bij een **nieuw stack-actietype**:
stack_action_handlers-row + CHECK op game_stack_items + client-vocab
(ABILITY_EFFECT_TYPES/VERB). Bij een **nieuw decision-type**: alleen de
submit_decision-branch + client-decision-renderer (geen CHECK). Bij een
**nieuw payload-veld door put_action_on_stack**: check de builder
(whitelist-rebuild!). Bij een **nieuwe count**: resolve_count_amount + elk
zod-enum waar het woord thuishoort (~8 kopieën) — de hosted-upsert-validator
en de registry-drift-guard vangen vergeten plekken.
