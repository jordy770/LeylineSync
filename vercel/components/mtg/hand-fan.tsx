"use client"

import { useState, useRef, useCallback } from 'react'
import { motion, AnimatePresence, PanInfo } from 'framer-motion'
import { MTGCard } from './mtg-card'
import type { Card } from '@/lib/mtg/types'

interface HandFanProps {
  cards: Card[]
  onPlayCard?: (cardId: string) => void
  onCardSelect?: (card: Card | null) => void
  onReorder?: (fromIndex: number, toIndex: number) => void
}

export function HandFan({ cards, onPlayCard, onCardSelect, onReorder }: HandFanProps) {
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null)
  const [playedCardId, setPlayedCardId] = useState<string | null>(null)
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null)
  const [dragX, setDragX] = useState(0)
  const [dragY, setDragY] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  
  const handleCardSelect = (cardId: string | null) => {
    setSelectedCardId(cardId)
    const card = cardId ? cards.find(c => c.id === cardId) : null
    onCardSelect?.(card ?? null)
  }
  
  const totalCards = cards.length
  const fanAngle = Math.min(totalCards * 3, 20) // Much flatter: max 20 degree spread, 3 degrees per card
  const startAngle = -fanAngle / 2
  const cardSpread = 85 // Horizontal spread between cards in pixels
  
  // Calculate the fan position for each card
  const getCardFanPosition = useCallback((index: number) => {
    const angle = startAngle + (index / Math.max(totalCards - 1, 1)) * fanAngle
    // Horizontal offset from center
    const centerOffset = (index - (totalCards - 1) / 2) * cardSpread
    return { angle, centerOffset, index }
  }, [startAngle, fanAngle, totalCards, cardSpread])
  
  // Calculate which position the dragged card should swap to based on drag offset
  const getTargetIndex = useCallback((currentIndex: number, dragOffsetX: number) => {
    // Estimate card spacing - roughly 60-80px per card position
    const cardSpacing = 70
    const positionsToMove = Math.round(dragOffsetX / cardSpacing)
    const targetIndex = Math.max(0, Math.min(totalCards - 1, currentIndex + positionsToMove))
    return targetIndex
  }, [totalCards])
  
  const handleDragStart = (cardId: string) => {
    setDraggingCardId(cardId)
    setSelectedCardId(null)
    onCardSelect?.(null)
  }
  
  const handleDrag = (cardId: string, info: PanInfo) => {
    if (draggingCardId === cardId) {
      setDragX(info.offset.x)
      // Gradually lift the card as you drag (negative Y = up)
      setDragY(Math.min(0, info.offset.y * 0.3 - 20))
    }
  }
  
  const handleDragEnd = (cardId: string, cardIndex: number, info: PanInfo) => {
    const { offset, velocity } = info
    
    // Flick-to-play: If dragged up with enough velocity or distance
    if (offset.y < -100 || velocity.y < -500) {
      setPlayedCardId(cardId)
      onPlayCard?.(cardId)
      setTimeout(() => setPlayedCardId(null), 500)
    } else {
      // Check for horizontal reorder
      const targetIndex = getTargetIndex(cardIndex, offset.x)
      if (targetIndex !== cardIndex && onReorder) {
        onReorder(cardIndex, targetIndex)
      }
    }
    
    setDraggingCardId(null)
    setDragX(0)
    setDragY(0)
  }

  // Calculate display order considering drag state
  const getDisplayPosition = (cardIndex: number) => {
    if (!draggingCardId) return cardIndex
    
    const draggingIndex = cards.findIndex(c => c.id === draggingCardId)
    if (draggingIndex === -1) return cardIndex
    
    const targetIndex = getTargetIndex(draggingIndex, dragX)
    
    // The dragging card itself stays at its original visual position (will animate back)
    if (cardIndex === draggingIndex) return cardIndex
    
    // Shift other cards to make room
    if (draggingIndex < targetIndex) {
      // Dragging right: cards between original and target shift left
      if (cardIndex > draggingIndex && cardIndex <= targetIndex) {
        return cardIndex - 1
      }
    } else if (draggingIndex > targetIndex) {
      // Dragging left: cards between target and original shift right
      if (cardIndex >= targetIndex && cardIndex < draggingIndex) {
        return cardIndex + 1
      }
    }
    
    return cardIndex
  }

  return (
    <div ref={containerRef} className="relative h-full flex items-end justify-center pb-4">
      {/* Play Zone Indicator */}
      <motion.div
        className="absolute top-4 left-1/2 -translate-x-1/2 px-8 py-2 rounded-full border-2 border-dashed border-emerald-500/30 text-emerald-500/50 text-sm"
        animate={{ 
          borderColor: selectedCardId ? 'rgba(16, 185, 129, 0.8)' : 'rgba(16, 185, 129, 0.3)',
          color: selectedCardId ? 'rgba(16, 185, 129, 1)' : 'rgba(16, 185, 129, 0.5)',
        }}
      >
        Flick to Play
      </motion.div>
      
      {/* Card Fan */}
      <div className="relative h-52 w-full flex items-end justify-center">
        <AnimatePresence>
          {cards.map((card, index) => {
            const displayPosition = getDisplayPosition(index)
            const { angle, centerOffset } = getCardFanPosition(displayPosition)
            const isSelected = selectedCardId === card.id
            const isPlayed = playedCardId === card.id
            const isDragging = draggingCardId === card.id
            
            return (
              <motion.div
                key={card.id}
                className="absolute origin-bottom cursor-grab active:cursor-grabbing"
                style={{
                  zIndex: isDragging ? 100 : isSelected ? 50 : index,
                }}
                initial={{ x: centerOffset, y: 100, opacity: 0, rotate: angle }}
                animate={{
                  x: isDragging ? centerOffset + dragX : centerOffset,
                  y: isDragging ? dragY - 50 : isSelected ? -60 : -20,
                  scale: isDragging ? 1.15 : isSelected ? 1.15 : 1,
                  opacity: isPlayed ? 0 : 1,
                  rotate: isDragging ? 0 : angle,
                  boxShadow: isDragging 
                    ? '0 25px 50px rgba(0,0,0,0.5)' 
                    : '0 4px 8px rgba(0,0,0,0.2)',
                }}
                exit={{ y: -200, opacity: 0 }}
                transition={{ 
                  type: 'spring', 
                  stiffness: isDragging ? 400 : 300, 
                  damping: isDragging ? 30 : 25 
                }}
                drag
                dragConstraints={{ top: 0, bottom: 0, left: 0, right: 0 }}
                dragElastic={1}
                onDragStart={() => handleDragStart(card.id)}
                onDrag={(_, info) => handleDrag(card.id, info)}
                onDragEnd={(_, info) => handleDragEnd(card.id, index, info)}
                onTap={() => {
                  if (!isDragging) {
                    handleCardSelect(isSelected ? null : card.id)
                  }
                }}
                whileTap={{ scale: 1.05 }}
              >
                <MTGCard
                  id={card.id}
                  name={card.name}
                  imageUrl={card.imageUrl}
                  size="lg"
                />
                
                {/* Drag indicator overlay */}
                {isDragging && (
                  <motion.div
                    className="absolute inset-0 rounded-lg border-2 border-blue-500 bg-blue-500/10 pointer-events-none"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  />
                )}
              </motion.div>
            )
          })}
        </AnimatePresence>
        
        {/* Drop zone indicators while dragging */}
        {draggingCardId && (
          <div className="absolute bottom-0 left-0 right-0 h-2 flex justify-center gap-2 pointer-events-none">
            {cards.map((_, index) => {
              const draggingIndex = cards.findIndex(c => c.id === draggingCardId)
              const targetIndex = getTargetIndex(draggingIndex, dragX)
              const isTarget = index === targetIndex && index !== draggingIndex
              
              return (
                <motion.div
                  key={index}
                  className={`w-8 h-1 rounded-full transition-colors ${
                    isTarget ? 'bg-blue-500' : 'bg-slate-600/50'
                  }`}
                  animate={{ scale: isTarget ? 1.5 : 1 }}
                />
              )
            })}
          </div>
        )}
      </div>
      
      {/* Card Count & Reorder Hint */}
      <div className="absolute bottom-2 right-4 text-slate-400 text-sm">
        {cards.length} cards in hand
      </div>
      <div className="absolute bottom-2 left-4 text-slate-500 text-xs">
        Drag horizontally to reorder
      </div>
    </div>
  )
}
