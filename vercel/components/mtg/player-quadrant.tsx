"use client"

import { motion } from 'framer-motion'
import { MTGCard } from './mtg-card'
import { cn } from '@/lib/utils'
import type { Player } from '@/lib/mtg/types'

interface PlayerQuadrantProps {
  player: Player
  isActive: boolean
  hasPriority: boolean
  isFocused: boolean
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  waitingForCostSources?: string[]
  onCardClick?: (cardId: string) => void
}

const positionClasses = {
  'top-left': 'col-start-1 row-start-1',
  'top-right': 'col-start-2 row-start-1',
  'bottom-left': 'col-start-1 row-start-2',
  'bottom-right': 'col-start-2 row-start-2',
}

export function PlayerQuadrant({
  player,
  isActive,
  hasPriority,
  isFocused,
  position,
  waitingForCostSources = [],
  onCardClick,
}: PlayerQuadrantProps) {
  return (
    <motion.div
      layout
      className={cn(
        'relative rounded-xl overflow-hidden',
        positionClasses[position],
        isFocused ? 'z-20' : 'z-10'
      )}
      animate={{
        scale: isFocused ? 1 : 1,
      }}
      transition={{ type: 'spring', stiffness: 200, damping: 25 }}
    >
      {/* Background */}
      <div className={cn(
        'absolute inset-0 transition-colors duration-300',
        hasPriority 
          ? 'bg-gradient-to-br from-amber-900/40 to-amber-950/60' 
          : 'bg-gradient-to-br from-slate-900/80 to-slate-950/90'
      )} />
      
      {/* Priority Indicator Border */}
      {hasPriority && (
        <motion.div
          className="absolute inset-0 border-4 border-amber-400 rounded-xl pointer-events-none"
          animate={{ opacity: [0.5, 1, 0.5] }}
          transition={{ repeat: Infinity, duration: 1.5 }}
        />
      )}
      
      {/* Active Turn Indicator */}
      {isActive && (
        <div className="absolute top-2 right-2 z-10">
          <motion.div
            className="w-3 h-3 rounded-full bg-green-400"
            animate={{ scale: [1, 1.3, 1] }}
            transition={{ repeat: Infinity, duration: 1 }}
          />
        </div>
      )}
      
      {/* Player Info Header */}
      <div className="relative p-3 flex items-center gap-3 border-b border-white/10">
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-slate-600 to-slate-800 flex items-center justify-center text-lg font-bold text-white">
          {player.name[0]}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-white truncate">{player.name}</h3>
          <div className="flex items-center gap-2 text-sm">
            <span className={cn(
              'font-bold text-lg',
              player.life > 20 ? 'text-green-400' : player.life > 10 ? 'text-amber-400' : 'text-red-400'
            )}>
              {player.life}
            </span>
            <span className="text-slate-400">life</span>
          </div>
        </div>
        <div className="text-sm text-slate-400">
          <div>🃏 {player.hand.length}</div>
          <div>📚 {player.library.length}</div>
        </div>
      </div>
      
      {/* Battlefield */}
      <div className="relative p-3 min-h-[150px]">
        <div className="text-xs text-slate-500 mb-2">Battlefield</div>
        <div className="flex flex-wrap gap-2">
          {player.battlefield.map(card => (
            <MTGCard
              key={card.id}
              id={card.id}
              name={card.name}
              imageUrl={card.imageUrl}
              size="sm"
              isTapped={card.isTapped}
              isAttacking={card.isAttacking}
              isGlowing={waitingForCostSources.includes(card.id)}
              glowColor="#00ffff"
              onClick={() => onCardClick?.(card.id)}
            />
          ))}
        </div>
      </div>
      
      {/* Lands */}
      <div className="relative p-3 border-t border-white/10">
        <div className="text-xs text-slate-500 mb-2">Lands</div>
        <div className="flex flex-wrap gap-1">
          {player.lands.map(land => (
            <MTGCard
              key={land.id}
              id={land.id}
              name={land.name}
              imageUrl={land.imageUrl}
              size="sm"
              isTapped={land.isTapped}
              isGlowing={waitingForCostSources.includes(land.id)}
              glowColor="#00ffff"
              onClick={() => onCardClick?.(land.id)}
            />
          ))}
        </div>
      </div>
    </motion.div>
  )
}
