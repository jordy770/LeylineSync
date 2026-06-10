// Declarative registry of the form-editable card effects. ONE entry per effect
// type describes its label, the contexts it may appear in, and its fields — and
// from that single description we derive defaults, JSON serialization, strict
// JSON parsing, the form widgets, and (via card-behavior-builder re-exports) the
// AI authoring guide. Adding a new form-editable effect = one entry here.
//
// Parsing is uniformly STRICT: an effect object may contain only its `type` plus
// its declared field names; a missing required field, an unknown key, or an
// invalid enum value makes the script non-form-representable (→ JSON mode),
// rather than silently dropping data.

export type FieldOption = { value: string; label: string }

// A combined target choice. Each option collapses the engine's two JSON keys
// (`target_type` + optional `target_controller`) into one user-facing pick, e.g.
// "a creature an opponent controls". `target_type` may be a string or an array
// (an array models "any target", e.g. ["creature","player"]).
export type TargetOption = {
  value: string
  label: string
  target_type: string | readonly string[]
  target_controller?: string
}

// 'rider' is a restricted context for a targeted spell's `then` self-rider — it
// only offers simple caster-directed effects (lose_life / gain_life / draw).
export type EffectContext = 'trigger' | 'spell' | 'rider'

// Field kinds:
//   `number`     — numeric; rejected if present-but-non-number.
//   `enum`       — value constrained to `options` (invalid → reject).
//   `select`     — free string rendered as a dropdown of suggestions (any string
//                  ok; mirrors the legacy lenient token handling).
//   `text`       — free string (any string ok).
//   `object`     — a nested record with its own `fields` (e.g. search_library's
//                  `filter`); parsed strictly (unknown sub-keys → reject).
//   `effect-list`— a recursive array of effects (e.g. may/choose_player's
//                  `effects`), each parsed in `itemContext`. Absent → reject.
//   `target`     — a combined target picker. Stored in-memory as the chosen
//                  option's `value`, but serialized/parsed as the two engine keys
//                  `target_type` (+ optional `target_controller`). Always required.
export type FieldDescriptor =
  | { name: string; kind: 'number'; label?: string; default: number; min?: number; max?: number; optional?: boolean; materializeDefault?: boolean; omitDefault?: boolean }
  | { name: string; kind: 'boolean'; label?: string; default: boolean; optional?: boolean }
  | { name: string; kind: 'enum'; label?: string; default: string; options: readonly FieldOption[]; optional?: boolean; materializeDefault?: boolean; omitDefault?: boolean }
  | { name: string; kind: 'select'; label?: string; default: string; options: readonly FieldOption[]; optional?: boolean }
  | { name: string; kind: 'text'; label?: string; default: string; optional?: boolean }
  | { name: string; kind: 'object'; label?: string; fields: readonly FieldDescriptor[]; optional?: boolean }
  | { name: string; kind: 'effect-list'; label?: string; itemContext: EffectContext; optional?: boolean }
  | { name: string; kind: 'target'; label?: string; default: string; options: readonly TargetOption[] }

export type EffectDef = {
  type: string
  label: string
  contexts: readonly EffectContext[]
  fields: readonly FieldDescriptor[]
  // A `type` can have more than one form shape (e.g. deal_damage "to each opponent"
  // vs "to a target"). Each non-default shape gets a unique `variant` id, used as
  // its form-list key; the right def is resolved from an effect's fields. Omitted →
  // the default shape, keyed by `type`.
  variant?: string
}

// ─── Shared field vocab ────────────────────────────────────────────────────────

export const EFFECT_RECIPIENTS = [
  { value: 'each_opponent', label: 'each opponent' },
  { value: 'controller', label: 'you' },
  { value: 'each_player', label: 'each player' },
  { value: 'all_players', label: 'all players' },
] as const

export const EFFECT_TOKEN_NAMES = [
  'Soldier Token',
  'Saproling Token',
  'Zombie Token',
  'Zombie Knight Token',
  'Goblin Token',
  'Beast Token',
  'Spirit Token',
] as const

const TOKEN_OPTIONS: readonly FieldOption[] = EFFECT_TOKEN_NAMES.map((n) => ({ value: n, label: n }))

const amountField = (label: string): FieldDescriptor => ({ name: 'amount', kind: 'number', label, default: 1, min: 0, max: 99 })
const recipientField = (defaultRecipient = 'each_opponent', opts: Pick<Extract<FieldDescriptor, { kind: 'enum' }>, 'materializeDefault' | 'omitDefault'> = {}): FieldDescriptor => ({
  name: 'recipient',
  kind: 'enum',
  default: defaultRecipient,
  options: EFFECT_RECIPIENTS,
  optional: true,
  ...opts,
})
const controllerField: FieldDescriptor = {
  name: 'target_controller',
  kind: 'enum',
  label: 'Creatures',
  default: 'you',
  options: [
    { value: 'you', label: 'creatures you control' },
    { value: 'opponent', label: 'creatures opponents control' },
    { value: 'any', label: 'all creatures' },
  ],
  optional: true,
}

// Which creatures a mass pump (pump_all) affects: 'all' (any controller) or
// 'controller' (yours). Serialized as `scope`.
const massPumpScopeField: FieldDescriptor = {
  name: 'scope',
  kind: 'enum',
  label: 'Affects',
  default: 'all',
  options: [
    { value: 'all', label: 'all creatures' },
    { value: 'controller', label: 'creatures you control' },
  ],
  optional: true,
}

// Which counter kind an add_counters effect places. "plus_one_one" is the engine's
// fast +1/+1 column (default, omitted when serialized); anything else lands in the
// jsonb counter bag and has no P/T effect.
const counterTypeField: FieldDescriptor = {
  name: 'counter_type',
  kind: 'enum',
  label: 'Counter kind',
  default: 'plus_one_one',
  options: [
    { value: 'plus_one_one', label: '+1/+1' },
    { value: 'minus_one_one', label: '−1/−1' },
    { value: 'charge', label: 'charge' },
    { value: 'quest', label: 'quest' },
    { value: 'study', label: 'study' },
    { value: 'gold', label: 'gold' },
    { value: 'generic', label: 'generic' },
  ],
  optional: true,
  // Default +1/+1 is the engine's fast column — keep it out of the in-memory shape
  // and the serialized JSON unless the author picks a bag counter.
  materializeDefault: false,
  omitDefault: true,
}

// Counter amount allows NEGATIVES (a negative amount removes that many counters —
// "remove a +1/+1 counter" = amount -1). Removing +1/+1 re-runs the lethal SBA.
const counterAmountField: FieldDescriptor = { name: 'amount', kind: 'number', label: 'Amount (negative removes)', default: 1, min: -99, max: 99 }

// "Remove ALL counters of that kind" (Hex Parasite / Solemnity-style). When true the
// amount is ignored. Optional + default false → omitted unless the author ticks it.
const removeAllField: FieldDescriptor = {
  name: 'all',
  kind: 'boolean',
  label: 'Remove all of that kind',
  default: false,
  optional: true,
}

// Player counters (poison/energy/experience) for add_player_counters.
const playerCounterTypeField: FieldDescriptor = {
  name: 'counter_type',
  kind: 'enum',
  label: 'Counter kind',
  default: 'poison',
  options: [
    { value: 'poison', label: 'poison' },
    { value: 'energy', label: 'energy' },
    { value: 'experience', label: 'experience' },
  ],
}

// Where a tutored card goes (search_library.to).
const SEARCH_DESTINATIONS: readonly FieldOption[] = [
  { value: 'hand', label: 'to your hand' },
  { value: 'battlefield', label: 'onto the battlefield' },
  { value: 'top', label: 'on top of your library' },
  { value: 'graveyard', label: 'into your graveyard' },
]

// Which player choose_player targets.
const CHOOSE_PLAYER_FILTERS: readonly FieldOption[] = [
  { value: 'opponent', label: 'an opponent' },
  { value: 'any', label: 'any player' },
]

// How long a gained control change lasts.
const DURATION_OPTIONS: readonly FieldOption[] = [
  { value: 'permanent', label: 'permanently' },
  { value: 'end_of_turn', label: 'until end of turn' },
]

// Keywords grantable until end of turn (must be members of the
// game_continuous_effects effect_type CHECK / a card_has_<keyword> accessor).
const KEYWORD_OPTIONS: readonly FieldOption[] = [
  { value: 'flying', label: 'flying' },
  { value: 'reach', label: 'reach' },
  { value: 'trample', label: 'trample' },
  { value: 'vigilance', label: 'vigilance' },
  { value: 'haste', label: 'haste' },
  { value: 'first_strike', label: 'first strike' },
  { value: 'double_strike', label: 'double strike' },
  { value: 'deathtouch', label: 'deathtouch' },
  { value: 'indestructible', label: 'indestructible' },
]

// The engine currently resolves these single-target effects against a creature
// only; the controller restriction is the meaningful axis.
const creatureTargetField: FieldDescriptor = {
  name: 'target',
  kind: 'target',
  label: 'Target',
  default: 'creature_any',
  options: [
    { value: 'creature_any', label: 'target creature', target_type: 'creature' },
    { value: 'creature_opponent', label: 'a creature an opponent controls', target_type: 'creature', target_controller: 'opponent' },
    { value: 'creature_you', label: 'a creature you control', target_type: 'creature', target_controller: 'you' },
  ],
}

// Removal (destroy/exile/bounce/tap/untap) may target any permanent, not just a
// creature — the engine's permanent_effect handles non-creature permanents and the
// trigger path (mig 114) matches by type. `nonland_permanent` is any permanent that
// isn't a land (Anguished Unmaking, Vindicate, …).
const removalTargetField: FieldDescriptor = {
  name: 'target',
  kind: 'target',
  label: 'Target',
  default: 'creature_any',
  options: [
    { value: 'creature_any', label: 'target creature', target_type: 'creature' },
    { value: 'creature_opponent', label: 'a creature an opponent controls', target_type: 'creature', target_controller: 'opponent' },
    { value: 'creature_you', label: 'a creature you control', target_type: 'creature', target_controller: 'you' },
    { value: 'artifact', label: 'target artifact', target_type: 'artifact' },
    { value: 'enchantment', label: 'target enchantment', target_type: 'enchantment' },
    { value: 'planeswalker', label: 'target planeswalker', target_type: 'planeswalker' },
    { value: 'nonland_permanent', label: 'target nonland permanent', target_type: 'nonland_permanent' },
    { value: 'nonland_permanent_opponent', label: 'a nonland permanent an opponent controls', target_type: 'nonland_permanent', target_controller: 'opponent' },
    { value: 'permanent', label: 'target permanent', target_type: 'permanent' },
    { value: 'permanent_opponent', label: 'a permanent an opponent controls', target_type: 'permanent', target_controller: 'opponent' },
  ],
}

// An optional self-rider on a targeted removal SPELL ("…and you lose 3 life"):
// simple caster-directed effects applied on resolution (engine: handle_permanent_
// effect). Spells only — a trigger uses its own effects list instead.
const thenRiderField: FieldDescriptor = {
  name: 'then',
  kind: 'effect-list',
  label: 'Then you… (spells only)',
  itemContext: 'rider',
  optional: true,
}

// Assassin's Trophy: the destroyed permanent's controller may search a basic land
// onto the battlefield. Spell-only; applies to the AFFECTED player, not the caster.
const basicLandRiderField: FieldDescriptor = {
  name: 'controller_searches_basic_land',
  kind: 'boolean',
  label: 'Its controller may search a basic land (spells only)',
  default: false,
  optional: true,
}

// Damage can target a creature OR a player (Lightning Bolt's "any target"); the
// engine routes each to its cast path (deal_damage_creature / deal_damage_player).
const damageTargetField: FieldDescriptor = {
  name: 'target',
  kind: 'target',
  label: 'Target',
  default: 'any',
  options: [
    { value: 'any', label: 'any target', target_type: ['creature', 'player'] },
    { value: 'creature_any', label: 'target creature', target_type: 'creature' },
    { value: 'creature_opponent', label: 'a creature an opponent controls', target_type: 'creature', target_controller: 'opponent' },
    { value: 'player_any', label: 'target player', target_type: 'player' },
    { value: 'player_opponent', label: 'target opponent', target_type: 'player', target_controller: 'opponent' },
  ],
}

// ─── The registry ───────────────────────────────────────────────────────────────

export const EFFECT_REGISTRY: readonly EffectDef[] = [
  { type: 'gain_life', label: 'Players gain life', contexts: ['trigger', 'spell'], fields: [amountField('Amount'), recipientField('controller', { materializeDefault: false, omitDefault: true })] },
  { type: 'lose_life', label: 'Players lose life', contexts: ['trigger', 'spell'], fields: [amountField('Amount'), recipientField()] },
  // Rider-only variants (no recipient — always the caster) for a removal spell's
  // `then`. Resolved over the recipient-bearing defs by the absence of `recipient`.
  { type: 'lose_life', variant: 'lose_life_rider', label: 'you lose life', contexts: ['rider'], fields: [amountField('Amount')] },
  { type: 'gain_life', variant: 'gain_life_rider', label: 'you gain life', contexts: ['rider'], fields: [amountField('Amount')] },
  { type: 'deal_damage', label: 'Deal damage to players', contexts: ['trigger'], fields: [amountField('Amount'), recipientField()] },
  // Targeted deal_damage (Lightning Bolt as a spell; "deal N damage to target
  // creature" as an ETB trigger — Flame Mage). The engine resolves a targeted
  // deal_damage trigger via the same path as destroy/pump (trigger_effect_target_type
  // lists deal_damage). Disambiguated from the recipient shape above by `target_type`.
  { type: 'deal_damage', variant: 'deal_damage_target', label: 'Deal damage to a target', contexts: ['trigger', 'spell'], fields: [amountField('Amount'), damageTargetField] },
  // Neutral subject ("Draw cards", not "You draw cards"): the drawer is the
  // effect's controller — the source's controller in a trigger/spell, the caster
  // in a `then` rider, and the CHOSEN player inside choose_player. A caster-centric
  // "you" label misread inside choose_player (the chosen player draws, not you).
  { type: 'draw', label: 'Draw cards', contexts: ['trigger', 'spell', 'rider'], fields: [amountField('Amount')] },
  { type: 'mill', label: 'Mill cards', contexts: ['trigger', 'spell'], fields: [amountField('Amount'), recipientField()] },
  {
    type: 'create_token',
    label: 'Create token(s)',
    contexts: ['trigger', 'spell'],
    fields: [
      { name: 'count', kind: 'number', label: 'Count', default: 1, min: 1, max: 20, optional: true },
      { name: 'token', kind: 'select', label: 'Token', default: EFFECT_TOKEN_NAMES[0], options: TOKEN_OPTIONS },
      // Army of the Damned: "tokens that are tapped".
      { name: 'tapped', kind: 'boolean', label: 'Enter tapped', default: false, optional: true },
    ],
  },
  // Add OR remove counters (negative amount / "remove all" removes — fading, Hex Parasite).
  { type: 'add_counters', label: 'Counters on this', contexts: ['trigger'], fields: [counterAmountField, counterTypeField, removeAllField] },
  // Targeted counters — add/remove counters on a target creature (spell or trigger).
  { type: 'add_counters', variant: 'add_counters_target', label: 'Counters on a target creature', contexts: ['trigger', 'spell'], fields: [counterAmountField, creatureTargetField, counterTypeField, removeAllField] },
  { type: 'add_counters_all', label: 'Counters on creatures', contexts: ['trigger', 'spell'], fields: [counterAmountField, controllerField, counterTypeField, removeAllField] },
  // Player counters — poison/energy/experience on players (poison >= 10 loses).
  { type: 'add_player_counters', label: 'Player counters (poison/energy/…)', contexts: ['trigger', 'spell'], fields: [counterAmountField, playerCounterTypeField, recipientField(), removeAllField] },
  { type: 'tap_all', label: 'Tap creatures', contexts: ['trigger', 'spell'], fields: [controllerField] },
  { type: 'untap_all', label: 'Untap creatures', contexts: ['trigger', 'spell'], fields: [controllerField] },
  // Mass P/T pump until end of turn (Crippling Fear = -3/-3 to non-chosen-type).
  // Under "Choose a creature type" leave Creature type BLANK (it's injected); set
  // it directly for a fixed-type mass pump.
  {
    type: 'pump_all',
    label: 'All creatures get ±X/±X (until end of turn)',
    contexts: ['trigger', 'spell'],
    fields: [
      { name: 'power', kind: 'number', label: 'Power', default: -1, min: -99, max: 99 },
      { name: 'toughness', kind: 'number', label: 'Toughness', default: -1, min: -99, max: 99 },
      massPumpScopeField,
      { name: 'creature_type', kind: 'text', label: 'Creature type', default: '', optional: true },
      { name: 'exclude_type', kind: 'boolean', label: 'Creatures NOT of that type', default: false, optional: true },
    ],
  },
  { type: 'amass', label: 'Amass N (grow a Zombie Army)', contexts: ['trigger', 'spell'], fields: [amountField('Amount')] },
  // Necromantic Selection (mig 208): board wipe + caster picks one destroyed
  // creature to reanimate under their control.
  {
    type: 'mass_destroy_reanimate_one',
    label: 'Destroy all creatures, then return one under your control',
    contexts: ['spell'],
    fields: [],
  },
  // Mass keyword grant until end of turn (mig 202): "All Zombies gain menace
  // until end of turn" (Lord of the Accursed), "permanents you control gain
  // hexproof" (Lazotep Plating — its "you" half is includes_player). Works as a
  // trigger effect, a spell action, or an activated-ability effect.
  {
    type: 'grant_keyword_all',
    label: 'All creatures gain a keyword (until end of turn)',
    contexts: ['trigger', 'spell'],
    fields: [
      {
        name: 'keyword',
        kind: 'enum',
        label: 'Keyword',
        default: 'menace',
        options: [
          { value: 'flying', label: 'flying' },
          { value: 'reach', label: 'reach' },
          { value: 'deathtouch', label: 'deathtouch' },
          { value: 'trample', label: 'trample' },
          { value: 'vigilance', label: 'vigilance' },
          { value: 'haste', label: 'haste' },
          { value: 'indestructible', label: 'indestructible' },
          { value: 'first_strike', label: 'first strike' },
          { value: 'double_strike', label: 'double strike' },
          { value: 'menace', label: 'menace' },
          { value: 'intimidate', label: 'intimidate' },
          { value: 'hexproof', label: 'hexproof' },
        ],
      },
      massPumpScopeField,
      { name: 'creature_type', kind: 'text', label: 'Creature type', default: '', optional: true },
      { name: 'includes_player', kind: 'boolean', label: 'You gain it too (player hexproof)', default: false, optional: true },
    ],
  },
  {
    type: 'destroy_all',
    label: 'Destroy all creatures (board wipe)',
    contexts: ['trigger', 'spell'],
    fields: [
      { name: 'scope', kind: 'enum', label: 'Which', default: 'all', options: [{ value: 'all', label: 'all creatures' }, { value: 'you', label: 'creatures you control' }, { value: 'opponent', label: "opponents' creatures" }], optional: true },
      { name: 'creature_type', kind: 'text', label: 'Creature type', default: '', optional: true },
    ],
  },
  {
    type: 'return_all_from_graveyard',
    label: 'Return all from your graveyard (mass reanimate)',
    contexts: ['trigger', 'spell'],
    fields: [
      { name: 'to', kind: 'enum', label: 'To', default: 'battlefield', options: [{ value: 'battlefield', label: 'the battlefield' }, { value: 'hand', label: 'your hand' }], optional: true },
      { name: 'creature_type', kind: 'text', label: 'Creature type', default: '', optional: true },
    ],
  },
  // "Exile target card from a graveyard" (Withered Wretch). Wired in the engine
  // only for ACTIVATED abilities (activate_ability carries the chosen graveyard
  // card as the target). Spell context is required because the activated-ability
  // effect picker draws from effectsForContext('spell'); as an actual instant/
  // sorcery action it has no target path and is a silent no-op (don't author it
  // as a spell). No fields — the graveyard card is chosen in-game, not authored.
  { type: 'exile_from_graveyard', label: 'Exile target card from a graveyard (ability)', contexts: ['spell'], fields: [] },
  // "Put target creature card from a graveyard onto the battlefield under your
  // control" (Gravespawn Sovereign, mig 212). Same activated-ability-only caveat
  // as exile_from_graveyard: the graveyard card is chosen in-game at activation.
  { type: 'reanimate_from_graveyard', label: 'Reanimate target graveyard creature under your control (ability)', contexts: ['spell'], fields: [] },
  // "As ~ enters, choose a color. Creatures you control of the chosen color get
  // +X/+Y" (Heraldic Banner, mig 209). The colour is picked in-game; the anthem
  // shape is authored here.
  {
    type: 'choose_color',
    label: 'Choose a color, then anthem that color',
    contexts: ['trigger'],
    fields: [
      {
        name: 'anthem',
        kind: 'object',
        label: 'Chosen-color creatures get',
        fields: [
          { name: 'power', kind: 'number', label: 'Power', default: 1, min: -99, max: 99 },
          { name: 'toughness', kind: 'number', label: 'Toughness', default: 0, min: -99, max: 99 },
          massPumpScopeField,
        ],
      },
    ],
  },
  { type: 'scry', label: 'Scry N', contexts: ['trigger', 'spell'], fields: [amountField('Amount')] },
  { type: 'surveil', label: 'Surveil N', contexts: ['trigger', 'spell'], fields: [amountField('Amount')] },
  {
    type: 'search_library',
    label: 'Search library (tutor)',
    contexts: ['trigger', 'spell'],
    fields: [
      { name: 'count', kind: 'number', label: 'Count', default: 1, min: 1, max: 10, optional: true },
      { name: 'to', kind: 'enum', label: 'Destination', default: 'hand', options: SEARCH_DESTINATIONS, optional: true },
      // "...put it onto the battlefield TAPPED" (Wayfarer's Bauble, Rampant Growth).
      // Optional boolean → omitted unless ticked, so plain tutors stay clean.
      { name: 'tapped', kind: 'boolean', label: 'Enters tapped', default: false, optional: true },
      {
        name: 'filter',
        kind: 'object',
        label: 'Filter',
        optional: true,
        // Only type_line is form-exposed; filter.name is JSON/AI-authorable (like
        // the reveal extra) — the object serializer can't drop an empty sub-field,
        // so adding it here would leak name:'' into every tutor.
        fields: [{ name: 'type_line', kind: 'text', label: 'Type line', default: '' }],
      },
    ],
  },
  {
    type: 'discard',
    label: 'Discard cards',
    contexts: ['trigger', 'spell'],
    fields: [{ name: 'count', kind: 'number', label: 'Count', default: 1, min: 1, max: 10, optional: true }],
  },
  {
    type: 'may',
    label: 'You may… (optional)',
    contexts: ['trigger', 'spell'],
    fields: [
      { name: 'prompt', kind: 'text', label: 'Prompt', default: '', optional: true },
      { name: 'effects', kind: 'effect-list', label: 'Then', itemContext: 'trigger' },
    ],
  },
  {
    type: 'choose_player',
    // The inner effects apply to the CHOSEN player (the engine forces each inner
    // effect's recipient to that player), so the subject is bound here, not "you".
    label: 'Choose a player, then that player…',
    contexts: ['trigger', 'spell'],
    fields: [
      { name: 'filter', kind: 'enum', label: 'Player', default: 'opponent', options: CHOOSE_PLAYER_FILTERS, optional: true },
      { name: 'effects', kind: 'effect-list', label: 'That player:', itemContext: 'trigger' },
    ],
  },
  {
    // "If you control N+ <type> [creatures/lands] / cards in graveyard, …" — a
    // state-gated composition wrapper. The condition is read by the engine; the
    // inner effects run only when it holds.
    type: 'conditional',
    label: 'If (a count is at least N), then…',
    contexts: ['trigger', 'spell'],
    fields: [
      {
        name: 'condition',
        kind: 'object',
        label: 'Condition',
        fields: [
          { name: 'count', kind: 'enum', label: 'Count of', default: 'creatures_you_control', options: [
            { value: 'creatures_you_control', label: 'creatures you control' },
            { value: 'lands_you_control', label: 'lands you control' },
            { value: 'cards_in_graveyard', label: 'cards in your graveyard' },
            { value: 'creatures_died_this_turn', label: 'creatures died under your control this turn' },
            { value: 'commanders_you_control', label: 'your commander on the battlefield (Lieutenant)' },
            { value: 'graveyard_casts_this_turn', label: 'spells you cast from a graveyard this turn' },
          ] },
          { name: 'type_line', kind: 'text', label: 'Of type (blank = any)', default: '' },
          { name: 'at_least', kind: 'number', label: 'Is at least', default: 1, min: 1, max: 99 },
        ],
      },
      { name: 'effects', kind: 'effect-list', label: 'Then:', itemContext: 'trigger' },
    ],
  },
  {
    // "Choose a creature type, then …" (Crippling Fear, Distant Melody). The chosen
    // type is injected into the inner effects (a pump_all's creature_type, or a
    // count-amount's type_line) — leave those blank.
    type: 'choose_creature_type',
    label: 'Choose a creature type, then…',
    contexts: ['spell'],
    fields: [
      { name: 'effects', kind: 'effect-list', label: 'Then (chosen type is injected):', itemContext: 'spell' },
    ],
  },
  // Single-target removal (Doom Blade, Disenchant, Anguished Unmaking, …). Targets
  // any permanent (creature / artifact / enchantment / planeswalker / nonland), with
  // an optional spell-only self-rider via `then`.
  { type: 'destroy', label: 'Destroy a permanent', contexts: ['trigger', 'spell'], fields: [removalTargetField, thenRiderField, basicLandRiderField] },
  { type: 'exile', label: 'Exile a permanent', contexts: ['trigger', 'spell'], fields: [removalTargetField, thenRiderField, basicLandRiderField] },
  { type: 'bounce', label: 'Return a permanent to hand', contexts: ['trigger', 'spell'], fields: [removalTargetField, thenRiderField, basicLandRiderField] },
  { type: 'tap', label: 'Tap a permanent', contexts: ['trigger', 'spell'], fields: [removalTargetField, thenRiderField, basicLandRiderField] },
  { type: 'untap', label: 'Untap a permanent', contexts: ['trigger', 'spell'], fields: [removalTargetField, thenRiderField, basicLandRiderField] },
  // Fight: a creature you control fights a target creature. The target field
  // describes the FOUGHT creature (the fighter is implicit — the source creature
  // as a trigger, or a creature you control as a spell).
  { type: 'fight', label: 'Fight (your creature fights a target creature)', contexts: ['trigger', 'spell'], fields: [creatureTargetField] },
  // Proliferate — at resolution the controller chooses any number of permanents
  // with a +1/+1 counter; each gets another. No authoring fields.
  { type: 'proliferate', label: 'Proliferate', contexts: ['trigger', 'spell'], fields: [] },
  {
    type: 'pump',
    label: 'Pump creature (+X/+X)',
    contexts: ['trigger', 'spell'],
    fields: [
      { name: 'power', kind: 'number', label: 'Power', default: 1, min: -20, max: 20 },
      { name: 'toughness', kind: 'number', label: 'Toughness', default: 1, min: -20, max: 20 },
      creatureTargetField,
    ],
  },
  // Grant a keyword until end of turn — authorable both as a triggered ability
  // and as an instant/sorcery combat trick (mig 100). target_type stays creature-only.
  {
    type: 'grant_keyword',
    label: 'Grant keyword until end of turn',
    contexts: ['trigger', 'spell'],
    fields: [
      { name: 'keyword', kind: 'enum', label: 'Keyword', default: 'flying', options: KEYWORD_OPTIONS },
      creatureTargetField,
    ],
  },
  // Gain control of a target creature (Threaten / Mind Control). The acting
  // controller (the ability's controller / caster) takes control; `duration` is
  // permanent or until end of turn (the latter reverts via the cleanup sweep).
  // Authorable as a trigger or as an instant/sorcery (Act of Treason). The form
  // models duration + target; the "threaten" extras (untap, haste) are JSON/AI.
  {
    type: 'gain_control',
    label: 'Gain control of a creature',
    contexts: ['trigger', 'spell'],
    fields: [
      { name: 'duration', kind: 'enum', label: 'Duration', default: 'permanent', options: DURATION_OPTIONS },
      creatureTargetField,
    ],
  },
] as const

// `type` may map to several defs (variants); `key` (variant ?? type) is unique.
const effectKey = (def: EffectDef): string => def.variant ?? def.type
const REGISTRY_BY_TYPE = new Map(EFFECT_REGISTRY.map((def) => [def.type, def]))
const REGISTRY_BY_KEY = new Map(EFFECT_REGISTRY.map((def) => [effectKey(def), def]))

function defsForType(type: string): EffectDef[] {
  return EFFECT_REGISTRY.filter((def) => def.type === type)
}

// Field keys a def "owns" on an effect (a target field is stored under 'target').
function defFieldKeys(def: EffectDef): string[] {
  return def.fields.map((f) => (f.kind === 'target' ? 'target' : f.name))
}

// A field key can only discriminate between variants if it's NOT present on every
// variant of the type. A key common to all variants (e.g. counter_type on both
// add_counters shapes, which is omitted by default) must not gate matching, or the
// more-specific variant silently fails to resolve when that optional field is absent.
function nonDiscriminatingKeys(type: string): Set<string> {
  const defs = defsForType(type)
  if (defs.length <= 1) return new Set()
  const keyLists = defs.map(defFieldKeys)
  return new Set(keyLists[0]!.filter((k) => keyLists.every((keys) => keys.includes(k))))
}

// Resolve which variant def an in-memory effect uses, by the fields it carries.
// Among defs whose discriminating field keys are all present, the most specific
// (most fields) wins; a single-variant type falls straight through.
export function resolveEffectDef(effect: RegistryEffect): EffectDef | undefined {
  const defs = defsForType(effect.type)
  if (defs.length <= 1) {
    return defs[0]
  }
  const shared = nonDiscriminatingKeys(effect.type)
  const candidates = defs.filter((def) =>
    defFieldKeys(def)
      .filter((k) => !shared.has(k))
      .every((k) => k in effect),
  )
  if (candidates.length === 0) {
    return defs[0]
  }
  return candidates.reduce((best, def) => (def.fields.length > best.fields.length ? def : best))
}

// The form-list key for an in-memory effect (which variant is selected).
export function effectKeyOf(effect: RegistryEffect): string {
  const def = resolveEffectDef(effect)
  return def ? effectKey(def) : effect.type
}

// Look up by form key (variant id) first, then by bare type for back-compat.
export function effectDef(keyOrType: string): EffectDef | undefined {
  return REGISTRY_BY_KEY.get(keyOrType) ?? REGISTRY_BY_TYPE.get(keyOrType)
}

// Effect variants available in a given form context, as {value,label} for dropdowns.
// `value` is the variant key, so two shapes of one type are distinct options.
export function effectsForContext(context: EffectContext): { value: string; label: string }[] {
  return EFFECT_REGISTRY.filter((def) => def.contexts.includes(context)).map((def) => ({
    value: effectKey(def),
    label: def.label,
  }))
}

// ─── Generic default / serialize / parse ─────────────────────────────────────────

// A registry-built effect is a record: { type, ...fieldValues }. Most fields are
// scalars; `object` fields nest a record and `effect-list` fields nest an array
// of RegistryEffects (recursive).
export type RegistryEffect = Record<string, unknown> & { type: string }

// ── per-field default / serialize / parse (mutually recursive with the effect-
//    level functions for `object` and `effect-list`) ──────────────────────────

const REJECT = Symbol('reject')

// ── target matching (combined target_type + target_controller) ────────────────

function targetTypeMatches(optType: string | readonly string[], jsonType: unknown): boolean {
  if (typeof optType === 'string') {
    return jsonType === optType
  }
  if (!Array.isArray(jsonType)) {
    return false
  }
  return jsonType.length === optType.length && optType.every((t) => jsonType.includes(t))
}

// Collapse the engine's controller vocab to the three buckets the form offers.
function controllerBucket(tc: unknown): 'any' | 'opponent' | 'you' {
  if (tc === 'opponent') {
    return 'opponent'
  }
  if (tc === 'you' || tc === 'controller' || tc === 'self') {
    return 'you'
  }
  return 'any' // undefined / null / 'any'
}

function fieldDefault(field: FieldDescriptor): unknown {
  switch (field.kind) {
    case 'number':
    case 'enum':
    case 'select':
    case 'text':
    case 'boolean':
    case 'target':
      return field.default
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const f of field.fields) {
        out[f.name] = fieldDefault(f)
      }
      return out
    }
    case 'effect-list':
      return []
  }
}

function fieldToJson(field: FieldDescriptor, value: unknown): unknown {
  switch (field.kind) {
    case 'number':
    case 'enum':
    case 'select':
    case 'text':
    case 'boolean':
    case 'target': // target is expanded to its two keys by effectToJson, never here
      return value
    case 'object': {
      const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const f of field.fields) {
        out[f.name] = fieldToJson(f, v[f.name])
      }
      return out
    }
    case 'effect-list': {
      const arr = Array.isArray(value) ? value : []
      return arr.map((e) => effectToJson(e as RegistryEffect))
    }
  }
}

// Whether a field's value carries no information — used to drop optional fields
// from the serialized JSON (a blank tutor filter / `may` prompt shouldn't be
// written out). Scalars with a chosen default (number/enum/select) are never
// "empty"; only free text, all-empty nested objects, and empty lists are.
function isEmptyValue(field: FieldDescriptor, value: unknown): boolean {
  switch (field.kind) {
    case 'number':
    case 'enum':
    case 'select':
    case 'target':
      return false
    // An optional boolean carries info only when true (false ≈ absent → dropped).
    case 'boolean':
      return value !== true
    case 'text':
      return typeof value !== 'string' || value === ''
    case 'object': {
      const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
      return field.fields.every((f) => isEmptyValue(f, v[f.name]))
    }
    case 'effect-list':
      return !Array.isArray(value) || value.length === 0
  }
}

// Parse one field's raw value, returning the in-memory value or REJECT.
function parseFieldValue(field: FieldDescriptor, raw: unknown): unknown | typeof REJECT {
  switch (field.kind) {
    case 'number':
      return typeof raw === 'number' ? raw : REJECT
    case 'boolean':
      return typeof raw === 'boolean' ? raw : REJECT
    case 'enum':
      return typeof raw === 'string' && field.options.some((o) => o.value === raw) ? raw : REJECT
    case 'select':
    case 'text':
      return typeof raw === 'string' ? raw : REJECT
    case 'target': // read from target_type/target_controller by parseFields, never here
      return REJECT
    case 'object': {
      if (typeof raw !== 'object' || raw === null) {
        return REJECT
      }
      const sub = raw as Record<string, unknown>
      const allowed = new Set(field.fields.map((f) => f.name))
      if (Object.keys(sub).some((k) => !allowed.has(k))) {
        return REJECT
      }
      const parsed = parseFields(field.fields, sub)
      return parsed === null ? REJECT : parsed
    }
    case 'effect-list': {
      if (!Array.isArray(raw)) {
        return REJECT
      }
      const out: RegistryEffect[] = []
      for (const item of raw) {
        const inner = effectFromJson(item, field.itemContext)
        if (inner === null) {
          return REJECT
        }
        out.push(inner)
      }
      return out
    }
  }
}

// Parse a record against a field set (required/optional + value validation).
// Strict key-checking is the caller's responsibility. Returns null on rejection.
function parseFields(fields: readonly FieldDescriptor[], obj: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    // A target reads from target_type (+ target_controller), not its own key.
    if (field.kind === 'target') {
      const tt = obj['target_type']
      if (tt === undefined) {
        return null
      }
      const bucket = controllerBucket(obj['target_controller'])
      const match = field.options.find(
        (o) => targetTypeMatches(o.target_type, tt) && controllerBucket(o.target_controller) === bucket,
      )
      if (!match) {
        return null
      }
      out[field.name] = match.value
      continue
    }
    const raw = obj[field.name]
    if (raw === undefined) {
      // An absent OPTIONAL effect-list / boolean (a removal with no rider / flag) is
      // simply omitted (the form reads undefined as empty / false).
      if (field.kind === 'effect-list' || field.kind === 'boolean') {
        if (field.optional) {
          continue
        }
        return null
      }
      if (field.optional) {
        if (!('materializeDefault' in field) || field.materializeDefault !== false) {
          out[field.name] = fieldDefault(field)
        }
        continue
      }
      return null
    }
    const value = parseFieldValue(field, raw)
    if (value === REJECT) {
      return null
    }
    out[field.name] = value
  }
  return out
}

// `keyOrType` is a form-list value: a variant key (e.g. 'deal_damage_target') or a
// bare type. The built effect carries the def's real `type`, not the key.
export function effectDefault(keyOrType: string): RegistryEffect {
  const def = REGISTRY_BY_KEY.get(keyOrType) ?? REGISTRY_BY_TYPE.get(keyOrType)
  if (!def) {
    throw new Error(`Unknown effect type: ${keyOrType}`)
  }
  const result: RegistryEffect = { type: def.type }
  for (const field of def.fields) {
    // An optional effect-list (a removal's `then` rider) or boolean flag starts
    // absent — the form sets it on demand; it would serialize to nothing anyway.
    if ((field.kind === 'effect-list' || field.kind === 'boolean') && field.optional) {
      continue
    }
    if (
      field.kind !== 'effect-list' &&
      'optional' in field &&
      field.optional &&
      'materializeDefault' in field &&
      field.materializeDefault === false
    ) {
      continue
    }
    result[field.name] = fieldDefault(field)
  }
  return result
}

// Serialize an in-memory effect to its JSON form: { type, ...declared fields }.
// Optional fields are always materialized (the in-memory effect carries them).
export function effectToJson(effect: RegistryEffect): Record<string, unknown> {
  const def = resolveEffectDef(effect)
  if (!def) {
    return { ...effect }
  }
  const out: Record<string, unknown> = { type: effect.type }
  for (const field of def.fields) {
    // A target expands to target_type (+ target_controller when restricted).
    if (field.kind === 'target') {
      const opt =
        field.options.find((o) => o.value === effect[field.name]) ??
        field.options.find((o) => o.value === field.default)!
      out['target_type'] = Array.isArray(opt.target_type) ? [...opt.target_type] : opt.target_type
      if (opt.target_controller !== undefined) {
        out['target_controller'] = opt.target_controller
      }
      continue
    }
    // Drop optional fields that carry no information (blank text, empty object,
    // an empty `then` rider list).
    if ('optional' in field && field.optional && isEmptyValue(field, effect[field.name])) {
      continue
    }
    if (
      field.kind !== 'effect-list' &&
      'optional' in field &&
      field.optional &&
      'omitDefault' in field &&
      field.omitDefault &&
      'default' in field &&
      effect[field.name] === field.default
    ) {
      continue
    }
    if (field.kind !== 'effect-list' && 'optional' in field && field.optional && effect[field.name] === undefined) {
      continue
    }
    out[field.name] = fieldToJson(field, effect[field.name])
  }
  return out
}

// Strict parse of one effect object in a context. Returns the in-memory effect,
// or null if it isn't faithfully form-representable (→ caller falls to JSON mode).
export function effectFromJson(value: unknown, context: EffectContext): RegistryEffect | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const obj = value as Record<string, unknown>
  const type = obj.type
  if (typeof type !== 'string') {
    return null
  }

  // A type may have several variant defs; try each (in context) and return the
  // first that strict-parses. Variants are key-disjoint (recipient vs target_type),
  // so at most one matches a given JSON object.
  for (const def of defsForType(type)) {
    if (!def.contexts.includes(context)) {
      continue
    }

    // Strict keys: `type` + declared field names; a target field owns the two
    // engine keys target_type/target_controller instead of its own name.
    const allowed = new Set<string>(['type'])
    for (const f of def.fields) {
      if (f.kind === 'target') {
        allowed.add('target_type')
        allowed.add('target_controller')
      } else {
        allowed.add(f.name)
      }
    }
    if (Object.keys(obj).some((key) => !allowed.has(key))) {
      continue
    }

    const parsed = parseFields(def.fields, obj)
    if (parsed !== null) {
      return { type, ...parsed }
    }
  }

  return null
}
