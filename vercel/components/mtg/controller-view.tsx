"use client"

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useGame } from '@/lib/mtg/game-context'
import { ManaEconomy } from './mana-economy'
import { HandFan } from './hand-fan'
import { BattlefieldGrid } from './battlefield-grid'
import { Cockpit } from './cockpit'
import { AttackOverlay } from './attack-overlay'
import { CardPreview } from './card-preview'
import type { ManaColor, Card } from '@/lib/mtg/types'

interface ControllerViewProps {
  playerId: string
}

type CenterView = 'hand' | 'battlefield'

export function ControllerView({ playerId }: ControllerViewProps) {
  const { gameState, tapMana, playCard, tapCard, untapCard, activateAbility, passPriority, triggerHaptic, getPlayer, reorderHand } = useGame()
  const [showAttackOverlay, setShowAttackOverlay] = useState(false)
  const [commanderOpen, setCommanderOpen] = useState(false)
  const [graveyardOpen, setGraveyardOpen] = useState(false)
  const [centerView, setCenterView] = useState<CenterView>('hand')
  const [previewCard, setPreviewCard] = useState<Card | null>(null)
  
  const player = getPlayer(playerId)
  const hasPriority = gameState.priorityPlayerId === playerId
  const isBeingAttacked = gameState.combatZone.attackers.some(a => a.targetPlayerId === playerId)
  
  // Show attack overlay when being attacked
  useEffect(() => {
    if (isBeingAttacked && gameState.phase === 'DECLARE_ATTACKERS') {
      setShowAttackOverlay(true)
      triggerHaptic('attack')
    }
  }, [isBeingAttacked, gameState.phase, triggerHaptic])
  
  // Haptic on priority change
  useEffect(() => {
    if (hasPriority) {
      triggerHaptic('priority')
    }
  }, [hasPriority, triggerHaptic])
  
  if (!player) {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-950 text-white">
        Player not found
      </div>
    )
  }
  
  const handleTapMana = (color: ManaColor) => {
    tapMana(playerId, color)
  }
  
  const handleTapLand = (landId: string) => {
    // Find the land and determine its color
    const land = player.lands.find(l => l.id === landId)
    if (land && !land.isTapped) {
      // Simplified: tap for generic mana
      tapMana(playerId, 'C')
    }
  }
  
  const handlePlayCard = (cardId: string) => {
    playCard(playerId, cardId)
  }
  
  const handleTapCard = (cardId: string) => {
    tapCard(playerId, cardId)
  }
  
  const handleUntapCard = (cardId: string) => {
    untapCard(playerId, cardId)
  }
  
  const handleActivateAbility = (cardId: string, abilityIndex: number) => {
    activateAbility(playerId, cardId, abilityIndex)
  }
  
  const handleCardSelect = (card: Card | null) => {
    setPreviewCard(card)
  }
  
  const handleReorderHand = (fromIndex: number, toIndex: number) => {
    reorderHand(playerId, fromIndex, toIndex)
  }
  
  const handlePassPriority = () => {
    passPriority(playerId)
  }

  return (
    <div className="h-screen w-screen bg-gradient-to-b from-slate-900 to-slate-950 overflow-hidden">
      {/* Landscape Layout - Three Columns */}
      <div className="h-full grid grid-cols-[1fr_2fr_1fr]">
        {/* Left Column - The Economy */}
        <div className="border-r border-slate-800/50 bg-slate-900/50">
          <ManaEconomy
            manaPool={player.manaPool}
            lands={player.lands}
            onTapMana={handleTapMana}
            onTapLand={handleTapLand}
            glowingSources={gameState.waitingForCost?.validSources}
          />
        </div>
        
        {/* Middle Column - Hand or Battlefield */}
        <div 
          className="relative bg-gradient-to-b from-slate-800/30 to-slate-900/50"
          onClick={() => previewCard && setPreviewCard(null)}
        >
          {/* Card Preview Overlay */}
          <CardPreview
            card={previewCard}
            onClose={() => setPreviewCard(null)}
            position="center"
          />
          {/* Player Info Bar with View Toggle */}
          <motion.div
            className="absolute top-0 inset-x-0 h-14 flex items-center justify-between px-4 bg-slate-900/80 backdrop-blur-sm border-b border-slate-700/50 z-10"
            animate={hasPriority ? {
              backgroundColor: ['rgba(15, 23, 42, 0.8)', 'rgba(120, 53, 15, 0.3)', 'rgba(15, 23, 42, 0.8)'],
            } : {}}
            transition={hasPriority ? { repeat: Infinity, duration: 2 } : {}}
          >
            {/* Left: Player Info */}
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-slate-600 to-slate-800 flex items-center justify-center text-sm font-bold text-white">
                {player.name[0]}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-2xl font-bold text-white">{player.life}</span>
                <span className="text-slate-500 text-xs">life</span>
              </div>
              {hasPriority && (
                <motion.div
                  className="px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/50 text-amber-400 text-xs font-semibold"
                  animate={{ opacity: [1, 0.5, 1] }}
                  transition={{ repeat: Infinity, duration: 1 }}
                >
                  PRIORITY
                </motion.div>
              )}
            </div>
            
            {/* Center: View Toggle */}
            <div className="flex items-center bg-slate-800/80 rounded-lg p-1 border border-slate-700/50">
              <motion.button
                whileTap={{ scale: 0.95 }}
                onClick={() => setCenterView('hand')}
                className={`px-4 py-1.5 rounded-md text-sm font-semibold transition-colors ${
                  centerView === 'hand'
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Hand ({player.hand.length})
              </motion.button>
              <motion.button
                whileTap={{ scale: 0.95 }}
                onClick={() => setCenterView('battlefield')}
                className={`px-4 py-1.5 rounded-md text-sm font-semibold transition-colors ${
                  centerView === 'battlefield'
                    ? 'bg-emerald-600 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Board ({player.battlefield.length})
              </motion.button>
            </div>
            
            {/* Right: Phase Info */}
            <div className="text-right">
              <div className="text-slate-400 text-xs uppercase tracking-wider">
                {gameState.phase.replace(/_/g, ' ')}
              </div>
              <div className="text-slate-500 text-xs">
                Turn {gameState.turn}
              </div>
            </div>
          </motion.div>
          
          {/* Content Area - Hand or Battlefield */}
          <div className="h-full pt-14">
            <AnimatePresence mode="wait">
              {centerView === 'hand' ? (
                <motion.div
                  key="hand"
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  className="h-full"
                >
                  <HandFan
                    cards={player.hand}
                    onPlayCard={handlePlayCard}
                    onCardSelect={handleCardSelect}
                    onReorder={handleReorderHand}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="battlefield"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="h-full"
                >
                  <BattlefieldGrid
                    cards={player.battlefield}
                    onTapCard={handleTapCard}
                    onUntapCard={handleUntapCard}
                    onActivateAbility={handleActivateAbility}
                    onCardSelect={handleCardSelect}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
        
        {/* Right Column - The Cockpit */}
        <div className="border-l border-slate-800/50 bg-slate-900/50">
          <Cockpit
            hasPriority={hasPriority}
            onPassPriority={handlePassPriority}
            commanderZone={player.commanderZone}
            graveyard={player.graveyard}
            onOpenCommander={() => setCommanderOpen(true)}
            onOpenGraveyard={() => setGraveyardOpen(true)}
          />
        </div>
      </div>
      
      {/* Attack Overlay */}
      <AttackOverlay
        isVisible={showAttackOverlay}
        attacks={gameState.combatZone.attackers.filter(a => a.targetPlayerId === playerId)}
        attackerName={
          gameState.combatZone.attackers[0]
            ? getPlayer(gameState.combatZone.attackers[0].attackerId)?.name || 'Unknown'
            : 'Unknown'
        }
        onDismiss={() => setShowAttackOverlay(false)}
      />
      
      {/* Orientation Lock Reminder */}
      <div className="hidden portrait:flex fixed inset-0 bg-slate-950 items-center justify-center z-50">
        <div className="text-center text-white p-8">
          <motion.div
            className="text-6xl mb-4"
            animate={{ rotate: [0, 90, 0] }}
            transition={{ repeat: Infinity, duration: 2 }}
          >
            📱
          </motion.div>
          <h2 className="text-2xl font-bold mb-2">Rotate Your Device</h2>
          <p className="text-slate-400">Please use landscape mode for the best experience</p>
        </div>
      </div>
    </div>
  )
}
