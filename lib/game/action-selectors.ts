import type { CardAction, CardScript, GameZone, StackItem } from './types'

export type CardWithScript = {
  id: string
  is_tapped: boolean
  zone: GameZone
  cards?: {
    script?: CardScript | null
    type_line?: string | null
    mana_cost?: string | null
  } | null
}

export function getActionTiming(action: CardAction, typeLine?: string | null) {
  if (action.timing) {
    return action.timing === 'instant' || action.timing === 'sorcery' ? action.timing : null
  }

  const normalizedTypeLine = typeLine?.toLowerCase() ?? ''

  if (normalizedTypeLine.includes('instant')) {
    return 'instant'
  }

  if (normalizedTypeLine.includes('sorcery')) {
    return 'sorcery'
  }

  return null
}

export function isPlayerDamageAction(action: CardAction) {
  if (action.type !== 'deal_damage_player' && action.type !== 'deal_damage') {
    return false
  }

  return !action.target || action.target === 'player'
}

export function isRetainManaAction(action: CardAction) {
  return action.type === 'retain_mana' || action.type === 'mana_does_not_empty'
}

export function isCounterSpellAction(action: CardAction) {
  return (
    action.type === 'counter_spell' ||
    action.type === 'counter_target_spell' ||
    (action.type === 'counter' && (action.target === 'spell' || action.target_type === 'spell'))
  )
}

export function formatStackTargetLabel(item: StackItem) {
  if (item.action_type === 'cast_permanent') {
    return `Cast ${item.source_card_name ?? 'Unknown permanent'}`
  }

  if (item.action_type === 'deal_damage_player') {
    return `${item.source_card_name ?? 'Unknown source'} damage`
  }

  if (item.action_type === 'counter_spell') {
    return `${item.source_card_name ?? 'Counterspell'} counter`
  }

  return item.source_card_name ?? item.action_type
}

export function getRetainedManaColors(action: CardAction) {
  if (Array.isArray(action.colors)) {
    return action.colors
      .map((color) => color.toUpperCase())
      .filter(isManaColorSymbol)
  }

  if (action.color) {
    return [action.color.toUpperCase()].filter(isManaColorSymbol)
  }

  return []
}

function isManaColorSymbol(color: string) {
  return ['W', 'U', 'B', 'R', 'G', 'C'].includes(color)
}
