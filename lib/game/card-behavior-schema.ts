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
  count: z.enum(['creatures_you_control', 'lands_you_control', 'cards_in_graveyard']),
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
  // "Tap N untapped <type> creatures you control" as a cost (Gravespawn
  // Sovereign, mig 212). The engine auto-picks which to tap.
  z.object({ type: z.literal('tap_creatures'), count: z.number().int().positive(), type_line: z.string().optional() }),
  // "Remove N <kind> counters from this permanent" as a cost (Grimoire of the
  // Dead, mig 214). Bag counters on the SOURCE.
  z.object({ type: z.literal('remove_counters'), counter_type: z.string(), amount: z.number().int().positive() }),
  UnknownCostSchema,
])

export const KNOWN_V2_ACTION_TYPES = [
  'add_mana', 'deal_damage', 'counter', 'gain_life', 'lose_life', 'draw',
  'create_token', 'add_counters', 'destroy', 'exile', 'bounce', 'tap', 'untap',
  'pump', 'pump_all', 'mill', 'scry', 'surveil', 'search_library', 'discard', 'may', 'choose_player', 'choose_creature_type',
  'add_counters_all', 'tap_all', 'untap_all', 'grant_keyword', 'fight', 'gain_control',
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
  'exile_tops_cast', 'exile_until_leaves', 'become_monarch',
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
  count: z.enum(['creatures_you_control', 'lands_you_control', 'cards_in_graveyard', 'creatures_died_this_turn', 'nontoken_creatures_died_this_turn', 'artifacts_you_control', 'commanders_you_control', 'graveyard_casts_this_turn', 'greatest_mana_value_you_control', 'cards_in_hand', 'total_power_you_control', 'permanents_you_control', 'greatest_power_you_control', 'devotion']),
  type_line: z.string().optional(),
  // creatures_you_control only: count creatures with effective power >= N
  // (Become the Avalanche: "for each creature you control with power 4 or
  // greater").
  min_power: z.number().int().optional(),
  // "each OTHER <type> you control" (Earthshaker Dreadmaw, mig 257).
  exclude_self: z.boolean().optional(),
  // Invert the type filter (Return of the Wildspeaker: NON-Human, mig 257).
  exclude_type: z.boolean().optional(),
  color: z.enum(['W', 'U', 'B', 'R', 'G']).optional(),
}).strict()

// A pump power/toughness driven by a count, optionally negated (Liliana −2: -X/-X
// where X = Zombies you control → { count, type_line, negate: true }).
const PumpValueSchema = z.object({
  count: z.enum(['creatures_you_control', 'lands_you_control', 'cards_in_graveyard', 'creatures_died_this_turn', 'commanders_you_control', 'graveyard_casts_this_turn', 'devotion']),
  type_line: z.string().optional(),
  color: z.enum(['W', 'U', 'B', 'R', 'G']).optional(),
  negate: z.boolean().optional(),
}).strict()

// An effect amount: a fixed number, the literal "X" for a variable spell (chosen at
// cast time, paid as {X} generic mana, substituted server-side), or a dynamic
// counter- / count-referencing amount.
// "Damage equal to <permanent>'s power" (Eshki — its own power).
const PowerOfSchema = z.object({ power_of: z.enum(['source', 'target']) }).strict()

// "gain life equal to that creature's TOUGHNESS" (Verdant Sun's Avatar,
// mig 256) — resolved against the trigger's event subject.
const ToughnessOfSchema = z.object({ toughness_of: z.literal('triggering_creature') }).strict()

// 'event_amount' (mig 260, Wrathful Raptors): the magnitude of the trigger's
// damage event, substituted from the stack-item payload at resolve time.
const AmountSchema = z.union([z.number(), z.literal('X'), z.literal('event_amount'), DynamicAmountSchema, CountAmountSchema, PowerOfSchema, ToughnessOfSchema])

// Which kind of counter an add_counters effect places. "plus_one_one" is the
// engine's fast +1/+1 column; everything else lives in the jsonb counter bag.
const PermanentCounterTypeSchema = z.enum(['plus_one_one', 'minus_one_one', 'charge', 'quest', 'study', 'gold', 'generic']).optional()
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
    // Sinister Sabotage: "…Surveil N." The counter's CASTER surveils after the
    // counter resolves (applied even if the target can't be countered).
    surveil: z.number().int().nonnegative().optional(),
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
    // type_line_any: OR over several type words ("a Plains, Island, Swamp, or
    // Mountain card" — Farseek, mig 241).
    filter: z.object({
      type_line: z.string().optional(),
      type_line_any: z.array(z.string()).optional(),
      name: z.string().optional(),
    }).optional(),
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
    // Optional gate: the may is only offered when this count condition holds
    // (Liliana's Devotee: "if a creature died this turn, you may …").
    condition: z.object({
      count: z.enum(['creatures_you_control', 'lands_you_control', 'cards_in_graveyard', 'creatures_died_this_turn', 'commanders_you_control', 'graveyard_casts_this_turn']),
      type_line: z.string().optional(),
      at_least: z.number().int().positive(),
    }).optional(),
    // Optional mana cost paid on confirm before the effects run ("you may pay {1}{B}").
    cost: z.string().optional(),
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
  // "If <state condition>, <effects>." A count-based gate (you control / lands /
  // graveyard) that runs the inner effects when the count meets `at_least`. Inner
  // effects are the non-decision vocabulary. Kept loose like may/choose_player.
  z.object({
    type: z.literal('conditional'),
    condition: z.union([
      z.object({
        count: z.enum(['creatures_you_control', 'lands_you_control', 'cards_in_graveyard', 'creatures_died_this_turn', 'commanders_you_control', 'graveyard_casts_this_turn']),
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
    effects: z.array(z.record(z.string(), z.unknown())),
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
    filter: z.object({ type_line: z.string().optional() }).optional(),
    // Battlefield returns enter tapped (mig 218, Victimize).
    tapped: z.boolean().optional(),
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
    count: z.union([z.number(), z.object({ count: z.literal('sacrificed_this_way') }), CountAmountSchema]).optional(),
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
    target_type: z.literal('permanent').optional(),
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
  // ability's `condition` (total power 10+).
  z.object({
    type: z.literal('play_hideaway'),
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
    target_filter: z.object({
      controller: z.enum(['any', 'opponent', 'you']).optional(),
      nonland: z.boolean().optional(),
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
    target: z.literal('triggering_creature').optional(),
    target_filter: z.object({
      controller: z.enum(['any', 'opponent', 'you']).optional(),
      type_line: z.string().optional(),
    }).strict().optional(),
    except: z.object({
      power: z.number().int().optional(),
      toughness: z.number().int().optional(),
      keywords: z.array(z.string()).optional(),
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
    scope: z.enum(['all', 'controller']).optional(),
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
    amount: z.number().int().positive(),
    targets: z.enum(['creatures', 'creatures_planeswalkers']).optional(),
    filter: z.object({
      with_keyword: z.literal('flying').optional(),
      without_keyword: z.literal('flying').optional(),
      exclude_source: z.boolean().optional(),
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
      'intimidate', 'hexproof',
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
    // Optional self-rider ("…and you lose 3 life"): applied to the caster on
    // resolution. Single-target only (not with `targets` > 1).
    then: ThenRiderSchema,
    // Assassin's Trophy: the destroyed permanent's controller may search their
    // library for a basic land, put it onto the battlefield, then shuffle.
    controller_searches_basic_land: z.boolean().optional(),
    // NEGATIVE type restriction (mig 220, Cruel Revival "Destroy target
    // NON-Zombie creature"): the target may not match this type line.
    exclude_type_line: z.string().optional(),
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
  z.object({
    type: z.literal('grant_keyword'),
    keyword: z.enum([
      'flying', 'reach', 'trample', 'vigilance', 'haste',
      'first_strike', 'double_strike', 'deathtouch', 'indestructible',
    ]),
    target_ref: z.string().optional(),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
    target_controller: TargetControllerSchema,
    // Reflexive watcher (mig 227): 'triggering_creature' applies the grant to
    // the entering/attacking creature that fired the watcher (Atarka, Dragon
    // Tempest), no target pick.
    target: z.literal('triggering_creature').optional(),
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
      count: z.enum(['creatures_you_control', 'lands_you_control', 'artifacts_you_control', 'commanders_you_control', 'total_power_you_control', 'permanents_you_control']),
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
    controller: z.enum(['you', 'opponent', 'any']).optional(),
    exclude_self: z.boolean().optional(),
    // "a NONTOKEN creature …" (Midnight Reaper, Open the Graves) — the watcher
    // ignores token creatures entering/dying.
    nontoken: z.boolean().optional(),
    // "a creature with power N or greater …" (mig 225 — Elemental Bond, Temur
    // Ascendancy). Fires only when the entering creature's power is >= N.
    min_power: z.number().int().optional(),
    // "a creature you control WITH FLYING …" (mig 227 — Dragon Tempest).
    has_keyword: z.literal('flying').optional(),
    // "whenever a GOADED creature attacks" (mig 249 — Vengeful Ancestor).
    goaded: z.boolean().optional(),
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
