import type { CardAction, CardContinuousEffect, CardScript, GameZone, ManaColor } from './types'

export type CardBehaviorSchemaVersion = 1 | 2

export type CardBehaviorStatus = 'unsupported' | 'generated' | 'verified' | 'broken' | 'manual'

export type CardBehaviorZone = GameZone | 'command' | 'any'

export type CardBehaviorTargetType =
  | 'any'
  | 'artifact'
  | 'battle'
  | 'creature'
  | 'enchantment'
  | 'opponent'
  | 'permanent'
  | 'planeswalker'
  | 'player'
  | 'spell'

export type CardBehaviorCost =
  | { type: 'tap_self' }
  | { type: 'untap_self' }
  | { type: 'mana'; amount: string }
  | { type: 'pay_life'; amount: number }
  | { type: 'sacrifice_self' }
  | { type: 'discard'; amount: number }
  | { type: 'exile_self'; from_zone?: CardBehaviorZone }
  | { type: string; [key: string]: unknown }

export type CardBehaviorAction =
  | {
      type: 'add_mana'
      color: ManaColor
      amount: number
    }
  | {
      type: 'deal_damage'
      amount: number
      target_ref?: string
      target_type?: CardBehaviorTargetType | CardBehaviorTargetType[]
    }
  | {
      type: 'counter'
      target_ref?: string
      target_type?: 'spell'
    }
  | {
      type: string
      [key: string]: unknown
    }

export type CardBehaviorTarget = {
  id: string
  type: CardBehaviorTargetType | CardBehaviorTargetType[]
  controller?: 'any' | 'controller' | 'opponent'
  required_zone?: CardBehaviorZone
  optional?: boolean
}

export type CardBehaviorSpellEffect = {
  targets?: CardBehaviorTarget[]
  actions: CardBehaviorAction[]
}

export type CardBehaviorActivatedAbility = {
  id?: string
  label?: string
  costs: CardBehaviorCost[]
  effects: CardBehaviorAction[]
  is_mana_ability?: boolean
  timing?: 'instant' | 'sorcery' | string
  source_zone_required?: CardBehaviorZone
}

export type CardBehaviorTriggeredAbility = {
  id?: string
  event: string
  source_zone_required?: CardBehaviorZone
  condition?: Record<string, unknown>
  targets?: CardBehaviorTarget[]
  effects: CardBehaviorAction[]
}

export type CardBehaviorScriptV2 = {
  schema_version: 2
  keywords?: string[]
  spell_effect?: CardBehaviorSpellEffect
  activated_abilities?: CardBehaviorActivatedAbility[]
  triggered_abilities?: CardBehaviorTriggeredAbility[]
  continuous_effects?: CardContinuousEffect[]
}

export type AnyCardBehaviorScript = CardScript | CardBehaviorScriptV2

export function getCardBehaviorVersion(script: AnyCardBehaviorScript | null | undefined): CardBehaviorSchemaVersion {
  if (!script) {
    return 1
  }

  if ('schema_version' in script && script.schema_version === 2) {
    return 2
  }

  if (
    'spell_effect' in script ||
    'activated_abilities' in script ||
    'triggered_abilities' in script
  ) {
    return 2
  }

  return 1
}

export function normalizeCardBehaviorToV2(
  script: AnyCardBehaviorScript | null | undefined,
  typeLine?: string | null,
): CardBehaviorScriptV2 {
  if (!script) {
    return emptyCardBehaviorV2()
  }

  if (getCardBehaviorVersion(script) === 2) {
    return normalizeV2Script(script as Partial<CardBehaviorScriptV2>)
  }

  return migrateV1ScriptToV2(script as CardScript, typeLine)
}

export function selectManaAbilities(
  script: AnyCardBehaviorScript | null | undefined,
  typeLine?: string | null,
) {
  return normalizeCardBehaviorToV2(script, typeLine).activated_abilities?.filter(
    (ability) => ability.is_mana_ability,
  ) ?? []
}

export function selectFirstManaAbility(
  script: AnyCardBehaviorScript | null | undefined,
  typeLine?: string | null,
  preferredColor?: ManaColor,
) {
  const abilities = selectManaAbilities(script, typeLine)

  if (!preferredColor) {
    return abilities[0] ?? null
  }

  return (
    abilities.find((ability) =>
      ability.effects.some((effect) => effect.type === 'add_mana' && effect.color === preferredColor),
    ) ??
    abilities[0] ??
    null
  )
}

export function selectContinuousEffects(script: AnyCardBehaviorScript | null | undefined) {
  return normalizeCardBehaviorToV2(script).continuous_effects ?? []
}

export function isAddManaBehaviorAction(
  action: CardBehaviorAction,
): action is Extract<CardBehaviorAction, { type: 'add_mana' }> {
  return (
    action.type === 'add_mana' &&
    'color' in action &&
    typeof action.color === 'string' &&
    ['W', 'U', 'B', 'R', 'G', 'C'].includes(action.color) &&
    'amount' in action &&
    typeof action.amount === 'number'
  )
}

function migrateV1ScriptToV2(script: CardScript, typeLine?: string | null): CardBehaviorScriptV2 {
  const actions = script.actions ?? []
  const triggers = script.triggers ?? []
  const manualTapActions = triggers.includes('manual_tap')
    ? actions.filter(isValidManaAction)
    : []
  const manualTapActionSet = new Set<CardAction>(manualTapActions)
  const spellActions = actions.filter((action) => !manualTapActionSet.has(action))
  const spellEffect = getV1SpellEffect(spellActions, triggers, typeLine)

  return {
    schema_version: 2,
    spell_effect: spellEffect,
    activated_abilities: manualTapActions.map((action) => ({
      costs: [{ type: 'tap_self' }],
      effects: [normalizeAction(action)],
      is_mana_ability: true,
      source_zone_required: 'battlefield',
    })),
    triggered_abilities: getV1TriggeredAbilities(spellActions, triggers, spellEffect),
    continuous_effects: script.continuous_effects ?? [],
  }
}

function getV1SpellEffect(
  actions: CardAction[],
  triggers: string[],
  typeLine?: string | null,
): CardBehaviorSpellEffect | undefined {
  const isSpellType = isInstantOrSorcery(typeLine)
  const shouldTreatCastAsSpellEffect = triggers.includes('cast') && actions.length > 0

  if (!isSpellType && !shouldTreatCastAsSpellEffect) {
    return undefined
  }

  return {
    targets: inferTargets(actions),
    actions: actions.map(normalizeAction),
  }
}

function getV1TriggeredAbilities(
  actions: CardAction[],
  triggers: string[],
  spellEffect: CardBehaviorSpellEffect | undefined,
) {
  if (spellEffect) {
    return []
  }

  return triggers
    .filter((trigger) => trigger !== 'manual_tap')
    .map<CardBehaviorTriggeredAbility>((trigger) => ({
      event: trigger,
      effects: actions.map(normalizeAction),
    }))
}

function inferTargets(actions: CardAction[]): CardBehaviorTarget[] | undefined {
  const targetTypes = actions
    .map((action) => action.target_type ?? action.target)
    .filter((targetType): targetType is string => Boolean(targetType))

  if (targetTypes.length === 0) {
    return undefined
  }

  const firstTargetType = targetTypes[0]

  return [
    {
      id: 't1',
      type: normalizeTargetType(firstTargetType),
    },
  ]
}

function normalizeAction(action: CardAction): CardBehaviorAction {
  if (isValidManaAction(action)) {
    return {
      type: 'add_mana',
      color: action.color.toUpperCase() as ManaColor,
      amount: action.amount,
    }
  }

  return { ...action } as CardBehaviorAction
}

function normalizeTargetType(targetType: string): CardBehaviorTargetType | CardBehaviorTargetType[] {
  if (targetType === 'any') {
    return ['creature', 'player', 'planeswalker', 'battle']
  }

  return targetType as CardBehaviorTargetType
}

function normalizeV2Script(script: Partial<CardBehaviorScriptV2>): CardBehaviorScriptV2 {
  return {
    schema_version: 2,
    keywords: script.keywords ?? [],
    spell_effect: script.spell_effect,
    activated_abilities: script.activated_abilities ?? [],
    triggered_abilities: script.triggered_abilities ?? [],
    continuous_effects: script.continuous_effects ?? [],
  }
}

function emptyCardBehaviorV2(): CardBehaviorScriptV2 {
  return {
    schema_version: 2,
    keywords: [],
    activated_abilities: [],
    triggered_abilities: [],
    continuous_effects: [],
  }
}

function isValidManaAction(action: CardAction): action is CardAction & { color: string; amount: number } {
  return (
    action.type === 'add_mana' &&
    typeof action.color === 'string' &&
    ['W', 'U', 'B', 'R', 'G', 'C'].includes(action.color.toUpperCase()) &&
    typeof action.amount === 'number'
  )
}

function isInstantOrSorcery(typeLine?: string | null) {
  const normalizedTypeLine = typeLine?.toLowerCase() ?? ''
  return normalizedTypeLine.includes('instant') || normalizedTypeLine.includes('sorcery')
}
