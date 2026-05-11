"use client"

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { MTGCard } from './mtg-card'
import type { Card } from '@/lib/mtg/types'

interface BattlefieldGridProps {
  cards: Card[]
  onTapCard?: (cardId: string) => void
  onUntapCard?: (cardId: string) => void
  onActivateAbility?: (cardId: string, abilityIndex: number) => void
  onCardSelect?: (card: Card | null) => void
}

export function BattlefieldGrid({ 
  cards, 
  onTapCard, 
  onUntapCard,
  onActivateAbility,
  onCardSelect
}: BattlefieldGridProps) {
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null)
  const [showAbilityMenu, setShowAbilityMenu] = useState(false)
  
  const selectedCard = cards.find(c => c.id === selectedCardId)
  
  const handleSelectCard = (cardId: string | null) => {
    setSelectedCardId(cardId)
    const card = cardId ? cards.find(c => c.id === cardId) : null
    onCardSelect?.(card ?? null)
  }
  
  const handleCardTap = (cardId: string) => {
    const card = cards.find(c => c.id === cardId)
    if (!card) return
    
    if (selectedCardId === cardId) {
      // Double tap - toggle tap state
      if (card.isTapped) {
        onUntapCard?.(cardId)
      } else {
        onTapCard?.(cardId)
      }
      handleSelectCard(null)
    } else {
      handleSelectCard(cardId)
      setShowAbilityMenu(false)
    }
  }
  
  const handleActivateAbility = (abilityIndex: number) => {
    if (selectedCardId) {
      onActivateAbility?.(selectedCardId, abilityIndex)
      setShowAbilityMenu(false)
      handleSelectCard(null)
    }
  }

  // Separate creatures from other permanents
  const creatures = cards.filter(c => c.type === 'creature')
  const otherPermanents = cards.filter(c => c.type !== 'creature')

  return (
    <div className="relative h-full flex flex-col p-3 gap-3">
      {/* Creatures Section */}
      <div className="flex-1 min-h-0">
        <div className="text-xs text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-2">
          <span>Creatures</span>
          <span className="text-slate-600">({creatures.length})</span>
        </div>
        <div className="h-[calc(100%-24px)] overflow-y-auto">
          <div className="grid grid-cols-3 gap-2">
            <AnimatePresence>
              {creatures.map((card) => (
                <motion.div
                  key={card.id}
                  layout
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ 
                    scale: selectedCardId === card.id ? 1.1 : 1, 
                    opacity: 1,
                    rotate: card.isTapped ? 90 : 0,
                  }}
                  exit={{ scale: 0.8, opacity: 0 }}
                  className={`relative cursor-pointer ${
                    selectedCardId === card.id ? 'z-20' : 'z-10'
                  }`}
                  onClick={() => handleCardTap(card.id)}
                >
                  <MTGCard
                    id={card.id}
                    name={card.name}
                    imageUrl={card.imageUrl}
                    size="sm"
                    isTapped={card.isTapped}
                    isAttacking={card.isAttacking}
                    glowColor={selectedCardId === card.id ? '#3b82f6' : undefined}
                  />
                  {/* P/T overlay */}
                  {card.power !== undefined && (
                    <div className="absolute bottom-1 right-1 bg-black/80 text-white text-xs px-1.5 py-0.5 rounded font-bold">
                      {card.power}/{card.toughness}
                    </div>
                  )}
                  {/* Tapped indicator */}
                  {card.isTapped && (
                    <div className="absolute top-1 left-1 bg-amber-500/80 text-white text-[10px] px-1 rounded">
                      TAPPED
                    </div>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      </div>
      
      {/* Other Permanents Section */}
      {otherPermanents.length > 0 && (
        <div className="flex-shrink-0">
          <div className="text-xs text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-2">
            <span>Other Permanents</span>
            <span className="text-slate-600">({otherPermanents.length})</span>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-2">
            {otherPermanents.map((card) => (
              <motion.div
                key={card.id}
                className={`flex-shrink-0 cursor-pointer ${
                  selectedCardId === card.id ? 'z-20' : 'z-10'
                }`}
                animate={{ 
                  scale: selectedCardId === card.id ? 1.1 : 1,
                  rotate: card.isTapped ? 90 : 0,
                }}
                onClick={() => handleCardTap(card.id)}
              >
                <MTGCard
                  id={card.id}
                  name={card.name}
                  imageUrl={card.imageUrl}
                  size="sm"
                  isTapped={card.isTapped}
                  glowColor={selectedCardId === card.id ? '#3b82f6' : undefined}
                />
              </motion.div>
            ))}
          </div>
        </div>
      )}
      
      {/* Selected Card Action Panel */}
      <AnimatePresence>
        {selectedCard && (
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            className="absolute bottom-0 left-0 right-0 bg-slate-900/95 backdrop-blur-sm border-t border-slate-700 p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-white font-semibold truncate">{selectedCard.name}</div>
                <div className="text-slate-400 text-xs">
                  {selectedCard.isTapped ? 'Tapped' : 'Untapped'} 
                  {selectedCard.power !== undefined && ` • ${selectedCard.power}/${selectedCard.toughness}`}
                </div>
              </div>
              
              <div className="flex gap-2">
                {/* Tap/Untap Button */}
                <motion.button
                  whileTap={{ scale: 0.95 }}
                  onClick={() => {
                    if (selectedCard.isTapped) {
                      onUntapCard?.(selectedCard.id)
                    } else {
                      onTapCard?.(selectedCard.id)
                    }
                    handleSelectCard(null)
                  }}
                  className={`px-4 py-2 rounded-lg font-semibold text-sm ${
                    selectedCard.isTapped 
                      ? 'bg-emerald-600 text-white' 
                      : 'bg-amber-600 text-white'
                  }`}
                >
                  {selectedCard.isTapped ? 'UNTAP' : 'TAP'}
                </motion.button>
                
                {/* Activate Ability Button */}
                <motion.button
                  whileTap={{ scale: 0.95 }}
                  onClick={() => setShowAbilityMenu(!showAbilityMenu)}
                  className="px-4 py-2 rounded-lg font-semibold text-sm bg-purple-600 text-white"
                >
                  ABILITIES
                </motion.button>
                
                {/* Cancel */}
                <motion.button
                  whileTap={{ scale: 0.95 }}
                  onClick={() => {
                    handleSelectCard(null)
                    setShowAbilityMenu(false)
                  }}
                  className="px-3 py-2 rounded-lg text-slate-400 text-sm"
                >
                  Cancel
                </motion.button>
              </div>
            </div>
            
            {/* Ability Menu */}
            <AnimatePresence>
              {showAbilityMenu && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="mt-3 overflow-hidden"
                >
                  <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">
                    Activated Abilities
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {/* Mock abilities - in real app, these would come from card data */}
                    <motion.button
                      whileTap={{ scale: 0.95 }}
                      onClick={() => handleActivateAbility(0)}
                      className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm hover:bg-slate-700"
                    >
                      <span className="text-amber-400">T:</span> Add mana
                    </motion.button>
                    <motion.button
                      whileTap={{ scale: 0.95 }}
                      onClick={() => handleActivateAbility(1)}
                      className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm hover:bg-slate-700"
                    >
                      <span className="text-blue-400">{'{2}'}</span>: Draw a card
                    </motion.button>
                    <motion.button
                      whileTap={{ scale: 0.95 }}
                      onClick={() => handleActivateAbility(2)}
                      className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm hover:bg-slate-700"
                    >
                      <span className="text-red-400">{'{R}'}, T:</span> Deal 1 damage
                    </motion.button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
      
      {/* Empty State */}
      {cards.length === 0 && (
        <div className="flex-1 flex items-center justify-center text-slate-500">
          <div className="text-center">
            <div className="text-4xl mb-2 opacity-50">&#9876;</div>
            <div className="text-sm">No permanents on battlefield</div>
          </div>
        </div>
      )}
    </div>
  )
}
