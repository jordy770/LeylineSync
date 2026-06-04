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

export type EffectContext = 'trigger' | 'spell'

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
  | { name: string; kind: 'enum'; label?: string; default: string; options: readonly FieldOption[]; optional?: boolean; materializeDefault?: boolean; omitDefault?: boolean }
  | { name: string; kind: 'select'; label?: string; default: string; options: readonly FieldOption[]; optional?: boolean }
  | { name: string; kind: 'text'; label?: string; default: string; optional?: boolean }
  | { name: string; kind: 'object'; label?: string; fields: readonly FieldDescriptor[]; optional?: boolean }
  | { name: string; kind: 'effect-list'; label?: string; itemContext: EffectContext }
  | { name: string; kind: 'target'; label?: string; default: string; options: readonly TargetOption[] }

export type EffectDef = {
  type: string
  label: string
  contexts: readonly EffectContext[]
  fields: readonly FieldDescriptor[]
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

// Where a tutored card goes (search_library.to).
const SEARCH_DESTINATIONS: readonly FieldOption[] = [
  { value: 'hand', label: 'to your hand' },
  { value: 'battlefield', label: 'onto the battlefield' },
  { value: 'top', label: 'on top of your library' },
]

// Which player choose_player targets.
const CHOOSE_PLAYER_FILTERS: readonly FieldOption[] = [
  { value: 'opponent', label: 'an opponent' },
  { value: 'any', label: 'any player' },
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

// ─── The registry ───────────────────────────────────────────────────────────────

export const EFFECT_REGISTRY: readonly EffectDef[] = [
  { type: 'gain_life', label: 'Players gain life', contexts: ['trigger', 'spell'], fields: [amountField('Amount'), recipientField('controller', { materializeDefault: false, omitDefault: true })] },
  { type: 'lose_life', label: 'Players lose life', contexts: ['trigger', 'spell'], fields: [amountField('Amount'), recipientField()] },
  { type: 'deal_damage', label: 'Deal damage to players', contexts: ['trigger'], fields: [amountField('Amount'), recipientField()] },
  { type: 'draw', label: 'You draw cards', contexts: ['trigger', 'spell'], fields: [amountField('Amount')] },
  { type: 'mill', label: 'Mill cards', contexts: ['trigger', 'spell'], fields: [amountField('Amount'), recipientField()] },
  {
    type: 'create_token',
    label: 'Create token(s)',
    contexts: ['trigger'],
    fields: [
      { name: 'count', kind: 'number', label: 'Count', default: 1, min: 1, max: 20, optional: true },
      { name: 'token', kind: 'select', label: 'Token', default: EFFECT_TOKEN_NAMES[0], options: TOKEN_OPTIONS },
    ],
  },
  { type: 'add_counters', label: '+1/+1 counters on this', contexts: ['trigger'], fields: [amountField('Amount')] },
  { type: 'add_counters_all', label: '+1/+1 counters on creatures', contexts: ['trigger', 'spell'], fields: [amountField('Amount'), controllerField] },
  { type: 'tap_all', label: 'Tap creatures', contexts: ['trigger', 'spell'], fields: [controllerField] },
  { type: 'untap_all', label: 'Untap creatures', contexts: ['trigger', 'spell'], fields: [controllerField] },
  { type: 'scry', label: 'Scry N', contexts: ['trigger', 'spell'], fields: [amountField('Amount')] },
  { type: 'surveil', label: 'Surveil N', contexts: ['trigger', 'spell'], fields: [amountField('Amount')] },
  {
    type: 'search_library',
    label: 'Search library (tutor)',
    contexts: ['trigger', 'spell'],
    fields: [
      { name: 'count', kind: 'number', label: 'Count', default: 1, min: 1, max: 10, optional: true },
      { name: 'to', kind: 'enum', label: 'Destination', default: 'hand', options: SEARCH_DESTINATIONS, optional: true },
      {
        name: 'filter',
        kind: 'object',
        label: 'Filter',
        optional: true,
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
    label: 'Choose a player, then…',
    contexts: ['trigger', 'spell'],
    fields: [
      { name: 'filter', kind: 'enum', label: 'Player', default: 'opponent', options: CHOOSE_PLAYER_FILTERS, optional: true },
      { name: 'effects', kind: 'effect-list', label: 'Then', itemContext: 'trigger' },
    ],
  },
  // Single-target creature effects (Doom Blade, Banisher Priest exile, bounce, …).
  { type: 'destroy', label: 'Destroy creature', contexts: ['trigger', 'spell'], fields: [creatureTargetField] },
  { type: 'exile', label: 'Exile creature', contexts: ['trigger', 'spell'], fields: [creatureTargetField] },
  { type: 'bounce', label: 'Return creature to hand', contexts: ['trigger', 'spell'], fields: [creatureTargetField] },
  { type: 'tap', label: 'Tap creature', contexts: ['trigger', 'spell'], fields: [creatureTargetField] },
  { type: 'untap', label: 'Untap creature', contexts: ['trigger', 'spell'], fields: [creatureTargetField] },
  // Fight: a creature you control fights a target creature. The target field
  // describes the FOUGHT creature (the fighter is implicit — the source creature
  // as a trigger, or a creature you control as a spell).
  { type: 'fight', label: 'Fight (your creature fights a target creature)', contexts: ['trigger', 'spell'], fields: [creatureTargetField] },
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
] as const

const REGISTRY_BY_TYPE = new Map(EFFECT_REGISTRY.map((def) => [def.type, def]))

export function effectDef(type: string): EffectDef | undefined {
  return REGISTRY_BY_TYPE.get(type)
}

// Effect types available in a given form context, as {value,label} for dropdowns.
export function effectsForContext(context: EffectContext): { value: string; label: string }[] {
  return EFFECT_REGISTRY.filter((def) => def.contexts.includes(context)).map((def) => ({
    value: def.type,
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
      if (field.kind !== 'effect-list' && field.optional) {
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

export function effectDefault(type: string): RegistryEffect {
  const def = REGISTRY_BY_TYPE.get(type)
  if (!def) {
    throw new Error(`Unknown effect type: ${type}`)
  }
  const result: RegistryEffect = { type }
  for (const field of def.fields) {
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
  const def = REGISTRY_BY_TYPE.get(effect.type)
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
    // Drop optional fields that carry no information (blank text, empty object).
    if (field.kind !== 'effect-list' && 'optional' in field && field.optional && isEmptyValue(field, effect[field.name])) {
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
  const def = REGISTRY_BY_TYPE.get(type)
  if (!def || !def.contexts.includes(context)) {
    return null
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
    return null
  }

  const parsed = parseFields(def.fields, obj)
  if (parsed === null) {
    return null
  }
  return { type, ...parsed }
}
