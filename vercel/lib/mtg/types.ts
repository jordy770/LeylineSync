// MTG Game Types

export type ManaColor = 'W' | 'U' | 'B' | 'R' | 'G' | 'C'

export interface ManaPool {
  W: number
  U: number
  B: number
  R: number
  G: number
  C: number
}

export interface Card {
  id: string
  name: string
  imageUrl: string
  type: 'creature' | 'instant' | 'sorcery' | 'artifact' | 'enchantment' | 'land' | 'planeswalker'
  manaCost?: string
  power?: number
  toughness?: number
  isTapped?: boolean
  isAttacking?: boolean
  isBlocking?: boolean
  attachedTo?: string
}

export interface Player {
  id: string
  name: string
  avatarUrl: string
  life: number
  commanderDamage: Record<string, number>
  manaPool: ManaPool
  hand: Card[]
  battlefield: Card[]
  graveyard: Card[]
  exile: Card[]
  library: Card[]
  commanderZone: Card[]
  lands: Card[]
}

export type GamePhase = 
  | 'UNTAP'
  | 'UPKEEP'
  | 'DRAW'
  | 'MAIN_1'
  | 'COMBAT_BEGIN'
  | 'DECLARE_ATTACKERS'
  | 'DECLARE_BLOCKERS'
  | 'COMBAT_DAMAGE'
  | 'COMBAT_END'
  | 'MAIN_2'
  | 'END_STEP'
  | 'CLEANUP'

export type SubState = 
  | 'IDLE'
  | 'WAITING_FOR_PRIORITY'
  | 'WAITING_FOR_COST'
  | 'SELECTING_TARGETS'
  | 'RESOLVING_STACK'

export interface AttackDeclaration {
  attackerId: string
  attackerCardId: string
  targetPlayerId: string
  targetType: 'player' | 'planeswalker'
  targetCardId?: string
}

export interface GameState {
  players: Player[]
  activePlayerId: string
  priorityPlayerId: string
  activePriorityPlayerId: string | null
  phase: GamePhase
  subState: SubState
  turn: number
  stack: Card[]
  combatZone: {
    attackers: AttackDeclaration[]
    blockers: { blockerId: string; blockerCardId: string; blockingAttackerId: string }[]
  }
  waitingForCost: {
    cardId: string
    validSources: string[]
  } | null
}

export interface CombatArrow {
  id: string
  fromCardId: string
  toPlayerId: string
  toCardId?: string
}
