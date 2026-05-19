import type { ControllerCard, ManaPool } from './types'

export type PlayerJudgeStats = {
  libraryCount: number
  handCount: number
  tappedBattlefieldCount: number
  manaPool: ManaPool
  cards: ControllerCard[]
}

export function buildPlayerJudgeStats(cards: ControllerCard[], manaPool: ManaPool): PlayerJudgeStats {
  return {
    libraryCount: cards.filter((card) => card.zone === 'library').length,
    handCount: cards.filter((card) => card.zone === 'hand').length,
    tappedBattlefieldCount: cards.filter((card) => card.zone === 'battlefield' && card.is_tapped).length,
    manaPool,
    cards,
  }
}

export function getEmptyPlayerJudgeStats(): PlayerJudgeStats {
  return {
    libraryCount: 0,
    handCount: 0,
    tappedBattlefieldCount: 0,
    manaPool: {},
    cards: [],
  }
}
