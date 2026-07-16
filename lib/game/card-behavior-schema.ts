import { z } from 'zod'

// ─── Shared primitives ───────────────────────────────────────────────────────

const ManaColorSchema = z.enum(['W', 'U', 'B', 'R', 'G', 'C'])

// A mana ability may produce a fixed colour, 'commander' = "one mana of any colour in
// your commander's colour identity" (Command Tower, Arcane Signet), or 'any' = "one mana
// of any colour" (Chromatic Lantern, rainbow lands). The client resolves 'commander'/
// 'any' to a chosen colour at tap time (the server validates 'commander' against the
// identity; 'any' is unrestricted).
const ManaProductionColorSchema = z.union([ManaColorSchema, z.literal('commander'), z.literal('any')])

const GameZoneSchema = z.enum(['library', 'hand', 'stack', 'battlefield', 'graveyard', 'exile'])

const BehaviorZoneSchema = z.union([GameZoneSchema, z.enum(['command', 'any'])])

// Shared by both V1 and V2 — kept permissive (no .strict()) because
// continuous effects carry payload data and are extended incrementally.
export const CardContinuousEffectSchema = z.object({
  type: z.string().optional(),
  effect_type: z.string().optional(),
  affected: z.string().optional(),
  source_zone_required: z.string().optional(),
  amount: z.number().optional(),
  colors: z.array(z.string()).optional(),
  // protection: the colour this card is protected from (white|blue|black|red|green).
  from: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  expires_at_turn_number: z.number().optional(),
  expires_at_phase: z.string().optional(),
  expires_at_step: z.string().optional(),
})

// ─── V1 schemas ──────────────────────────────────────────────────────────────

const KNOWN_V1_ACTION_TYPES = ['add_mana', 'deal_damage', 'counter_spell'] as const

// The catch-all only matches action types we haven't explicitly modelled,
// preventing known types with typo'd fields from silently passing.
// target_type may be a single type or a list (e.g. "any target" -> creature + player).
const TargetTypeSchema = z.union([z.string(), z.array(z.string())]).optional()

const UnknownV1ActionSchema = z.object({
  type: z.string().refine(
    (t) => !(KNOWN_V1_ACTION_TYPES as readonly string[]).includes(t),
    { message: 'Known V1 action type with invalid fields — check required fields for this type' },
  ),
  color: z.string().optional(),
  colors: z.array(z.string()).optional(),
  amount: z.number().optional(),
  power: z.number().optional(),
  toughness: z.number().optional(),
  target: z.string().optional(),
  target_type: TargetTypeSchema,
  timing: z.string().optional(),
  expires_at_phase: z.string().optional(),
  expires_at_step: z.string().optional(),
})

export const CardActionSchema = z.union([
  z.object({
    type: z.literal('add_mana'),
    color: ManaProductionColorSchema,
    amount: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('deal_damage'),
    amount: z.number().int().positive(),
    target: z.string().optional(),
    target_type: TargetTypeSchema,
    timing: z.string().optional(),
    expires_at_phase: z.string().optional(),
    expires_at_step: z.string().optional(),
  }),
  z.object({
    type: z.literal('counter_spell'),
    target: z.string().optional(),
    target_type: TargetTypeSchema,
    timing: z.string().optional(),
  }),
  UnknownV1ActionSchema,
])

// .strict() at the top level catches hallucinated top-level keys —
// the most common mistake when writing scripts by hand or with an LLM.
// Characteristic-defining P/T (layer 7a, mig 149): "~'s power and toughness are
// each equal to the number of creatures you control" (*/* cards). Inherent data
// read straight from the script by card_cda_value — version-agnostic, so both
// the V1 and V2 schemas accept it. (Caught missing by validate:fixtures.)
const CdaValueSchema = z.object({
  count: z.enum(['creatures_you_control', 'lands_you_control', 'cards_in_graveyard', 'artifacts_you_control', 'creature_cards_in_opponents_graveyards']),
  type_line: z.string().optional(),
  plus: z.number().int().optional(),
})
const CdaSchema = z.object({
  power: CdaValueSchema.optional(),
  toughness: CdaValueSchema.optional(),
})

export const CardScriptV1Schema = z.object({
  actions: z.array(CardActionSchema).optional(),
  continuous_effects: z.array(CardContinuousEffectSchema).optional(),
  triggers: z.array(z.string()).optional(),
  // Equipment: the mana cost of its equip ability (e.g. "{1}").
  equip_cost: z.string().optional(),
  cda: CdaSchema.optional(),
}).strict()

// ─── V2 schemas ──────────────────────────────────────────────────────────────

const BehaviorTargetTypeSchema = z.enum([
  'any',
  'artifact',
  'battle',
  'creature',
  'enchantment',
  'opponent',
  'permanent',
  'nonland_permanent',
  'planeswalker',
  'player',
  'spell',
])

// A small rider applied to the CASTER after a targeted removal resolves
// ("…and you lose 3 life" / "…and you draw a card"). Simple untargeted effects only.
const ThenRiderSchema = z
  .array(
    z.object({
      type: z.enum(['lose_life', 'gain_life', 'draw']),
      // A fixed number, or {mana_value_of:'target'} = the targeted/destroyed
      // permanent's mana value (Feed the Swarm: "lose life equal to its mana value").
      amount: z.union([z.number().int().nonnegative(), z.object({ mana_value_of: z.literal('target') })]),
    }),
  )
  .optional()

const KNOWN_V2_COST_TYPES = [
  'tap_self', 'untap_self', 'mana', 'pay_life',
  'sacrifice_self', 'discard', 'exile_self', 'energy', 'tap_creatures', 'remove_counters',
  'sacrifice_artifacts',
] as const

const UnknownCostSchema = z.object({
  type: z.string().refine(
    (t) => !(KNOWN_V2_COST_TYPES as readonly string[]).includes(t),
    { message: 'Known cost type with invalid fields — check required fields for this type' },
  ),
}).passthrough()

const CardBehaviorCostSchema = z.union([
  z.object({ type: z.literal('tap_self') }),
  z.object({ type: z.literal('untap_self') }),
  z.object({ type: z.literal('mana'), amount: z.string() }),
  z.object({ type: z.literal('pay_life'), amount: z.number() }),
  z.object({ type: z.literal('sacrifice_self') }),
  // "Sacrifice a creature" as a cost (Spark Reaper, Vampiric Rites) — the chosen
  // creature you control is passed at activation. type_line_any (mig 402,
  // Kalitas: "another Vampire or Zombie") restricts the pick to matching type
  // words; another:true forbids sacrificing the source itself.
  z.object({
    type: z.literal('sacrifice_creature'),
    type_line_any: z.array(z.string()).optional(),
    another: z.boolean().optional(),
  }),
  z.object({ type: z.literal('discard'), amount: z.number() }),
  z.object({ type: z.literal('exile_self'), from_zone: BehaviorZoneSchema.optional() }),
  // "Exile a creature card from a graveyard" (Cemetery Reaper). type_line filters
  // the exiled card (default "creature"); the chosen card is passed at activation.
  z.object({ type: z.literal('exile_from_graveyard'), type_line: z.string().optional() }),
  z.object({ type: z.literal('energy'), amount: z.number() }),
  // "Tap N untapped <type> creatures you control" as a cost (Gravespawn
  // Sovereign, mig 212). The engine auto-picks which to tap.
  z.object({ type: z.literal('tap_creatures'), count: z.number().int().positive(), type_line: z.string().optional() }),
  // "Sacrifice N artifacts" as a cost (Breya / Thopter Foundry, mig 264). The
  // engine auto-picks the cheapest-MV matching artifacts (source excluded).
  // type_line (mig 402, Professional Face-Breaker: "Sacrifice a Treasure")
  // narrows the pick to a subtype.
  z.object({ type: z.literal('sacrifice_artifacts'), count: z.number().int().positive().optional(), nontoken: z.boolean().optional(), type_line: z.string().optional() }),
  // 'Return a land you control to its owner's hand' as a cost (Mina and Denn, mig 277).
  z.object({ type: z.literal('return_land'), count: z.number().int().positive().optional() }),
  // "Remove N <kind> counters from this permanent" as a cost (Grimoire of the
  // Dead, mig 214). Bag counters on the SOURCE.
  z.object({ type: z.literal('remove_counters'), counter_type: z.string(), amount: z.number().int().positive() }),
  UnknownCostSchema,
])

export const KNOWN_V2_ACTION_TYPES = [
  'add_mana', 'deal_damage', 'counter', 'gain_life', 'lose_life', 'draw',
  'create_token', 'add_counters', 'destroy', 'exile', 'bounce', 'tap', 'untap',
  'pump', 'pump_all', 'mill', 'scry', 'surveil', 'search_library', 'discard', 'may', 'choose_player', 'choose_creature_type', 'tap_self',
  'add_counters_all', 'tap_all', 'untap_all', 'grant_keyword', 'grant_dies_effect', 'blink', 'myriad', 'saw_in_half', 'delina_d20', 'donate_self', 'fight', 'gain_control',
  'sacrifice', 'return_from_graveyard', 'prevent_damage', 'set_pt',
  'add_player_counters', 'proliferate', 'grant_cast_from_graveyard', 'amass',
  'destroy_all', 'return_all_from_graveyard', 'exile_from_graveyard', 'conditional',
  'curse_attack_zombie', 'grant_keyword_all', 'mass_destroy_reanimate_one', 'choose_color', 'reanimate_from_graveyard', 'look_top', 'deal_damage_all',
  'impulse', 'choose_one', 'monstrosity', 'damage_each_opponent_by_hand', 'divide_damage',
  'return_self_to_hand', 'copy_permanent', 'become_copy', 'shuffle_into_library',
  'pay_x_mana_damage', 'bounce_up_to', 'exile_until_nonland',
  'put_from_hand', 'destroy_up_to', 'put_from_command_zone', 'play_hideaway',
  'goad', 'territorial_attack', 'if_attacking_most_life', 'untap_all_attackers', 'extra_combat',
  'exile_and_manifest', 'vote_wild_free', 'discover', 'ignition',
  'reveal_top_cast_shared', 'exile_from_any_graveyard', 'fight_pick',
  'exile_tops_cast', 'exile_until_leaves', 'become_monarch', 'equip',
  'living_weapon', 'attach_all_equipment', 'gain_control_all', 'bounce_all', 'destroy_all_creatures_token',
  'destroy_all_mv', 'add_poison', 'exile_graveyard', 'ixhel_corrupted_exile',
  'exile_all', 'graveyard_to_library_top', 'animate', 'shuffle_self_into_library',
  'job_select', 'advance_saga', 'grant_flashback', 'hand_to_library_top',
  'exile_graveyard_until_leaves', 'choose_land_type',
] as const

const UnknownV2ActionSchema = z.object({
  type: z.string().refine(
    (t) => !(KNOWN_V2_ACTION_TYPES as readonly string[]).includes(t),
    { message: 'Known V2 action type with invalid fields — check required fields for this type' },
  ),
}).passthrough()

// Fixed (non-chosen) recipient for auto-resolving triggered-ability effects.
// 'triggering_controller' (mig 249): the event subject's controller (Vengeful
// Ancestor: "a goaded creature attacks → 1 damage to ITS controller").
const BehaviorRecipientSchema = z.enum(['controller', 'each_opponent', 'active_player', 'each_player', 'all_players', 'triggering_controller'])

// Optional controller restriction on a chosen creature target.
// "an opponent controls" -> opponent; "you control" -> you/controller/self.
const TargetControllerSchema = z.enum(['any', 'opponent', 'you', 'controller', 'self']).optional()

// A state-referencing dynamic amount (triggered/source effects only): "equal to the
// number of <kind> counters on ~" (of:"self", default) or on you (of:"you", for
// experience/energy/poison). Resolved at apply time by resolve_dynamic_amount.
const DynamicAmountSchema = z.object({
  counters: z.string(),
  of: z.enum(['self', 'source', 'this', 'you', 'your', 'controller', 'target']).optional(),
}).strict()

// A count-based dynamic amount: "X = number of creatures you control / cards in your
// graveyard / your devotion to <color>". Relative to the amount's controller.
const CountAmountSchema = z.object({
  count: z.enum(['creatures_you_control', 'lands_you_control', 'cards_in_graveyard', 'creatures_died_this_turn', 'nontoken_creatures_died_this_turn', 'artifacts_you_control', 'commanders_you_control', 'graveyard_casts_this_turn', 'greatest_mana_value_you_control', 'cards_in_hand', 'total_power_you_control', 'permanents_you_control', 'greatest_power_you_control', 'devotion', 'opponent_poison_counters', 'countered_creatures_you_control', 'opponent_hand_excess', 'lands_and_graveyard_lands', 'opponent_lands', 'max_life_lost_this_turn', 'players_lost_life_this_turn', 'num_opponents', 'opponent_artifacts_and_enchantments', 'creatures_on_battlefield', 'tokens_created_this_turn']),
  // times (mig 268, Filigree Angel / Benevolent Offering): the resolved count
  // is multiplied by this. Re-added in the mig 281 cleanup — the original
  // edit silently no-opped on a CRLF regex; the hosted upsert validator
  // caught it.
  times: z.number().int().positive().optional(),
  type_line: z.string().optional(),
  // creatures_you_control only: count creatures with effective power >= N
  // (Become the Avalanche: "for each creature you control with power 4 or
  // greater").
  min_power: z.number().int().optional(),
  // "each OTHER <type> you control" (Earthshaker Dreadmaw, mig 257).
  exclude_self: z.boolean().optional(),
  // Invert the type filter (Return of the Wildspeaker: NON-Human, mig 257).
  exclude_type: z.boolean().optional(),
  // Negate the resolved count (Olivia's Wrath: each non-Vampire gets -X/-X where
  // X = Vampires you control). apply_mass_pump_until_eot reads `negate` off the
  // power/toughness amount object and flips the sign.
  negate: z.boolean().optional(),
  color: z.enum(['W', 'U', 'B', 'R', 'G']).optional(),
}).strict()

// A pump power/toughness driven by a count, optionally negated (Liliana −2: -X/-X
// where X = Zombies you control → { count, type_line, negate: true }).
const PumpValueSchema = z.object({
  count: z.enum(['creatures_you_control', 'lands_you_control', 'cards_in_graveyard', 'creatures_died_this_turn', 'commanders_you_control', 'graveyard_casts_this_turn', 'devotion', 'artifacts_you_control', 'opponent_poison_counters', 'shared_type_attackers']),
  type_line: z.string().optional(),
  color: z.enum(['W', 'U', 'B', 'R', 'G']).optional(),
  negate: z.boolean().optional(),
}).strict()

// An effect amount: a fixed number, the literal "X" for a variable spell (chosen at
// cast time, paid as {X} generic mana, substituted server-side), or a dynamic
// counter- / count-referencing amount.
// "Damage equal to <permanent>'s power" (Eshki — its own power).
const PowerOfSchema = z.object({ power_of: z.enum(['source', 'target', 'triggering_creature']) }).strict()

// "gain life equal to that creature's TOUGHNESS" (Verdant Sun's Avatar,
// mig 256) — resolved against the trigger's event subject.
const ToughnessOfSchema = z.object({ toughness_of: z.literal('triggering_creature') }).strict()

// 'event_amount' (mig 260, Wrathful Raptors): the magnitude of the trigger's
// damage event, substituted from the stack-item payload at resolve time.
const AmountSchema = z.union([z.number(), z.literal('X'), z.literal('event_amount'), DynamicAmountSchema, CountAmountSchema, PowerOfSchema, ToughnessOfSchema])

// Which kind of counter an add_counters effect places. "plus_one_one" is the
// engine's fast +1/+1 column; everything else lives in the jsonb counter bag.
const PermanentCounterTypeSchema = z.enum(['plus_one_one', 'minus_one_one', 'charge', 'quest', 'study', 'gold', 'generic', 'lore']).optional()
// Player counters live on game_session_players. "poison" >= 10 loses the game.
const PlayerCounterTypeSchema = z.enum(['poison', 'energy', 'experience'])

const CardBehaviorActionSchema = z.union([
  z.object({
    type: z.literal('add_mana'),
    color: ManaProductionColorSchema,
    amount: z.union([z.number(), CountAmountSchema]),
    // "Spend this mana only to …" (Haven of the Spirit Dragon, Drover of the
    // Mighty, Unclaimed Territory, Relic of Legends). The produced mana lands in
    // game_players.restricted_mana and is spendable only on a matching cast/ability.
    // `$chosen` (Unclaimed Territory / Secluded Courtyard) is baked into the
    // permanent's copied_script by the choose_creature_type decision.
    restriction: z
      .object({
        spell_type_line: z.string().optional(),
        ability_source_type_line: z.string().optional(),
        commander: z.boolean().optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal('deal_damage'),
    amount: AmountSchema,
    target_ref: z.string().optional(),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
    recipient: BehaviorRecipientSchema.optional(),
    // `divided: true` (spell only) — deal `amount` divided as the caster chooses
    // among multiple target creatures/players (Forked Bolt).
    divided: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('counter'),
    target_ref: z.string().optional(),
    target_type: z.literal('spell').optional(),
    // Undermine: "…Its controller loses N life." The COUNTERED spell's controller
    // loses this much life (applied even if that spell can't be countered).
    controller_loses_life: z.number().int().nonnegative().optional(),
    // Sinister Sabotage: "…Surveil N." The counter's CASTER surveils after the
    // counter resolves (applied even if the target can't be countered).
    surveil: z.number().int().nonnegative().optional(),
    // Mana Leak (mig 392): "…unless its controller pays {3}." The countered
    // spell's controller gets a pay-or-be-countered decision; does not combine
    // with the riders above.
    unless_pays: z.string().optional(),
  }),
  z.object({
    type: z.literal('gain_life'),
    amount: AmountSchema,
    recipient: BehaviorRecipientSchema.optional(),
  }),
  z.object({
    type: z.literal('lose_life'),
    amount: AmountSchema,
    recipient: BehaviorRecipientSchema.optional(),
  }),
  z.object({
    type: z.literal('draw'),
    // Optional: the engine defaults a missing amount to 1 ("draw a card"); the
    // draw-floor DF3 regression guard relies on `{type:'draw'}` drawing exactly 1.
    amount: AmountSchema.optional(),
    recipient: BehaviorRecipientSchema.optional(),
  }),
  z.object({
    type: z.literal('mill'),
    amount: AmountSchema,
    recipient: BehaviorRecipientSchema.optional(),
    // "If at least one <type> card is milled this way, <then>." (Liliana +1.)
    if_milled_type: z.string().optional(),
    then: z.array(z.record(z.string(), z.unknown())).optional(),
  }),
  // Scry N — a resolution-time (Tier-B) decision: look at the top N of your
  // library, then reorder/bottom them. Untargeted (acts on the caster's library).
  z.object({
    type: z.literal('scry'),
    amount: z.number(),
  }),
  // Tutor — search your library for up to `count` cards (optional type/name
  // filter), put them to `to`, then shuffle. `tapped` makes a permanent enter
  // tapped (ramp/fetch); `reveal` records the found cards as decision metadata.
  z.object({
    type: z.literal('search_library'),
    count: z.number().optional(),
    to: z.enum(['hand', 'battlefield', 'top', 'graveyard']).optional(),
    tapped: z.boolean().optional(),
    reveal: z.boolean().optional(),
    // type_line_any: OR over several type words ("a Plains, Island, Swamp, or
    // Mountain card" — Farseek, mig 241).
    filter: z.object({
      type_line: z.string().optional(),
      type_line_any: z.array(z.string()).optional(),
      name: z.string().optional(),
      // "with mana value N or less" (mig 400, Trinket Mage) — the options
      // query drops costlier cards, so the cap is mechanically enforced.
      max_mana_value: z.number().int().optional(),
    }).optional(),
  }),
  // Discard `count` cards. `who` is the discarding player — 'you' (controller,
  // default) or 'opponent' (Mind Rot). `random: true` discards at random (no
  // choice); otherwise the discarding player chooses.
  z.object({
    type: z.literal('discard'),
    count: z.number().optional(),
    // each_opponent / each_player (mig 298, Syphon Mind): every (other) player
    // discards `count` cards — at random (the chooser nuance is approximated).
    who: z.enum(['you', 'opponent', 'each_opponent', 'each_player']).optional(),
    random: z.boolean().optional(),
  }),
  // Optional "you may": a yes/no gate that, if accepted, runs the inner effects.
  z.object({
    type: z.literal('may'),
    prompt: z.string().optional(),
    // Optional gate: the may is only offered when this count condition holds
    // (Liliana's Devotee: "if a creature died this turn, you may …").
    condition: z.object({
      count: z.enum(['creatures_you_control', 'lands_you_control', 'cards_in_graveyard', 'creatures_died_this_turn', 'commanders_you_control', 'graveyard_casts_this_turn', 'artifacts_you_control', 'opponent_poison_counters', 'total_power_you_control', 'permanents_you_control']),
      type_line: z.string().optional(),
      at_least: z.number().int().positive(),
    }).optional(),
    // Optional mana cost paid on confirm before the effects run ("you may pay {1}{B}").
    cost: z.string().optional(),
    // program:true (Ruthless Lawbringer, mig 339): on confirm the inner effects
    // run as a fresh triggered-ability PROGRAM (each parks its own decision) —
    // "you may sacrifice another creature. When you do, destroy target nonland
    // permanent." Pair with `condition` so the may is only offered when a
    // sacrifice is possible. Default (false) keeps the at-confirm apply path.
    program: z.boolean().optional(),
    // Inner effects kept loose to avoid a self-referential schema; the engine
    // applies them (untargeted / creature-target) at confirm time.
    effects: z.array(z.record(z.string(), z.unknown())).optional(),
  }),
  // Choose a player at resolution, then apply the inner (player-directed) effects
  // to them. filter: "opponent" or "any". Inner effects kept loose (see may).
  z.object({
    type: z.literal('choose_player'),
    filter: z.enum(['opponent', 'any']).optional(),
    effects: z.array(z.record(z.string(), z.unknown())),
  }),
  // "If <state condition>, <effects>." A count-based gate (you control / lands /
  // graveyard) that runs the inner effects when the count meets `at_least`. Inner
  // effects are the non-decision vocabulary. Kept loose like may/choose_player.
  z.object({
    type: z.literal('conditional'),
    condition: z.union([
      z.object({
        // Extended for the corrupted gates (mig 282 cleanup): the engine has
        // resolved these via resolve_count_amount since their adding migs.
        count: z.enum(['creatures_you_control', 'lands_you_control', 'cards_in_graveyard', 'creatures_died_this_turn', 'commanders_you_control', 'graveyard_casts_this_turn', 'artifacts_you_control', 'opponent_poison_counters', 'total_power_you_control', 'permanents_you_control', 'max_life_lost_this_turn', 'players_lost_life_this_turn']),
        type_line: z.string().optional(),
        at_least: z.number().int().positive(),
      }),
      // "If it was kicked" (mig 211) / counter-state conditions: the source's
      // (or your) counter bag, via resolve_dynamic_amount.
      z.object({
        counters: z.string(),
        of: z.enum(['self', 'you']),
        at_least: z.number().int().positive(),
      }),
    ]),
    effects: z.array(z.record(z.string(), z.unknown())),
  }),
  // "Choose a creature type, then …" (Distant Melody). The chosen type is injected
  // into any sub-effect's count-amount type_line (e.g. count creatures_you_control).
  // `options` replaces the curated type list with arbitrary words (Frontier
  // Siege: ["Khans","Dragons"]); the pick also bakes into copied_script via
  // the "$chosen" placeholder either way.
  z.object({
    type: z.literal('choose_creature_type'),
    prompt: z.string().optional(),
    options: z.array(z.string()).optional(),
    // who:'each_player' (Patriarch's Bidding, mig 343): every player chooses a
    // type in seat order; the inner effects run for each chooser in turn.
    who: z.enum(['you', 'each_player']).optional(),
    // Optional since mig 282: From the Rubble has no inline effects — the
    // pick only bakes the  placeholder into copied_script.
    effects: z.array(z.record(z.string(), z.unknown())).optional(),
  }),
  // Sacrifice `count` creatures: the sacrificing player (you, or the opponent for
  // an edict) chooses among permanents they control. Default filter is creatures.
  z.object({
    type: z.literal('sacrifice'),
    who: z.enum(['you', 'opponent', 'each_opponent', 'each_player']).optional(),
    count: z.number().optional(),
    filter: z.object({ type_line: z.string().optional() }).optional(),
  }),
  // Return up to `count` cards from your graveyard (default creatures) to your
  // hand (Raise Dead) or the battlefield (Reanimate). The controller chooses.
  z.object({
    type: z.literal('return_from_graveyard'),
    to: z.enum(['hand', 'battlefield']).optional(),
    count: z.number().optional(),
    // types: "artifact or enchantment" (Hanna, mig 265); exclude_self:
    // "another target artifact" on a dies-trigger (Myr Retriever, mig 265).
    filter: z.object({
      type_line: z.string().optional(),
      types: z.array(z.string()).optional(),
      exclude_self: z.boolean().optional(),
      // "permanent card with mana value N or less" (Sun Titan).
      max_mana_value: z.number().int().optional(),
      // Dynamic cap "mana value <= source's power" (Carmen, mig 341).
      max_mana_value_of: z.literal('source_power').optional(),
      // "permanent card" — exclude instants/sorceries (Carmen, mig 341).
      permanent: z.boolean().optional(),
    }).optional(),
    // Battlefield returns enter tapped (mig 218, Victimize).
    tapped: z.boolean().optional(),
    // Reanimation riders (mig 270 Beacon of Unrest / mig 346 Reanimate).
    from: z.literal('all_graveyards').optional(),
    control: z.enum(['decider']).optional(),
    haste: z.boolean().optional(),
    // "you lose life equal to its mana value" (Reanimate).
    lose_life_mana_value: z.boolean().optional(),
  }),
  // Surveil N — Tier-B: look at the top N of your library, put any number into
  // your graveyard, the rest back on top. Untargeted.
  z.object({
    type: z.literal('surveil'),
    amount: z.number(),
  }),
  z.object({
    type: z.literal('create_token'),
    token: z.string(),
    // A fixed count, {count:'sacrificed_this_way'} (creatures sacrificed by a
    // preceding edict — Syphon Flesh), or a count-based amount object resolved
    // via the amount engine (Gadrak: one Treasure per nontoken creature that
    // died this turn — zero deaths makes zero tokens, no floor-at-1).
    // 'X' (mig 300, Champions from Beyond): the {X} paid at cast, stamped on the
    // source permanent's counter bag and read by its ETB create_token.
    count: z.union([z.number(), z.literal('X'), z.object({ count: z.literal('sacrificed_this_way') }), CountAmountSchema]).optional(),
    // The tokens enter tapped (Army of the Damned: "thirteen … tokens that are tapped").
    tapped: z.boolean().optional(),
    // "Its controller creates a token" (Beast Within): the token is created under the
    // control of the spell's TARGET's controller, not the caster.
    recipient: z.literal('target_controller').optional(),
    // X/X tokens (Quartzwood Crasher, mig 260): pin the token's base P/T via
    // an unexpiring set_pt row. 'event_amount' = the trigger's damage total.
    set_pt: z.union([z.number(), z.literal('event_amount')]).optional(),
  }),
  // Impulse draw (Atsushi): exile the top `count` cards of your library and gain
  // permission to play them until the end of your next turn. count 'X' is the
  // caster-chosen X of an X spell (Zenith Festival), substituted at cast.
  z.object({
    type: z.literal('impulse'),
    count: z.union([z.number().int().positive(), z.literal('X')]),
  }),
  // Monstrosity N (Stormbreath Dragon): become monstrous once (N +1/+1 counters +
  // a marker); `on_monstrous` fires only the first time it becomes monstrous.
  z.object({
    type: z.literal('monstrosity'),
    amount: z.number().int().positive(),
    on_monstrous: z.array(z.record(z.string(), z.unknown())).optional(),
  }),
  // "Deals damage to each opponent equal to the cards in that player's hand"
  // (Stormbreath's become-monstrous rider).
  z.object({
    type: z.literal('damage_each_opponent_by_hand'),
  }),
  // "Return this permanent to its owner's hand" (Encroaching/Breaching Dragonstorm).
  z.object({
    type: z.literal('return_self_to_hand'),
  }),
  // "The owner of target permanent shuffles it into their library" (Chaos
  // Warp, mig 242). then_reveal_top_to_battlefield adds the rider: reveal the
  // owner's top card; a permanent card goes onto the battlefield.
  z.object({
    type: z.literal('shuffle_into_library'),
    target_type: z.enum(['permanent', 'creature', 'artifact', 'enchantment']).optional(),
    then_reveal_top_to_battlefield: z.boolean().optional(),
  }),
  // "You may pay any amount of {R}. When you do, it deals that much damage to
  // any target." (Leyline Tyrant dies trigger, mig 244.) Parks a decision; the
  // amount is validated against the payer's mana pool at submit time.
  z.object({
    type: z.literal('pay_x_mana_damage'),
    color: z.enum(['W', 'U', 'B', 'R', 'G']).optional(),
    target_filter: z.object({
      controller: z.enum(['any', 'opponent', 'you']).optional(),
      types: z.array(z.enum(['creature', 'planeswalker', 'player'])).optional(),
    }).strict().optional(),
  }),
  // "Exile cards from the top of your library until you exile a nonland card"
  // (Breaching Dragonstorm, mig 245). The lands stay exiled; the nonland may
  // be free-cast (approximated: a permanent card enters the battlefield
  // directly) when its mana value is within the window, else / on decline it
  // goes to your hand.
  z.object({
    type: z.literal('exile_until_nonland'),
    free_cast_max_mana_value: z.number().int().positive().optional(),
  }),
  // Discover X (Pantlaza, mig 253): exile from the top until a nonland with
  // mana value <= X; cast it free or put it into your hand; the rest bottom
  // in a random order. amount may be the triggering creature's mana value.
  z.object({
    type: z.literal('discover'),
    amount: z.union([
      z.number().int().nonnegative(),
      z.object({ mana_value_of: z.literal('triggering_creature') }).strict(),
    ]),
  }),
  // "You may put a permanent card with mana value <= that damage from your
  // hand onto the battlefield" (Broodcaller Scourge, mig 247). The cap reads
  // the trigger payload's event_amount (dragons_combat_damage).
  z.object({
    type: z.literal('put_from_hand'),
    // A number, or a stack-payload key holding the number (mig 252,
    // Selvala's Stampede: 'free_votes' tallied by the vote chain).
    count: z.union([z.number().int().positive(), z.string()]).optional(),
    filter: z.object({
      permanent: z.boolean().optional(),
      type_line: z.string().optional(),
      max_mana_value: z.union([z.number().int(), z.literal('event_amount')]).optional(),
    }).strict().optional(),
  }),
  // Council's dilemma (Selvala's Stampede, mig 252): starting with the
  // caster, each player votes wild or free; wild reveals creatures from the
  // top onto the battlefield, free counts ride the payload for a following
  // put_from_hand.
  z.object({
    type: z.literal('vote_wild_free'),
  }),
  // "You may put a commander you own from the command zone onto the
  // battlefield. It gains haste. Return it to the command zone at the
  // beginning of the next end step." (Hellkite Courser, mig 248.)
  z.object({
    type: z.literal('put_from_command_zone'),
  }),
  // Goad target creature (Vengeful Ancestor, mig 249): until the goader's
  // next turn it can't attack the goader while another opponent exists; the
  // attack-each-combat half is not forced.
  z.object({
    type: z.literal('goad'),
    target_ref: z.string().optional(),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
  }),
  // Territorial Hellkite (mig 249): pick a random opponent it didn't attack
  // during your last combat and pin this combat's defender to them; no legal
  // pick taps the source.
  z.object({
    type: z.literal('territorial_attack'),
  }),
  // Dethrone / Scourge of the Throne (mig 250): the inner untargeted effects
  // run only when the attack's defender has the most life or is tied for it;
  // once_per_turn gates via a turn stamp on the source.
  z.object({
    type: z.literal('if_attacking_most_life'),
    once_per_turn: z.boolean().optional(),
    effects: z.array(z.record(z.string(), z.unknown())),
  }),
  // "Untap all attacking creatures" (mig 250, Scourge of the Throne).
  z.object({
    type: z.literal('untap_all_attackers'),
  }),
  // "Exile target creature. Its controller manifests the top card of their
  // library." (Reality Shift, mig 251.) The manifested card is a blank 2/2;
  // turn_manifest_up flips a creature card face up for its mana cost.
  z.object({
    type: z.literal('exile_and_manifest'),
    target_ref: z.string().optional(),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
  }),
  // "Target creature you control deals damage equal to its power to each
  // other creature and each opponent." (Chandra's Ignition, mig 257.)
  z.object({
    type: z.literal('ignition'),
    target_ref: z.string().optional(),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
  }),
  // "After this phase, there is an additional combat phase" (mig 250).
  z.object({
    type: z.literal('extra_combat'),
  }),
  // "Reveal the top card of your library. If it's a creature card that shares
  // a creature type with a creature you control, you may cast it without
  // paying its mana cost; otherwise bottom it." (Descendants' Path, mig 259.
  // Approximations: the free cast is a direct battlefield entry and is not
  // optional.)
  z.object({
    type: z.literal('reveal_top_cast_shared'),
  }),
  // "You may exile target card from a graveyard. If a creature card is exiled
  // this way you gain N life; a noncreature card gives this creature +M/+M
  // until end of turn." (Deathgorge Scavenger, mig 259.)
  z.object({
    type: z.literal('exile_from_any_graveyard'),
    gain_if_creature: z.number().optional(),
    pump_if_noncreature: z.number().optional(),
  }),
  // Play the card this source hid with hideaway (Mosswort Bridge, mig 248):
  // a permanent card enters the battlefield free; the activation gate is the
  // ability's `condition` (total power 10+). to:'hand' (mig 392, Watcher for
  // Tomorrow): the hidden card goes to its owner's hand instead — any type.
  z.object({
    type: z.literal('play_hideaway'),
    to: z.literal('hand').optional(),
  }),
  // Snapcaster Mage (mig 392): pick an instant/sorcery card in your graveyard —
  // it gains flashback (cost = its mana cost) until end of turn.
  z.object({
    type: z.literal('grant_flashback'),
  }),
  // Brainstorm (mig 392): put `count` cards from your hand on top of your
  // library (the last pick ends on top).
  z.object({
    type: z.literal('hand_to_library_top'),
    count: z.number().int().positive().optional(),
  }),
  // "Destroy target <filter>" via a parked pick that may be declined
  // (Parapet Thrasher mode, mig 247).
  z.object({
    type: z.literal('destroy_up_to'),
    count: z.number().int().positive().optional(),
    target_filter: z.object({
      controller: z.enum(['any', 'opponent', 'you']).optional(),
      type_line: z.string().optional(),
      // "artifact or enchantment" (Scion of Calamity, mig 261): any match wins.
      types: z.array(z.string()).optional(),
      // "destroy target NONLAND permanent" (Ruthless Lawbringer, mig 339): exclude lands.
      nonland: z.boolean().optional(),
    }).strict().optional(),
  }),
  // The program's target ("target creature you control") fights a SECOND
  // parked pick (Savage Stomp / Wayta, mig 261).
  z.object({
    type: z.literal('fight_pick'),
    target_filter: z.object({
      controller: z.enum(['any', 'opponent', 'you']).optional(),
    }).strict().optional(),
  }),
  // Etali (mig 262): exile the top card of EACH player's library, then a
  // free-cast pick over the exiled permanents (non-chosen stay exiled).
  z.object({
    type: z.literal('exile_tops_cast'),
  }),
  // Bronzebeak Foragers (mig 262): exile the target until the trigger's
  // source leaves the battlefield (then it returns under its owner).
  z.object({
    type: z.literal('exile_until_leaves'),
    target_ref: z.string().optional(),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
    // "up to three OTHER target creatures" (mig 404, Angel of Serenity):
    // targets>1 makes it a multi-pick; optional lets the controller take fewer.
    targets: z.number().int().positive().optional(),
    optional: z.boolean().optional(),
    // Where the exiled cards go when the source leaves (mig 404). Default
    // 'battlefield' (Bronzebeak Foragers); 'hand' returns to owners' hands
    // (Angel of Serenity: "return the exiled cards to their owners' hands").
    return_to: z.enum(['battlefield', 'hand']).optional(),
  }),
  // "Exile TARGET permanent card ... from your graveyard until this leaves"
  // (mig 405, Trove Warden's landfall). Parks a graveyard pick (permanent
  // cards, max_mana_value filter); on submit the chosen card is exiled and
  // anchored to the source, so it returns to the battlefield when the source
  // dies (via the same exiled_until_leaves mechanism).
  z.object({
    type: z.literal('exile_graveyard_until_leaves'),
    filter: z.object({
      max_mana_value: z.number().int().optional(),
      type_line: z.string().optional(),
      permanent: z.boolean().optional(),
    }).optional(),
  }),
  // Living weapon (mig 267, Bonehoard / Grip of Phyresis): Germ token +
  // attach the target Equipment (or the source itself) to it.
  z.object({
    type: z.literal('living_weapon'),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
  }),
  // Hellkite Tyrant (mig 269): permanently steal every matching opposing permanent.
  z.object({
    type: z.literal('gain_control_all'),
    type_line: z.string().optional(),
  }),
  // Coastal Breach (mig 269): return each (nonland) permanent to its owner's hand.
  z.object({
    type: z.literal('bounce_all'),
    nonland: z.boolean().optional(),
  }),
  // Phyrexian Rebirth (mig 269): wipe all creatures, then an X/X token where
  // X is the number destroyed.
  z.object({
    type: z.literal('destroy_all_creatures_token'),
    token: z.string().optional(),
    // Fumigate (mig 272): gain N life per destroyed creature instead of a token.
    gain_per_destroyed: z.number().int().positive().optional(),
  }),
  // Culling Ritual (mig 272): wipe nonland MV<=N, add fixed-colour mana per kill.
  z.object({
    type: z.literal('destroy_all_mv'),
    max_mana_value: z.number().int().nonnegative().optional(),
    mana_per_destroyed: ManaColorSchema.optional(),
  }),
  // 'gets N poison counters' (Caress of Phyrexia, mig 272).
  z.object({
    type: z.literal('add_poison'),
    amount: z.number().int().positive(),
    recipient: z.enum(['each_opponent', 'controller']).optional(),
  }),
  // Bojuka Bog (mig 272): exile the opponent's graveyard.
  z.object({
    type: z.literal('exile_graveyard'),
  }),
  // Merciless Eviction (mig 275): exile all permanents of the given types.
  z.object({
    type: z.literal('exile_all'),
    types: z.array(z.string()),
  }),
  // Omen back-faces (mig 289): the source shuffles itself into its owner's library.
  z.object({
    type: z.literal('shuffle_self_into_library'),
  }),
  // Noxious Revival (mig 275): a graveyard card goes to its owner's library top.
  z.object({
    type: z.literal('graveyard_to_library_top'),
  }),
  // Land animation (mig 277, Obuun / Embodiment / Waker): target land becomes
  // an X/X creature (still a land). permanent:true skips the EOT expiry.
  z.object({
    type: z.literal('animate'),
    power: z.union([z.number(), z.literal('X'), PowerOfSchema]).optional(),
    toughness: z.union([z.number(), z.literal('X'), PowerOfSchema]).optional(),
    keywords: z.array(z.string()).optional(),
    permanent: z.boolean().optional(),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
  }),
  // Ixhel (mig 272): poisoned opponents exile their library top; you may
  // play those cards (impulse-window approximation).
  z.object({
    type: z.literal('ixhel_corrupted_exile'),
  }),
  // Armory Automaton (mig 267): attach every Equipment you control to the source.
  z.object({
    type: z.literal('attach_all_equipment'),
  }),
  // Equip {N} (mig 266): attach to target creature you control.
  z.object({
    type: z.literal('equip'),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
  }),
  // "You become the monarch" (Regal Behemoth, mig 262).
  z.object({
    type: z.literal('become_monarch'),
  }),
  // "Return up to N target … to its owner's hand" via a parked pick
  // (Hammerhead Tyrant, mig 244). max_mana_value:'triggering_spell' caps the
  // options at the TRIGGERING cast card's mana value.
  z.object({
    type: z.literal('bounce_up_to'),
    count: z.number().int().positive().optional(),
    // Karoo lands (Azorius Chancery et al.): the ETB bounce is MANDATORY ("return
    // a land you control"), not the default "up to". Forces exactly `count` picks.
    mandatory: z.boolean().optional(),
    target_filter: z.object({
      controller: z.enum(['any', 'opponent', 'you']).optional(),
      nonland: z.boolean().optional(),
      // Karoo lands (mig 263): "return a LAND you control to its owner's hand".
      type_line: z.string().optional(),
      max_mana_value: z.literal('triggering_spell').optional(),
    }).strict().optional(),
  }),
  // "Deal N damage divided as you choose among …" (Dragonlord Atarka ETB /
  // Skarrgan Hellkite). Parks a divide_damage decision; the player allocates N
  // among legal targets (creatures/planeswalkers/players per target_filter).
  z.object({
    type: z.literal('divide_damage'),
    amount: z.number().int().positive(),
    max_targets: z.number().int().positive().optional(),
    target_filter: z.object({
      controller: z.enum(['any', 'opponent', 'you']).optional(),
      types: z.array(z.enum(['creature', 'planeswalker', 'player'])).optional(),
    }).strict().optional(),
  }),
  // A modal trigger ("choose one —"): pick `choose` (default 1) of the modes;
  // each mode's untargeted `actions` resolve. Inner actions kept loose (see may).
  z.object({
    type: z.literal('choose_one'),
    prompt: z.string().optional(),
    choose: z.number().int().positive().optional(),
    // "Choose one or more" (mig 306, Sublime Epiphany): max picks = choose_up_to
    // (capped at the mode count); minimum stays `choose` (1).
    choose_up_to: z.number().int().positive().optional(),
    // "If you control a commander as you cast this spell, you may choose both"
    // (Will of the Temur): raises max_choices to every mode when the chooser
    // controls a commander.
    may_choose_both_if_commander: z.boolean().optional(),
    modes: z.array(z.object({
      label: z.string().optional(),
      actions: z.array(z.record(z.string(), z.unknown())),
    })),
  }),
  // Token copy of a permanent (mig 239). Parks a pick over battlefield
  // permanents matching target_filter (Will of the Temur), or with
  // target:'triggering_creature' copies the event subject directly (Reflections
  // of Littjara copying the cast spell). `except` overrides the copy's base
  // P/T (set_pt) and grants keywords; added TYPES are not modelled.
  z.object({
    type: z.literal('copy_permanent'),
    // 'attached' = copy the source's equipped/enchanted host (Helm of the Host).
    target: z.enum(['triggering_creature', 'attached']).optional(),
    // Number of copies to create (Orthion: "create five tokens", mig 348), or
    // 'coin_flip' (Mirror March: flip until you lose, one copy per win, mig 354).
    count: z.union([z.number().int().positive(), z.literal('coin_flip')]).optional(),
    target_filter: z.object({
      controller: z.enum(['any', 'opponent', 'you']).optional(),
      type_line: z.string().optional(),
    }).strict().optional(),
    except: z.object({
      power: z.number().int().optional(),
      toughness: z.number().int().optional(),
      keywords: z.array(z.string()).optional(),
      // "Sacrifice/exile it at the next end step" (Electroduplicate, mig 347).
      cleanup_at_end_step: z.boolean().optional(),
      // "It gains 'When this token dies, <effects>'" (Jaxis, mig 349).
      dies_effect: z.array(z.record(z.string(), z.unknown())).optional(),
      // Tapped + attacking + end-of-combat exile (Echoing Assault, mig 359):
      // attacking_defender is a player id, or '$defender' = the trigger's defender.
      tapped: z.boolean().optional(),
      attacking_defender: z.string().optional(),
      cleanup_at_end_combat: z.boolean().optional(),
    }).strict().optional(),
  }),
  // An EXISTING card becomes a copy (mig 240). target:'triggering_creature'
  // offers the event subject (Sarkhan: "you may have Sarkhan become a copy of
  // it until end of turn"); otherwise battlefield creatures matching
  // target_filter (Deceptive Frostkite enter-as-copy, min_power 4). The parked
  // pick IS the "may" (optional → declining is legal). fire_etb runs the new
  // script's ETB triggers (enter-as-copy). Reverts on leaving the battlefield,
  // and at end of turn when until_end_of_turn.
  z.object({
    type: z.literal('become_copy'),
    target: z.literal('triggering_creature').optional(),
    optional: z.boolean().optional(),
    until_end_of_turn: z.boolean().optional(),
    fire_etb: z.boolean().optional(),
    target_filter: z.object({
      controller: z.enum(['any', 'opponent', 'you']).optional(),
      type_line: z.string().optional(),
      min_power: z.number().int().optional(),
    }).strict().optional(),
    except: z.object({
      power: z.number().int().optional(),
      toughness: z.number().int().optional(),
      keywords: z.array(z.string()).optional(),
    }).strict().optional(),
  }),
  z.object({
    // A negative amount (or all=true) REMOVES counters; counter_type defaults +1/+1.
    type: z.literal('add_counters'),
    amount: AmountSchema,
    target_ref: z.string().optional(),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
    counter_type: PermanentCounterTypeSchema,
    all: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('add_counters_all'),
    amount: z.number(),
    target_controller: TargetControllerSchema,
    counter_type: PermanentCounterTypeSchema,
    all: z.boolean().optional(),
    // "each OTHER creature you control" (Bellowing Aegisaur, mig 256).
    exclude_source: z.boolean().optional(),
    // Optional type-line filter (mig 299, Ardbert: "each LEGENDARY creature").
    type_line: z.string().optional(),
  }),
  z.object({
    // Put player counters (poison/energy/experience) on players. Default recipient
    // each_opponent (poison/infect lands on opponents). Negative amount / all removes.
    type: z.literal('add_player_counters'),
    amount: AmountSchema,
    counter_type: PlayerCounterTypeSchema,
    recipient: BehaviorRecipientSchema.optional(),
    all: z.boolean().optional(),
  }),
  z.object({
    type: z.enum(['tap_all', 'untap_all']),
    target_controller: TargetControllerSchema,
    // Widens the default creature scope by type line (Zacama, mig 258:
    // "untap all LANDS you control").
    card_type: z.string().optional(),
  }),
  z.object({
    type: z.literal('pump'),
    // A fixed delta, a dynamic { count, …, negate? } value (Liliana −2: -X/-X),
    // the literal 'X' for an {X}-cost activated ability (Kessig Wolf Run —
    // substituted server-side at activation), or { power_of: 'target' }
    // (Xenagos, mig 259: "+X/+X where X is that creature's power").
    power: z.union([z.number(), z.literal('X'), PumpValueSchema, PowerOfSchema]).optional(),
    toughness: z.union([z.number(), z.literal('X'), PumpValueSchema, PowerOfSchema]).optional(),
    target_ref: z.string().optional(),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
    // Reflexive watcher (Shared Animosity, mig 340): pump the EVENT SUBJECT (the
    // attacking creature), no target pick.
    target: z.literal('triggering_creature').optional(),
  }),
  // Mass, until-end-of-turn P/T pump applied to every creature matching the filter
  // (Crippling Fear). scope 'all' (default) = any controller; 'controller' = yours.
  // creature_type + exclude_type:true = "creatures that AREN'T of the chosen type".
  // Pairs with choose_creature_type, which injects the chosen type into creature_type.
  z.object({
    type: z.literal('pump_all'),
    // A fixed delta, or a count-based amount (Become the Avalanche: +X/+X
    // where X = cards in your hand) resolved at apply time.
    power: z.union([z.number(), CountAmountSchema]),
    toughness: z.union([z.number(), CountAmountSchema]),
    // 'opponent' (mig 395, Phyresis Outbreak): only creatures your opponents
    // control — applied as one pump row per opponent.
    scope: z.enum(['all', 'controller', 'opponent']).optional(),
    creature_type: z.string().optional(),
    exclude_type: z.boolean().optional(),
  }),
  // Amass N — create-or-grow a 0/0 Zombie Army with N +1/+1 counters.
  z.object({
    type: z.literal('amass'),
    amount: z.number(),
  }),
  // Mass damage (mig 224) — N to every creature (and optionally planeswalkers)
  // matching the filter (Blasphemous Act, Storm's Wrath, Harbinger of the Hunt).
  z.object({
    type: z.literal('deal_damage_all'),
    // Fixed N, or a live count (mig 390, Chain Reaction: "X damage to each
    // creature, where X is the number of creatures") — the runtime already
    // resolves the amount through resolve_dynamic_amount.
    amount: z.union([z.number().int().positive(), CountAmountSchema]),
    targets: z.enum(['creatures', 'creatures_planeswalkers']).optional(),
    // "…Tap those creatures." (mig 395, Thundermaw Hellkite): every creature
    // the sweep damaged is also tapped.
    tap_damaged: z.boolean().optional(),
    filter: z.object({
      with_keyword: z.literal('flying').optional(),
      without_keyword: z.literal('flying').optional(),
      exclude_source: z.boolean().optional(),
      // 'opponent' / 'you' relative to the effect's controller (mig 395,
      // Thundermaw: "each creature with flying your opponents control").
      controller: z.enum(['you', 'opponent']).optional(),
    }).optional(),
  }),
  // Ureni (mig 223) — "Look at the top N cards of your library, you may put a
  // matching card onto the battlefield, the rest go to the bottom in a random
  // order." JSON/AI-authored (not in the guided form).
  z.object({
    type: z.literal('look_top'),
    count: z.number().int().positive(),
    // to:'exile' (mig 248, hideaway): the pick is exiled and remembered on
    // the source for a later play_hideaway; min_picks 1 makes it mandatory.
    to: z.enum(['battlefield', 'hand', 'exile']).optional(),
    min_picks: z.number().int().nonnegative().optional(),
    // How many to take (mig 302, Dig Through Time: "put TWO into your hand").
    // Defaults to 1.
    picks: z.number().int().positive().optional(),
    filter: z.object({
      type_line: z.string().optional(),
      creature: z.boolean().optional(),
    }).optional(),
  }),
  // Gravespawn Sovereign (mig 212) — activated-ability-only targeted effect:
  // put target creature card from ANY graveyard onto the battlefield under
  // your control. The target is chosen at activation.
  z.object({
    type: z.literal('reanimate_from_graveyard'),
    target_type: z.literal('graveyard_creature').optional(),
  }),
  // Heraldic Banner (mig 209) — "As this enters, choose a color"; the chosen
  // colour is baked into a colour-filtered anthem registered on resolution.
  z.object({
    type: z.literal('choose_color'),
    anthem: z.object({
      power: z.number(),
      toughness: z.number(),
      scope: z.enum(['all', 'controller']).optional(),
    }).optional(),
  }),
  // Necromantic Selection (mig 208) — destroy all creatures, then the caster
  // returns ONE creature destroyed this way to the battlefield under THEIR
  // control. (Type/colour addition + self-exile are not modelled.)
  z.object({
    type: z.literal('mass_destroy_reanimate_one'),
  }),
  // Mass keyword grant until end of turn (mig 202) — "All Zombies gain menace
  // until end of turn" (Lord of the Accursed), "you and permanents you control
  // gain hexproof" (Lazotep Plating: scope controller + includes_player).
  z.object({
    type: z.literal('grant_keyword_all'),
    keyword: z.enum([
      'flying', 'reach', 'deathtouch', 'trample', 'vigilance', 'haste',
      'indestructible', 'first_strike', 'double_strike', 'menace',
      'intimidate', 'hexproof', 'lifelink',
    ]),
    scope: z.enum(['all', 'controller']).optional(),
    creature_type: z.string().optional(),
    includes_player: z.boolean().optional(),
  }),
  // Mass destroy (board wipe) — all matching battlefield creatures, optional type.
  z.object({
    type: z.literal('destroy_all'),
    scope: z.enum(['all', 'you', 'opponent']).optional(),
    creature_type: z.string().optional(),
    // "Destroy all NON-<type> creatures" (Wakening Sun's Avatar, mig 256).
    exclude_type: z.string().optional(),
    // Any-type match ("destroy all artifacts, creatures, and enchantments" —
    // Nevinyrral's Disk, mig 268). Schema catch-up in mig 395: the SQL honored
    // this all along; since 395 the types branch also honors `scope`
    // (Ruinous Ultimatum: opponents' nonland permanents only).
    types: z.array(z.string()).optional(),
    // "Destroy all creatures with power N or greater" (Fell the Mighty,
    // mig 281) — fixed threshold; schema catch-up, SQL honored it already.
    min_power: z.number().int().optional(),
  }),
  // Mass reanimate — return ALL matching creature cards from your graveyard.
  z.object({
    type: z.literal('return_all_from_graveyard'),
    to: z.enum(['battlefield', 'hand']).optional(),
    creature_type: z.string().optional(),
    // 'all_graveyards' (mig 214, Grimoire of the Dead): sweep EVERY graveyard;
    // the cards enter under YOUR control. Omit for your own graveyard only.
    from: z.literal('all_graveyards').optional(),
  }),
  // "Exile target card from a graveyard" as a targeted EFFECT (Withered Wretch).
  // The graveyard card is the ability's target (passed at activation); distinct
  // from the exile_from_graveyard COST, which consumes a card to pay for an ability.
  z.object({
    type: z.literal('exile_from_graveyard'),
    target_ref: z.string().optional(),
  }),
  // Targeted creature effects cast as a spell (destroy/exile/bounce/tap/untap).
  // `targets` > 1 makes it a multi-target spell ("destroy up to N target
  // creatures") — the full effect is applied to each chosen creature.
  z.object({
    type: z.enum(['destroy', 'exile', 'bounce', 'tap', 'untap']),
    target_ref: z.string().optional(),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
    targets: z.number().optional(),
    // tap only (mig 403, Frost Titan): "…it doesn't untap during its
    // controller's next untap step" — adds a 'stun' bag counter consumed by
    // advance_step's untap.
    stun: z.boolean().optional(),
    // Optional self-rider ("…and you lose 3 life"): applied to the caster on
    // resolution. Single-target only (not with `targets` > 1).
    then: ThenRiderSchema,
    // Assassin's Trophy: the destroyed permanent's controller may search their
    // library for a basic land, put it onto the battlefield, then shuffle.
    controller_searches_basic_land: z.boolean().optional(),
    // NEGATIVE type restriction (mig 220, Cruel Revival "Destroy target
    // NON-Zombie creature"): the target may not match this type line. mig 412
    // also accepts an ARRAY of types (Victim of Night: "that isn't a Vampire,
    // Werewolf, or Zombie") — the target may match none of them.
    exclude_type_line: z.union([z.string(), z.array(z.string())]).optional(),
    // Caster graveyard-return rider (mig 220, Cruel Revival "Return up to one
    // target Zombie card from your graveyard to your hand"): parks a pick for
    // the caster after the removal resolves.
    then_return_from_graveyard: z.object({
      filter: z.object({ type_line: z.string().optional() }).optional(),
      to: z.enum(['hand', 'battlefield']).optional(),
      count: z.number().int().positive().optional(),
      tapped: z.boolean().optional(),
    }).optional(),
  }),
  // Grant a keyword to a target creature until end of turn (trigger-only today).
  // "Tap it" — tap the SOURCE permanent (Immersturm Predator's sacrifice
  // ability). Untargeted; fires the becomes_tapped event like any other tap.
  z.object({ type: z.literal('tap_self') }),
  z.object({
    type: z.literal('grant_keyword'),
    keyword: z.enum([
      'flying', 'reach', 'trample', 'vigilance', 'haste',
      'first_strike', 'double_strike', 'deathtouch', 'indestructible',
      // hexproof (Rattlechains) + menace: the engine's grant path and CHECK
      // list supported both; the enum lagged (mig 281 cleanup).
      // lifelink: first-class since mig 283.
      'hexproof', 'menace', 'lifelink',
      // "can't be blocked this turn" (mig 397, Rogue's Passage) — enforced by
      // declare_blocker via card_has_unblockable.
      'unblockable',
    ]),
    target_ref: z.string().optional(),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
    // Reflexive watcher (mig 227): 'triggering_creature' applies the grant to
    // the entering/attacking creature that fired the watcher (Atarka, Dragon
    // Tempest), no target pick.
    target: z.literal('triggering_creature').optional(),
  }),
  // Saw in Half (mig 356): destroy a target creature; on its death its controller
  // makes two half-P/T copies. target_type creature.
  z.object({
    type: z.literal('saw_in_half'),
    target_ref: z.string().optional(),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
  }),
  // Blink/flicker a target creature: exile it and return it to the battlefield
  // under your control, re-firing its ETB (Conjurer's Closet, mig 351). optional
  // = "you may"; a token cannot return.
  z.object({
    type: z.literal('blink'),
    target_ref: z.string().optional(),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
    optional: z.boolean().optional(),
  }),
  // Delina, Wild Mage (mig 360): roll a d20, make tapped attacking copies of the
  // target creature you control (with roll-again on 15-20). target_type creature.
  z.object({
    type: z.literal('delina_d20'),
    target_ref: z.string().optional(),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
  }),
  // Myriad (The Master / Dalek Squadron, mig 355): on attack, a tapped attacking
  // token copy of the source for each opponent other than the defender; exiled at
  // end of combat. No fields.
  z.object({ type: z.literal('myriad') }),
  // Donate self (Xantcha, mig 361): the source enters under an opponent's control.
  z.object({ type: z.literal('donate_self') }),
  // Grant a target creature a "when this dies, <effects>" ability (Clavileño,
  // mig 344): stored as a granted_dies_effect continuous effect on the creature;
  // put_in_graveyard fires `effects` on its death. effects kept loose (see may).
  z.object({
    type: z.literal('grant_dies_effect'),
    target: z.literal('triggering_creature').optional(),
    target_ref: z.string().optional(),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
    effects: z.array(z.record(z.string(), z.unknown())).optional(),
  }),
  // Fight: a creature you control fights a target creature. target_type/
  // target_controller describe the FOUGHT creature (the fighter is implicitly
  // one you control). Each deals damage equal to its power to the other.
  z.object({
    type: z.literal('fight'),
    // fighter:'triggering_creature' — the EVENT SUBJECT fights the picked
    // target instead of the watcher itself (Frontier Siege Dragons mode).
    fighter: z.literal('triggering_creature').optional(),
    target_ref: z.string().optional(),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
  }),
  // Gain control of a target creature. duration: permanent (default) or until end
  // of turn. target_type/target_controller describe the creature ("opponent" for
  // "you don't control"). Trigger-only today.
  z.object({
    type: z.literal('gain_control'),
    // 'while_source' (mig 246, Opportunistic Dragon): control lasts as long
    // as the SOURCE permanent stays on the battlefield; lose_abilities blanks
    // the stolen permanent's script and blocks attacking (block restriction
    // not modelled).
    duration: z.enum(['permanent', 'end_of_turn', 'while_source']).optional(),
    // Donate: hand the permanent to an opponent instead of the caster
    // (Harmless Offering, mig 353).
    to: z.enum(['opponent']).optional(),
    lose_abilities: z.boolean().optional(),
    // Threaten extras: untap the creature and give it haste (so it can attack the
    // turn you take it). JSON/AI-authored; the guided form models duration only.
    untap: z.boolean().optional(),
    haste: z.boolean().optional(),
    target_ref: z.string().optional(),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
  }),
  // Set a target creature's BASE power/toughness until end of turn ("becomes a
  // 0/1", Turn to Frog). Counters and pumps then layer on top (CR 613 7b).
  z.object({
    type: z.literal('set_pt'),
    power: z.number(),
    toughness: z.number(),
    target_ref: z.string().optional(),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
  }),
  // Prevent the next `amount` damage that would be dealt to YOU this turn (amount
  // omitted = prevent all). `combat_only` restricts it to combat damage (Fog-like).
  // A replacement effect: it consumes damage before it reaches your life.
  z.object({
    type: z.literal('prevent_damage'),
    amount: AmountSchema.optional(),
    combat_only: z.boolean().optional(),
  }),
  z.object({
    // Proliferate — choose any number of permanents with a +1/+1 counter; each
    // gets another. No fields (the choice happens at resolution).
    type: z.literal('proliferate'),
  }),
  // Grant the controller permission to cast cards from their graveyard this turn
  // (Liliana, Untouched by Death's −3). `type_line` filters which cards qualify
  // (a subtype substring, e.g. "Zombie"); omit/empty means any card.
  z.object({
    type: z.literal('grant_cast_from_graveyard'),
    type_line: z.string().optional(),
  }),
  // "Enchant player" curse: registers an attack-trigger on the recipient player
  // (the chosen enchanted player) — Curse of Disturbance. JSON/AI-authored.
  z.object({ type: z.literal('curse_attack_zombie') }),
  // Job select (mig 297): create a 1/1 Hero token and attach this Equipment to it.
  z.object({ type: z.literal('job_select') }),
  // Saga (mig 305): add a lore counter, fire the matching chapter from
  // `saga_chapters`, sacrifice after the final chapter. Driven by the saga's
  // enters_the_battlefield + draw_step triggers.
  z.object({ type: z.literal('advance_saga') }),
  // "As this enters, choose a basic land type; this land is the chosen type"
  // (mig 407, Multiversal Passage). Parks a five-type pick; submit registers a
  // granted_type + bakes the matching {T}: add <color> mana ability.
  z.object({ type: z.literal('choose_land_type') }),
  UnknownV2ActionSchema,
])

const CardBehaviorTargetSchema = z.object({
  id: z.string(),
  type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]),
  controller: z.enum(['any', 'controller', 'opponent']).optional(),
  required_zone: BehaviorZoneSchema.optional(),
  optional: z.boolean().optional(),
})

// A modal spell ("choose one —"): the caster picks `choose` of the `modes` at
// cast; each mode's actions resolve. Use modes XOR actions on a spell_effect.
const CardBehaviorModeSchema = z.object({
  label: z.string().optional(),
  actions: z.array(CardBehaviorActionSchema),
})

const CardBehaviorSpellEffectSchema = z.object({
  targets: z.array(CardBehaviorTargetSchema).optional(),
  actions: z.array(CardBehaviorActionSchema).optional(),
  modes: z.array(CardBehaviorModeSchema).optional(),
  choose: z.number().int().positive().optional(),
})

const CardBehaviorActivatedAbilitySchema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  costs: z.array(CardBehaviorCostSchema),
  effects: z.array(CardBehaviorActionSchema),
  is_mana_ability: z.boolean().optional(),
  timing: z.string().optional(),
  source_zone_required: BehaviorZoneSchema.optional(),
  // "Activate only if …" gate (Skarrgan Hellkite: a +1/+1 counter on this;
  // Mosswort Bridge: total power 10 or greater — the count form, mig 248).
  condition: z.union([
    z.object({
      counters: z.string(),
      of: z.enum(['self', 'source', 'this', 'you', 'your', 'controller']).optional(),
      at_least: z.number().int().positive(),
    }).strict(),
    z.object({
      // tokens_created_this_turn (mig 399, Idol of Oblivion: "Activate only if
      // you created a token this turn") — turn-stamped by fire_token_created.
      count: z.enum(['creatures_you_control', 'lands_you_control', 'artifacts_you_control', 'commanders_you_control', 'total_power_you_control', 'permanents_you_control', 'tokens_created_this_turn']),
      type_line: z.string().optional(),
      at_least: z.number().int().positive(),
    }).strict(),
  ]).optional(),
})

const CardBehaviorTriggeredAbilitySchema = z.object({
  id: z.string().optional(),
  event: z.string(),
  source_zone_required: BehaviorZoneSchema.optional(),
  condition: z.record(z.string(), z.unknown()).optional(),
  // Mode gate (mig 245, Frontier Siege "choose Khans or Dragons"): the ability
  // is live only when chosen equals mode. Author chosen as the literal
  // "$chosen"; the ETB choose_creature_type pick bakes the picked word into
  // copied_script, turning exactly one mode's abilities on.
  mode: z.string().optional(),
  chosen: z.string().optional(),
  // "This ability triggers only once each turn" (mig 253, Pantlaza) —
  // watcher events only; stamped on the card's counter bag at fire time.
  once_per_turn: z.boolean().optional(),
  // For the other-scoped events creature_entered / creature_died: which entering/dying
  // creature this watcher fires on. type_line = a subtype match (e.g. "Zombie");
  // controller is relative to this card's controller; exclude_self:true = "another …".
  filter: z.object({
    type_line: z.string().optional(),
    // Negative type match (mig 292): skip the event when the subject's type
    // line matches — "whenever you cast a NONCREATURE spell" = spell_cast +
    // exclude_type 'Creature'. Complements type_line (which only INCLUDES).
    exclude_type: z.string().optional(),
    // Minimum mana value (mig 293): skip when the subject's mana value is below
    // N. For spell_cast reads the cast spell's MV — "a noncreature spell with
    // mana value 3 or greater" (Y'shtola) = exclude_type 'Creature' + min_mana_value 3.
    min_mana_value: z.number().int().optional(),
    // Spell colour (mig 299): "whenever you cast a WHITE/BLACK spell" (Ardbert) —
    // the cast spell's mana cost must contain this colour symbol.
    spell_color: z.enum(['W', 'U', 'B', 'R', 'G']).optional(),
    controller: z.enum(['you', 'opponent', 'any']).optional(),
    exclude_self: z.boolean().optional(),
    // "a NONTOKEN creature …" (Midnight Reaper, Open the Graves) — the watcher
    // ignores token creatures entering/dying.
    nontoken: z.boolean().optional(),
    // Positive twin (mig 399, Mirkwood Bats: "whenever you ... sacrifice a
    // TOKEN"). fire_watcher_triggers already honored it; schema catch-up.
    token: z.boolean().optional(),
    // "a creature with power N or greater …" (mig 225 — Elemental Bond, Temur
    // Ascendancy). Fires only when the entering creature's power is >= N.
    min_power: z.number().int().optional(),
    // "a creature with power N or less …" (Welcoming Vampire, Mentor of the
    // Meek). fire_watcher_triggers (mig 280) already honors this; the schema just
    // needs to stop stripping it.
    max_power: z.number().int().optional(),
    // "a creature you control WITH FLYING …" (mig 227 — Dragon Tempest).
    has_keyword: z.literal('flying').optional(),
    // "whenever a GOADED creature attacks" (mig 249 — Vengeful Ancestor).
    goaded: z.boolean().optional(),
    // "whenever you attack with N or more creatures" (mig 301 — Champions from
    // Beyond). Counts the attacking player's declared attackers this combat;
    // pair with once_per_turn so it fires a single time once the threshold is met.
    attackers_at_least: z.number().int().positive().optional(),
    // "whenever you cast your SECOND spell each turn" (mig 372 — Alphinaud's
    // Eukrasia). Fires only when the cast spell is exactly the Nth the watcher's
    // controller has cast this turn; pairs with the spells_cast_this_turn counter
    // (mig 369, note_spell_cast).
    spell_number: z.number().int().positive().optional(),
    // "whenever you draw your SECOND/THIRD card each turn" (mig 401 — Ethereal
    // Investigator, Astrologian's Planisphere) on the card_drawn event; the
    // draw sites stamp the per-turn index via note_card_drawn.
    draw_number: z.number().int().positive().optional(),
    // "if it isn't that player's turn" (mig 401 — Tataru Taru): the event's
    // subject player must not be the active player.
    off_turn: z.boolean().optional(),
  }).optional(),
  targets: z.array(CardBehaviorTargetSchema).optional(),
  effects: z.array(CardBehaviorActionSchema),
})

export const CardBehaviorScriptV2Schema = z.object({
  schema_version: z.literal(2),
  keywords: z.array(z.string()).optional(),
  // "This spell can't be countered." A static property read at counter-resolution
  // time: an uncounterable spell's counter resolves but fails to cancel it.
  cant_be_countered: z.boolean().optional(),
  // "<This> can't attack unless <count> is at least N" (Gadrak: four or more
  // artifacts). Enforced in declare_attacker against the attacking player.
  cant_attack_unless: z.object({
    count: z.enum(['creatures_you_control', 'lands_you_control', 'artifacts_you_control', 'permanents_you_control']),
    at_least: z.number().int().positive(),
  }).strict().optional(),
  // "This spell costs {N} less to cast" (Draconic Lore), optionally only when a
  // count condition holds. Reduces generic mana at cast (reduced_mana_cost).
  cost_reduction: z.object({
    amount: z.number().int().positive(),
    if: z.object({
      count: z.enum(['creatures_you_control', 'lands_you_control', 'artifacts_you_control']),
      type_line: z.string().optional(),
      at_least: z.number().int().positive(),
    }).strict().optional(),
  }).strict().optional(),
  // "You may exert this creature as it attacks. When you do, <effects>." Applied
  // by declare_attacker when the player exerts (Glorybringer).
  exert: z.array(CardBehaviorActionSchema).optional(),
  // "If an effect would put counters on a permanent you control, it puts twice that
  // many instead" (Doubling Season). A static replacement read at counter-placement.
  doubles_counters: z.boolean().optional(),
  // "Enters the battlefield with N counters on it" — a REPLACEMENT, applied as the
  // card enters (before SBA), so a 0/0 that enters with +1/+1 counters survives.
  // counter_type defaults +1/+1. The amount may also be a dynamic count spec or
  // an ARRAY of specs summed (mig 210 — Unbreathing Horde: a counter "for each
  // other Zombie you control and each Zombie card in your graveyard").
  enters_with_counters: z.object({
    amount: z.union([
      z.number().int().positive(),
      CountAmountSchema,
      // {counters:'x', of:'self'} (Shivan Devastator): "enters with X +1/+1
      // counters" — reads the counters.x stamped at cast (mig 300). Schema-only
      // unlock: the runtime already resolves object amounts dynamically.
      DynamicAmountSchema,
      z.array(CountAmountSchema).nonempty(),
    ]),
    counter_type: PermanentCounterTypeSchema,
  }).optional(),
  // "If this creature would be dealt damage, prevent that damage and remove a
  // +1/+1 counter from it" (Unbreathing Horde, mig 210). The whole damage event
  // is prevented; ONE counter is removed per event.
  damage_removes_counters: z.boolean().optional(),
  // "Whenever you tap a land for mana while you're the monarch, add an
  // additional one mana of any color" (Regal Behemoth, mig 262). The bonus is
  // one mana of the colour just produced (approximation).
  monarch_land_bonus: z.boolean().optional(),
  // Alternative graveyard cast cost (mig 213, Scourge of Nel Toth): "You may
  // cast this from your graveyard by paying <mana> and sacrificing N creatures
  // rather than paying its mana cost." Self-granted — no permission needed.
  graveyard_cast_cost: z.object({
    mana: z.string().optional(),
    sacrifice_creatures: z.number().int().nonnegative().optional(),
  }).optional(),
  // Cycling cost (mig 228) — "Cycling {2}: Discard this card, draw a card."
  cycling: z.string().optional(),
  // Optional kicker cost (mig 211) — "Kicker {5}{B}": an additional mana cost
  // the caster may pay; paying it stamps 'kicked' on the permanent, read by a
  // conditional with { "counters": "kicked", "of": "self" }.
  kicker: z.string().optional(),
  // "When this creature dies, if it had no +1/+1 counters on it, return it
  // with a +1/+1 counter" (mig 219, undying).
  undying: z.boolean().optional(),
  // Characteristic-defining P/T (layer 7a, mig 149) — */* cards.
  cda: CdaSchema.optional(),
  // "This land enters tapped" (mig 217) — true, or conditional:
  // { unless: { count, type_line?, at_least } } (Sunken Hollow) /
  // { unless: { hand_has_type: ['Island','Swamp'] } } (Choked Estuary).
  enters_tapped: z.union([
    z.literal(true),
    z.object({
      unless: z.union([
        z.object({
          count: z.enum(['creatures_you_control', 'lands_you_control', 'basic_lands_you_control', 'cards_in_graveyard']),
          type_line: z.string().optional(),
          at_least: z.number().int().positive(),
        }),
        z.object({ hand_has_type: z.array(z.string()).nonempty() }),
        // Checklands (mig 225): untapped if you control a battlefield permanent
        // of a listed type ("a Forest or an Island").
        z.object({ control_type: z.array(z.string()).nonempty() }),
        // Shock lands (mig 327): untapped if you choose to pay N life — a
        // pay_life_untap decision raised on entry (Overgrown Tomb, …).
        z.object({ pay_life: z.number().int().positive() }),
      ]),
    }),
  ]).optional(),
  // Planeswalker starting loyalty (a loyalty counter set as it enters).
  loyalty: z.number().int().positive().optional(),
  // Planeswalker loyalty abilities — +N / −N / 0; cost is paid by adjusting loyalty,
  // sorcery-speed, once per turn. effects use the triggered-ability vocabulary.
  loyalty_abilities: z.array(z.object({
    cost: z.number().int(),
    label: z.string().optional(),
    effects: z.array(CardBehaviorActionSchema),
  })).optional(),
  spell_effect: CardBehaviorSpellEffectSchema.optional(),
  // Adventure (mig 295): the card's other half — an instant/sorcery you may cast
  // from hand (Swift End, Mesmeric Glare). Cast via cast_spell_effect with
  // p_adventure=true; on resolution the card is exiled with a non-expiring
  // play_from_exile permission, so the creature face (spell_effect/this card's
  // permanent) can be cast from exile later. `name`/`cost` are for client display.
  adventure: z.object({
    name: z.string().optional(),
    cost: z.string().optional(),
    spell_effect: CardBehaviorSpellEffectSchema,
  }).optional(),
  // Saga chapters (mig 305): each entry's untargeted `effects` resolve when the
  // saga's lore counter reaches a number in `chapter`. Driven by an advance_saga
  // effect on the saga's enters_the_battlefield + draw_step triggers; it
  // sacrifices the saga after the highest chapter. (Summon: Good King Mog XII.)
  saga_chapters: z.array(z.object({
    chapter: z.array(z.number().int().positive()).nonempty(),
    effects: z.array(z.record(z.string(), z.unknown())),
  })).optional(),
  // Flashback: a mana cost the card can be cast for from the GRAVEYARD, after which
  // it is exiled (Army of the Damned: "Flashback {7}{B}{B}{B}"). Read server-side by
  // cast_spell_effect when the source is in the graveyard.
  flashback: z.string().optional(),
  // An additional "Pay N life" flashback cost (Deep Analysis: "Flashback—{1}{U},
  // Pay 3 life"). Paid alongside `flashback` only on a graveyard (flashback) cast.
  flashback_life: z.number().int().positive().optional(),
  // An alternate spell program REPLACING `spell_effect` when cast via flashback —
  // for cards that do more/different from the graveyard ("Increasing …" cycle:
  // create ten tokens instead of five, mill twice X, etc.). Same shape as
  // spell_effect; the engine selects it by cast zone.
  flashback_effect: CardBehaviorSpellEffectSchema.optional(),
  activated_abilities: z.array(CardBehaviorActivatedAbilitySchema).optional(),
  triggered_abilities: z.array(CardBehaviorTriggeredAbilitySchema).optional(),
  continuous_effects: z.array(CardContinuousEffectSchema).optional(),
  // Equipment: the mana cost of its equip ability (e.g. "{1}").
  equip_cost: z.string().optional(),
}).strict()

// ─── Version detection (mirrors getCardBehaviorVersion in card-behavior.ts) ──

function isV2Script(script: unknown): boolean {
  if (typeof script !== 'object' || script === null) return false
  const s = script as Record<string, unknown>
  return (
    s['schema_version'] === 2 ||
    'spell_effect' in s ||
    'activated_abilities' in s ||
    'triggered_abilities' in s
  )
}

// ─── Public API ──────────────────────────────────────────────────────────────

export type CardScriptValidationResult =
  | { success: true; version: 1 | 2 }
  | { success: false; version: 1 | 2; errors: string[] }

export function validateCardScript(script: unknown): CardScriptValidationResult {
  const version: 1 | 2 = isV2Script(script) ? 2 : 1
  const schema = version === 2 ? CardBehaviorScriptV2Schema : CardScriptV1Schema
  const result = schema.safeParse(script)

  if (result.success) {
    return { success: true, version }
  }

  const errors = result.error.issues.map((e) => {
    const path = e.path.length > 0 ? e.path.join('.') + ': ' : ''
    return `${path}${e.message}`
  })

  return { success: false, version, errors }
}
