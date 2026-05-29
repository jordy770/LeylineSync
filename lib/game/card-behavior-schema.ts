import { z } from 'zod'

// ─── Shared primitives ───────────────────────────────────────────────────────

const ManaColorSchema = z.enum(['W', 'U', 'B', 'R', 'G', 'C'])

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
  payload: z.record(z.string(), z.unknown()).optional(),
  expires_at_turn_number: z.number().optional(),
  expires_at_phase: z.string().optional(),
  expires_at_step: z.string().optional(),
})

// ─── V1 schemas ──────────────────────────────────────────────────────────────

const KNOWN_V1_ACTION_TYPES = ['add_mana', 'deal_damage', 'counter_spell'] as const

// The catch-all only matches action types we haven't explicitly modelled,
// preventing known types with typo'd fields from silently passing.
const UnknownV1ActionSchema = z.object({
  type: z.string().refine(
    (t) => !(KNOWN_V1_ACTION_TYPES as readonly string[]).includes(t),
    { message: 'Known V1 action type with invalid fields — check required fields for this type' },
  ),
  color: z.string().optional(),
  colors: z.array(z.string()).optional(),
  amount: z.number().optional(),
  target: z.string().optional(),
  target_type: z.string().optional(),
  timing: z.string().optional(),
  expires_at_phase: z.string().optional(),
  expires_at_step: z.string().optional(),
})

export const CardActionSchema = z.union([
  z.object({
    type: z.literal('add_mana'),
    color: ManaColorSchema,
    amount: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('deal_damage'),
    amount: z.number().int().positive(),
    target: z.string().optional(),
    target_type: z.string().optional(),
    timing: z.string().optional(),
    expires_at_phase: z.string().optional(),
    expires_at_step: z.string().optional(),
  }),
  z.object({
    type: z.literal('counter_spell'),
    target: z.string().optional(),
    target_type: z.string().optional(),
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
  'planeswalker',
  'player',
  'spell',
])

const KNOWN_V2_COST_TYPES = [
  'tap_self', 'untap_self', 'mana', 'pay_life',
  'sacrifice_self', 'discard', 'exile_self',
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
  z.object({ type: z.literal('discard'), amount: z.number() }),
  z.object({ type: z.literal('exile_self'), from_zone: BehaviorZoneSchema.optional() }),
  UnknownCostSchema,
])

const KNOWN_V2_ACTION_TYPES = ['add_mana', 'deal_damage', 'counter'] as const

const UnknownV2ActionSchema = z.object({
  type: z.string().refine(
    (t) => !(KNOWN_V2_ACTION_TYPES as readonly string[]).includes(t),
    { message: 'Known V2 action type with invalid fields — check required fields for this type' },
  ),
}).passthrough()

const CardBehaviorActionSchema = z.union([
  z.object({
    type: z.literal('add_mana'),
    color: ManaColorSchema,
    amount: z.number(),
  }),
  z.object({
    type: z.literal('deal_damage'),
    amount: z.number(),
    target_ref: z.string().optional(),
    target_type: z.union([BehaviorTargetTypeSchema, z.array(BehaviorTargetTypeSchema)]).optional(),
  }),
  z.object({
    type: z.literal('counter'),
    target_ref: z.string().optional(),
    target_type: z.literal('spell').optional(),
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

const CardBehaviorSpellEffectSchema = z.object({
  targets: z.array(CardBehaviorTargetSchema).optional(),
  actions: z.array(CardBehaviorActionSchema),
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
  targets: z.array(CardBehaviorTargetSchema).optional(),
  effects: z.array(CardBehaviorActionSchema),
})

export const CardBehaviorScriptV2Schema = z.object({
  schema_version: z.literal(2),
  keywords: z.array(z.string()).optional(),
  spell_effect: CardBehaviorSpellEffectSchema.optional(),
  activated_abilities: z.array(CardBehaviorActivatedAbilitySchema).optional(),
  triggered_abilities: z.array(CardBehaviorTriggeredAbilitySchema).optional(),
  continuous_effects: z.array(CardContinuousEffectSchema).optional(),
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
