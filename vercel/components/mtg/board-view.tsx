"use client"

import { useState, useMemo, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useGame } from '@/lib/mtg/game-context'
import { PlayerQuadrant } from './player-quadrant'
import { MinimapWidget } from './minimap-widget'
import { CombatZone } from './combat-zone'
import { CombatArrows } from './combat-arrows'
import { EnergyBeam } from './energy-beam'
import type { Card } from '@/lib/mtg/types'

const quadrantPositions = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const

export function BoardView() {
  const { gameState, setActivePriorityPlayer, setWaitingForCost, clearWaitingForCost } = useGame()
  const [cardPositions, setCardPositions] = useState<Map<string, { x: number; y: number }>>(new Map())
  const [playerPositions, setPlayerPositions] = useState<Map<string, { x: number; y: number }>>(new Map())
  const [selectedCostSource, setSelectedCostSource] = useState<{ x: number; y: number } | null>(null)
  const [activatedCardPos, setActivatedCardPos] = useState<{ x: number; y: number } | null>(null)
  const boardRef = useRef<HTMLDivElement>(null)
  
  const { activePriorityPlayerId, phase, combatZone, waitingForCost, players, priorityPlayerId, activePlayerId } = gameState
  
  // Get focused player
  const focusedPlayer = activePriorityPlayerId 
    ? players.find(p => p.id === activePriorityPlayerId) 
    : null
  
  // Get non-focused players for minimap
  const minimapPlayers = activePriorityPlayerId
    ? players.filter(p => p.id !== activePriorityPlayerId)
    : []
  
  // Get attacker cards for combat zone
  const attackerCards: Card[] = useMemo(() => {
    return combatZone.attackers.map(attack => {
      const player = players.find(p => p.id === attack.attackerId)
      return player?.battlefield.find(c => c.id === attack.attackerCardId)
    }).filter((card): card is Card => !!card)
  }, [combatZone.attackers, players])
  
  // Check if we're in combat
  const inCombat = phase === 'DECLARE_ATTACKERS' || phase === 'DECLARE_BLOCKERS' || phase === 'COMBAT_DAMAGE'
  
  // Update player positions for combat arrows
  useEffect(() => {
    if (!boardRef.current) return
    
    const newPositions = new Map<string, { x: number; y: number }>()
    players.forEach((player, index) => {
      const pos = quadrantPositions[index]
      const rect = boardRef.current!.getBoundingClientRect()
      
      // Calculate center of each quadrant
      const x = pos.includes('left') ? rect.width * 0.25 : rect.width * 0.75
      const y = pos.includes('top') ? rect.height * 0.25 : rect.height * 0.75
      
      newPositions.set(player.id, { x, y })
    })
    setPlayerPositions(newPositions)
  }, [players])
  
  const handleCardClick = (cardId: string) => {
    if (waitingForCost && waitingForCost.validSources.includes(cardId)) {
      // Simulate selecting a mana source
      const rect = boardRef.current?.getBoundingClientRect()
      if (rect) {
        setSelectedCostSource({ x: rect.width / 2, y: rect.height / 2 })
        setActivatedCardPos({ x: rect.width / 2 - 100, y: rect.height / 3 })
        
        setTimeout(() => {
          setSelectedCostSource(null)
          setActivatedCardPos(null)
          clearWaitingForCost()
        }, 2000)
      }
    }
  }
  
  // Demo: cycle through players on click
  const handlePlayerFocus = (playerId: string) => {
    setActivePriorityPlayer(activePriorityPlayerId === playerId ? null : playerId)
  }

  return (
    <div 
      ref={boardRef}
      className="relative w-full h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 overflow-hidden"
    >
      {/* Background Pattern */}
      <div className="absolute inset-0 opacity-5">
        <div 
          className="w-full h-full"
          style={{
            backgroundImage: 'radial-gradient(circle at 2px 2px, white 1px, transparent 0)',
            backgroundSize: '40px 40px',
          }}
        />
      </div>
      
      {/* Phase Indicator */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50">
        <motion.div
          className="px-6 py-2 rounded-full bg-slate-800/80 backdrop-blur-sm border border-slate-700 text-white font-semibold"
          layout
        >
          Turn {gameState.turn} • {phase.replace('_', ' ')}
        </motion.div>
      </div>
      
      {/* Main Grid / Focus Mode */}
      <AnimatePresence mode="wait">
        {activePriorityPlayerId && focusedPlayer ? (
          // Focus Mode - One player expanded
          <motion.div
            key="focus-mode"
            className="absolute inset-8 top-16"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {/* Focused Player Quadrant (70% of viewport) */}
            <motion.div
              className="w-full h-full"
              layout
              initial={{ scale: 0.8 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 200, damping: 25 }}
            >
              <PlayerQuadrant
                player={focusedPlayer}
                isActive={activePlayerId === focusedPlayer.id}
                hasPriority={priorityPlayerId === focusedPlayer.id}
                isFocused={true}
                position="top-left"
                waitingForCostSources={waitingForCost?.validSources}
                onCardClick={handleCardClick}
              />
            </motion.div>
            
            {/* Minimap Widgets */}
            {minimapPlayers.map((player, index) => {
              const positions = ['top-right', 'bottom-left', 'bottom-right'] as const
              return (
                <MinimapWidget
                  key={player.id}
                  player={player}
                  position={positions[index]}
                  hasPriority={priorityPlayerId === player.id}
                  onClick={() => handlePlayerFocus(player.id)}
                />
              )
            })}
          </motion.div>
        ) : (
          // Full Grid Mode - All four quadrants
          <motion.div
            key="grid-mode"
            className="absolute inset-8 top-16 grid grid-cols-2 grid-rows-2 gap-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{ 
              transform: inCombat ? 'scale(0.9)' : 'scale(1)',
              transition: 'transform 0.5s ease'
            }}
          >
            {players.map((player, index) => (
              <motion.div
                key={player.id}
                layoutId={`player-${player.id}`}
                className="cursor-pointer"
                onClick={() => handlePlayerFocus(player.id)}
              >
                <PlayerQuadrant
                  player={player}
                  isActive={activePlayerId === player.id}
                  hasPriority={priorityPlayerId === player.id}
                  isFocused={false}
                  position={quadrantPositions[index]}
                  waitingForCostSources={waitingForCost?.validSources}
                  onCardClick={handleCardClick}
                />
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      
      {/* Combat Zone */}
      <CombatZone
        attackers={combatZone.attackers}
        attackerCards={attackerCards}
        isActive={inCombat}
      />
      
      {/* Combat Arrows */}
      {inCombat && combatZone.attackers.length > 0 && (
        <CombatArrows
          attacks={combatZone.attackers}
          cardPositions={cardPositions}
          playerPositions={playerPositions}
        />
      )}
      
      {/* Energy Beam for Mana Cost */}
      {selectedCostSource && activatedCardPos && (
        <EnergyBeam
          fromX={selectedCostSource.x}
          fromY={selectedCostSource.y}
          toX={activatedCardPos.x}
          toY={activatedCardPos.y}
        />
      )}
      
      {/* Demo Controls */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2 z-50">
        <button
          className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-sm transition-colors"
          onClick={() => setActivePriorityPlayer(activePriorityPlayerId ? null : 'p1')}
        >
          Toggle Focus Mode
        </button>
        <button
          className="px-4 py-2 rounded-lg bg-red-800 hover:bg-red-700 text-white text-sm transition-colors"
          onClick={() => {
            const { declareAttacker, clearAttackers, setPhase } = useGame.prototype
          }}
        >
          Demo Combat
        </button>
        <button
          className="px-4 py-2 rounded-lg bg-cyan-800 hover:bg-cyan-700 text-white text-sm transition-colors"
          onClick={() => {
            if (waitingForCost) {
              clearWaitingForCost()
            } else {
              setWaitingForCost('demo-card', ['p1-land-0', 'p1-land-1', 'p1-land-2'])
            }
          }}
        >
          Toggle Mana Cost Mode
        </button>
      </div>
    </div>
  )
}
