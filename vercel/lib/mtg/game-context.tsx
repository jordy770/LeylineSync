"use client"

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import type { GameState, Player, Card, ManaColor, AttackDeclaration, GamePhase } from './types'

// Mock data for demonstration
const createMockPlayer = (id: string, name: string): Player => ({
  id,
  name,
  avatarUrl: `/api/placeholder/80/80?text=${name[0]}`,
  life: 40,
  commanderDamage: {},
  manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
  hand: Array.from({ length: 5 }, (_, i) => ({
    id: `${id}-hand-${i}`,
    name: `Card ${i + 1}`,
    imageUrl: `/api/placeholder/146/204?text=Card`,
    type: i === 0 ? 'creature' : i === 1 ? 'instant' : 'sorcery',
    manaCost: '{2}{U}',
    power: i === 0 ? 3 : undefined,
    toughness: i === 0 ? 3 : undefined,
  })),
  battlefield: Array.from({ length: 3 }, (_, i) => ({
    id: `${id}-bf-${i}`,
    name: `Creature ${i + 1}`,
    imageUrl: `/api/placeholder/146/204?text=Creature`,
    type: 'creature',
    power: 2 + i,
    toughness: 2 + i,
    isTapped: false,
  })),
  graveyard: [],
  exile: [],
  library: Array.from({ length: 60 }, (_, i) => ({
    id: `${id}-lib-${i}`,
    name: `Library Card ${i}`,
    imageUrl: `/api/placeholder/146/204?text=Back`,
    type: 'creature',
  })),
  commanderZone: [{
    id: `${id}-commander`,
    name: `${name}'s Commander`,
    imageUrl: `/api/placeholder/146/204?text=Cmdr`,
    type: 'creature',
    power: 5,
    toughness: 5,
  }],
  lands: Array.from({ length: 4 }, (_, i) => ({
    id: `${id}-land-${i}`,
    name: ['Plains', 'Island', 'Swamp', 'Mountain'][i % 4],
    imageUrl: `/api/placeholder/146/204?text=Land`,
    type: 'land',
    isTapped: false,
  })),
})

const initialGameState: GameState = {
  players: [
    createMockPlayer('p1', 'Player 1'),
    createMockPlayer('p2', 'Player 2'),
    createMockPlayer('p3', 'Player 3'),
    createMockPlayer('p4', 'Player 4'),
  ],
  activePlayerId: 'p1',
  priorityPlayerId: 'p1',
  activePriorityPlayerId: null,
  phase: 'MAIN_1',
  subState: 'IDLE',
  turn: 1,
  stack: [],
  combatZone: {
    attackers: [],
    blockers: [],
  },
  waitingForCost: null,
}

interface GameContextType {
  gameState: GameState
  setActivePriorityPlayer: (playerId: string | null) => void
  passPriority: (playerId: string) => void
  tapMana: (playerId: string, color: ManaColor) => void
  playCard: (playerId: string, cardId: string) => void
  tapCard: (playerId: string, cardId: string) => void
  untapCard: (playerId: string, cardId: string) => void
  activateAbility: (playerId: string, cardId: string, abilityIndex: number) => void
  declareAttacker: (declaration: AttackDeclaration) => void
  clearAttackers: () => void
  setPhase: (phase: GamePhase) => void
  setWaitingForCost: (cardId: string, validSources: string[]) => void
  clearWaitingForCost: () => void
  triggerHaptic: (type: 'priority' | 'attack' | 'damage' | 'tap') => void
  getPlayer: (playerId: string) => Player | undefined
  reorderHand: (playerId: string, fromIndex: number, toIndex: number) => void
}

const GameContext = createContext<GameContextType | null>(null)

export function GameProvider({ children }: { children: ReactNode }) {
  const [gameState, setGameState] = useState<GameState>(initialGameState)

  const setActivePriorityPlayer = useCallback((playerId: string | null) => {
    setGameState(prev => ({ ...prev, activePriorityPlayerId: playerId }))
  }, [])

  const passPriority = useCallback((playerId: string) => {
    setGameState(prev => {
      const currentIndex = prev.players.findIndex(p => p.id === playerId)
      const nextIndex = (currentIndex + 1) % prev.players.length
      return {
        ...prev,
        priorityPlayerId: prev.players[nextIndex].id,
      }
    })
    triggerHaptic('priority')
  }, [])

  const tapMana = useCallback((playerId: string, color: ManaColor) => {
    setGameState(prev => ({
      ...prev,
      players: prev.players.map(p => 
        p.id === playerId 
          ? { ...p, manaPool: { ...p.manaPool, [color]: p.manaPool[color] + 1 } }
          : p
      ),
    }))
  }, [])

  const tapCard = useCallback((playerId: string, cardId: string) => {
    setGameState(prev => ({
      ...prev,
      players: prev.players.map(p =>
        p.id === playerId
          ? {
              ...p,
              battlefield: p.battlefield.map(c =>
                c.id === cardId ? { ...c, isTapped: true } : c
              ),
            }
          : p
      ),
    }))
    triggerHaptic('tap')
  }, [])

  const untapCard = useCallback((playerId: string, cardId: string) => {
    setGameState(prev => ({
      ...prev,
      players: prev.players.map(p =>
        p.id === playerId
          ? {
              ...p,
              battlefield: p.battlefield.map(c =>
                c.id === cardId ? { ...c, isTapped: false } : c
              ),
            }
          : p
      ),
    }))
  }, [])

  const activateAbility = useCallback((playerId: string, cardId: string, abilityIndex: number) => {
    // This would trigger ability activation - for now just add to stack
    const player = gameState.players.find(p => p.id === playerId)
    if (!player) return

    const card = player.battlefield.find(c => c.id === cardId)
    if (!card) return

    setGameState(prev => ({
      ...prev,
      stack: [...prev.stack, { ...card, name: `${card.name} Ability ${abilityIndex + 1}` }],
    }))
    triggerHaptic('priority')
  }, [gameState.players])

  const playCard = useCallback((playerId: string, cardId: string) => {
    setGameState(prev => {
      const player = prev.players.find(p => p.id === playerId)
      if (!player) return prev

      const cardIndex = player.hand.findIndex(c => c.id === cardId)
      if (cardIndex === -1) return prev

      const card = player.hand[cardIndex]
      const newHand = [...player.hand]
      newHand.splice(cardIndex, 1)

      return {
        ...prev,
        players: prev.players.map(p =>
          p.id === playerId
            ? {
                ...p,
                hand: newHand,
                battlefield: card.type === 'creature' || card.type === 'artifact' || card.type === 'enchantment'
                  ? [...p.battlefield, card]
                  : p.battlefield,
              }
            : p
        ),
        stack: card.type === 'instant' || card.type === 'sorcery' 
          ? [...prev.stack, card]
          : prev.stack,
      }
    })
  }, [])

  const declareAttacker = useCallback((declaration: AttackDeclaration) => {
    setGameState(prev => ({
      ...prev,
      phase: 'DECLARE_ATTACKERS',
      combatZone: {
        ...prev.combatZone,
        attackers: [...prev.combatZone.attackers, declaration],
      },
      players: prev.players.map(p =>
        p.id === declaration.attackerId
          ? {
              ...p,
              battlefield: p.battlefield.map(c =>
                c.id === declaration.attackerCardId
                  ? { ...c, isAttacking: true, isTapped: true }
                  : c
              ),
            }
          : p
      ),
    }))
    triggerHaptic('attack')
  }, [])

  const clearAttackers = useCallback(() => {
    setGameState(prev => ({
      ...prev,
      combatZone: { attackers: [], blockers: [] },
      players: prev.players.map(p => ({
        ...p,
        battlefield: p.battlefield.map(c => ({ ...c, isAttacking: false, isBlocking: false })),
      })),
    }))
  }, [])

  const setPhase = useCallback((phase: GamePhase) => {
    setGameState(prev => ({ ...prev, phase }))
  }, [])

  const setWaitingForCost = useCallback((cardId: string, validSources: string[]) => {
    setGameState(prev => ({
      ...prev,
      subState: 'WAITING_FOR_COST',
      waitingForCost: { cardId, validSources },
    }))
  }, [])

  const clearWaitingForCost = useCallback(() => {
    setGameState(prev => ({
      ...prev,
      subState: 'IDLE',
      waitingForCost: null,
    }))
  }, [])

  const triggerHaptic = useCallback((type: 'priority' | 'attack' | 'damage' | 'tap') => {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      switch (type) {
        case 'priority':
          navigator.vibrate(50)
          break
        case 'attack':
          navigator.vibrate([100, 50, 100])
          break
        case 'damage':
          navigator.vibrate([200, 100, 200, 100, 200])
          break
        case 'tap':
          navigator.vibrate(30)
          break
      }
    }
  }, [])

  const getPlayer = useCallback((playerId: string) => {
    return gameState.players.find(p => p.id === playerId)
  }, [gameState.players])

  const reorderHand = useCallback((playerId: string, fromIndex: number, toIndex: number) => {
    setGameState(prev => ({
      ...prev,
      players: prev.players.map(p => {
        if (p.id !== playerId) return p
        
        const newHand = [...p.hand]
        const [movedCard] = newHand.splice(fromIndex, 1)
        newHand.splice(toIndex, 0, movedCard)
        
        return { ...p, hand: newHand }
      }),
    }))
  }, [])

  return (
    <GameContext.Provider value={{
      gameState,
      setActivePriorityPlayer,
      passPriority,
      tapMana,
      playCard,
      tapCard,
      untapCard,
      activateAbility,
      declareAttacker,
      clearAttackers,
      setPhase,
      setWaitingForCost,
      clearWaitingForCost,
      triggerHaptic,
      getPlayer,
      reorderHand,
    }}>
      {children}
    </GameContext.Provider>
  )
}

export function useGame() {
  const context = useContext(GameContext)
  if (!context) {
    throw new Error('useGame must be used within a GameProvider')
  }
  return context
}
