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
export const CardScriptV1Schema = z.object({
  actions: z.array(CardActionSchema).optional(),
  continuous_effects: z.array(CardContinuousEffectSchema).optional(),
  triggers: z.array(z.string()).optional(),
  // Equipment: the mana cost of its equip ability (e.g. "{1}").
  equip_cost: z.string().optional(),
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
      amount: z.number().int().nonnegative(),
    }),
  )
  .optional()

const KNOWN_V2_COST_TYPES = [
  'tap_self', 'untap_self', 'mana', 'pay_life',
  'sacrifice_self', 'discard', 'exile_self', 'energy',
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
  // creature you control is passed at activation.
  z.object({ type: z.literal('sacrifice_creature') }),
  z.object({ type: z.literal('discard'), amount: z.number() }),
  z.object({ type: z.literal('exile_self'), from_zone: BehaviorZoneSchema.optional() }),
  // "Exile a creature card from a graveyard" (Cemetery Reaper). type_line filters
  // the exiled card (default "creature"); the chosen card is passed at activation.
  z.object({ type: z.literal('exile_from_graveyard'), type_line: z.string().optional() }),
  z.object({ type: z.literal('energy'), amount: z.number() }),
  UnknownCostSchema,
])

const KNOWN_V2_ACTION_TYPES = [
  'add_mana', 'deal_damage', 'counter', 'gain_life', 'lose_life', 'draw',
  'create_token', 'add_counters', 'destroy', 'exile', 'bounce', 'tap', 'untap',
  'pump', 'pump_all', 'mill', 'scry', 'surveil', 'search_library', 'discard', 'may', 'choose_player', 'choose_creature_type',
  'add_counters_all', 'tap_all', 'untap_all', 'grant_keyword', 'fight', 'gain_control',
  'sacrifice', 'return_from_graveyard', 'prevent_damage', 'set_pt',
  'add_player_counters', 'proliferate', 'grant_cast_from_graveyard', 'amass',
  'destroy_all', 'return_all_from_graveyard', 'exile_from_graveyard',
] as const

const UnknownV2ActionSchema = z.object({
  type: z.string().refine(
    (t) => !(KNOWN_V2_ACTION_TYPES as readonly string[]).includes(t),
    { message: 'Known V2 action type with invalid fields — check required fields for this type' },
  ),
}).passthrough()

// Fixed (non-chosen) recipient for auto-resolving triggered-ability effects.
const BehaviorRecipientSchema = z.enum(['controller', 'each_opponent', 'active_player', 'each_player', 'all_players'])

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
  count: z.enum(['creatures_you_control', 'lands_you_control', 'cards_in_graveyard', 'devotion']),
  type_line: z.string().optional(),
  color: z.enum(['W', 'U', 'B', 'R', 'G']).optional(),
}).strict()

// A pump power/toughness driven by a count, optionally negated (Liliana −2: -X/-X
// where X = Zombies you control → { count, type_line, negate: true }).
const PumpValueSchema = z.object({
  count: z.enum(['creatures_you_control', 'lands_you_control', 'cards_in_graveyard', 'devotion']),
  type_line: z.string().optional(),
  color: z.enum(['W', 'U', 'B', 'R', 'G']).optional(),
  negate: z.boolean().optional(),
}).strict()

// An effect amount: a fixed number, the literal "X" for a variable spell (chosen at
// cast time, paid as {X} generic mana, substituted server-side), or a dynamic
// counter- / count-referencing amount.
const AmountSchema = z.union([z.number(), z.literal('X'), DynamicAmountSchema, CountAmountSchema])

// Which kind of counter an add_counters effect places. "plus_one_one" is the
// engine's fast +1/+1 column; everything else lives in the jsonb counter bag.
const PermanentCounterTypeSchema = z.enum(['plus_one_one', 'minus_one_one', 'charge', 'quest', 'generic']).optional()
// Player counters live on game_session_players. "poison" >= 10 loses the game.
const PlayerCounterTypeSchema = z.enum(['poison', 'energy', 'experience'])

const CardBehaviorActionSchema = z.union([
  z.object({
    type: z.literal('add_mana'),
    color: ManaProductionColorSchema,
    amount: z.number(),
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
    amount: AmountSchema,
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
    filter: z.object({ type_line: z.string().optional(), name: z.string().optional() }).optional(),
  }),
  // Discard `count` cards. `who` is the discarding player — 'you' (controller,
  // default) or 'opponent' (Mind Rot). `random: true` discards at random (no
  // choice); otherwise the discarding player chooses.
  z.object({
    type: z.literal('discard'),
    count: z.number().optional(),
    who: z.enum(['you', 'opponent']).optional(),
    random: z.boolean().optional(),
  }),
  // Optional "you may": a yes/no gate that, if accepted, runs the inner effects.
  z.object({
    type: z.literal('may'),
    prompt: z.string().optional(),
    // Inner effects kept loose to avoid a self-referential schema; the engine
    // applies them (untargeted / creature-target) at confirm time.
    effects: z.array(z.record(z.string(), z.unknown())),
  }),
  // Choose a player at resolution, then apply the inner (player-directed) effects
  // to them. filter: "opponent" or "any". Inner effects kept loose (see may).
  z.object({
    type: z.literal('choose_player'),
    filter: z.enum(['opponent', 'any']).optional(),
    effects: z.array(z.record(z.string(), z.unknown())),
  }),
  // "Choose a creature type, then …" (Distant Melody). The chosen type is injected
  // into any sub-effect's count-amount type_line (e.g. count creatures_you_control).
  z.object({
    type: z.literal('choose_creature_type'),
    effects: z.array(z.record(z.string(), z.unknown())),
  }),
  // Sacrifice `count` creatures: the sacrificing player (you, or the opponent for
  // an edict) chooses among permanents they control. Default filter is creatures.
  z.object({
    type: z.literal('sacrifice'),
    who: z.enum(['you', 'opponent', 'each_opponent']).optional(),
    count: z.number().optional(),
    filter: z.object({ type_line: z.string().optional() }).optional(),
  }),
  // Return up to `count` cards from your graveyard (default creatures) to your
  // hand (Raise Dead) or the battlefield (Reanimate). The controller chooses.
  z.object({
    type: z.literal('return_from_graveyard'),
    to: z.enum(['hand', 'battlefield']).optional(),
    count: z.number().optional(),
    filter: z.object({ type_line: z.string().optional() }).optional(),
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
    count: z.number().optional(),
    // The tokens enter tapped (Army of the Damned: "thirteen … tokens that are tapped").
    tapped: z.boolean().optional(),
    // "Its controller creates a token" (Beast Within): the token is created under the
    // control of the spell's TARGET's controller, not the caster.
    recipient: z.literal('target_controller').optional(),
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
  }),
  z.object({
    type: z.literal('pump'),
    // A fixed delta, or a dynamic { count, …, negate? } value (Liliana −2: -X/-X).
    power: z.union([z.number(), PumpValueSchema]).optional(),
    toughness: z.union([z.number(), PumpValueSchema]).optional(),
    target_ref: z.string().optional(),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
  }),
  // Mass, until-end-of-turn P/T pump applied to every creature matching the filter
  // (Crippling Fear). scope 'all' (default) = any controller; 'controller' = yours.
  // creature_type + exclude_type:true = "creatures that AREN'T of the chosen type".
  // Pairs with choose_creature_type, which injects the chosen type into creature_type.
  z.object({
    type: z.literal('pump_all'),
    power: z.number(),
    toughness: z.number(),
    scope: z.enum(['all', 'controller']).optional(),
    creature_type: z.string().optional(),
    exclude_type: z.boolean().optional(),
  }),
  // Amass N — create-or-grow a 0/0 Zombie Army with N +1/+1 counters.
  z.object({
    type: z.literal('amass'),
    amount: z.number(),
  }),
  // Mass destroy (board wipe) — all matching battlefield creatures, optional type.
  z.object({
    type: z.literal('destroy_all'),
    scope: z.enum(['all', 'you', 'opponent']).optional(),
    creature_type: z.string().optional(),
  }),
  // Mass reanimate — return ALL matching creature cards from your graveyard.
  z.object({
    type: z.literal('return_all_from_graveyard'),
    to: z.enum(['battlefield', 'hand']).optional(),
    creature_type: z.string().optional(),
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
    // Optional self-rider ("…and you lose 3 life"): applied to the caster on
    // resolution. Single-target only (not with `targets` > 1).
    then: ThenRiderSchema,
    // Assassin's Trophy: the destroyed permanent's controller may search their
    // library for a basic land, put it onto the battlefield, then shuffle.
    controller_searches_basic_land: z.boolean().optional(),
  }),
  // Grant a keyword to a target creature until end of turn (trigger-only today).
  z.object({
    type: z.literal('grant_keyword'),
    keyword: z.enum([
      'flying', 'reach', 'trample', 'vigilance', 'haste',
      'first_strike', 'double_strike', 'deathtouch', 'indestructible',
    ]),
    target_ref: z.string().optional(),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
  }),
  // Fight: a creature you control fights a target creature. target_type/
  // target_controller describe the FOUGHT creature (the fighter is implicitly
  // one you control). Each deals damage equal to its power to the other.
  z.object({
    type: z.literal('fight'),
    target_ref: z.string().optional(),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
  }),
  // Gain control of a target creature. duration: permanent (default) or until end
  // of turn. target_type/target_controller describe the creature ("opponent" for
  // "you don't control"). Trigger-only today.
  z.object({
    type: z.literal('gain_control'),
    duration: z.enum(['permanent', 'end_of_turn']).optional(),
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
})

const CardBehaviorTriggeredAbilitySchema = z.object({
  id: z.string().optional(),
  event: z.string(),
  source_zone_required: BehaviorZoneSchema.optional(),
  condition: z.record(z.string(), z.unknown()).optional(),
  // For the other-scoped events creature_entered / creature_died: which entering/dying
  // creature this watcher fires on. type_line = a subtype match (e.g. "Zombie");
  // controller is relative to this card's controller; exclude_self:true = "another …".
  filter: z.object({
    type_line: z.string().optional(),
    controller: z.enum(['you', 'opponent', 'any']).optional(),
    exclude_self: z.boolean().optional(),
    // "a NONTOKEN creature …" (Midnight Reaper, Open the Graves) — the watcher
    // ignores token creatures entering/dying.
    nontoken: z.boolean().optional(),
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
  // "If an effect would put counters on a permanent you control, it puts twice that
  // many instead" (Doubling Season). A static replacement read at counter-placement.
  doubles_counters: z.boolean().optional(),
  // "Enters the battlefield with N counters on it" — a REPLACEMENT, applied as the
  // card enters (before SBA), so a 0/0 that enters with +1/+1 counters survives.
  // counter_type defaults +1/+1.
  enters_with_counters: z.object({
    amount: z.number().int().positive(),
    counter_type: PermanentCounterTypeSchema,
  }).optional(),
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
