"use client"

import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { Player } from '@/lib/mtg/types'

interface MinimapWidgetProps {
  player: Player
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  hasPriority: boolean
  onClick?: () => void
}

const positionClasses = {
  'top-left': 'top-4 left-4',
  'top-right': 'top-4 right-4',
  'bottom-left': 'bottom-4 left-4',
  'bottom-right': 'bottom-4 right-4',
}

export function MinimapWidget({ player, position, hasPriority, onClick }: MinimapWidgetProps) {
  return (
    <motion.button
      layout
      layoutId={`player-${player.id}`}
      className={cn(
        'absolute z-30 w-48 rounded-xl overflow-hidden backdrop-blur-md',
        'bg-slate-900/80 border border-white/10',
        'hover:border-white/30 transition-colors cursor-pointer',
        positionClasses[position]
      )}
      onClick={onClick}
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 0.8, opacity: 0 }}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.98 }}
    >
      {/* Priority Indicator */}
      {hasPriority && (
        <motion.div
          className="absolute inset-0 border-2 border-amber-400 rounded-xl pointer-events-none"
          animate={{ opacity: [0.5, 1, 0.5] }}
          transition={{ repeat: Infinity, duration: 1.5 }}
        />
      )}
      
      <div className="p-3 flex items-center gap-3">
        {/* Avatar */}
        <div className="w-12 h-12 rounded-full bg-gradient-to-br from-slate-600 to-slate-800 flex items-center justify-center text-xl font-bold text-white flex-shrink-0">
          {player.name[0]}
        </div>
        
        {/* Info */}
        <div className="flex-1 min-w-0 text-left">
          <h4 className="font-semibold text-white text-sm truncate">{player.name}</h4>
          <div className={cn(
            'text-2xl font-bold',
            player.life > 20 ? 'text-green-400' : player.life > 10 ? 'text-amber-400' : 'text-red-400'
          )}>
            {player.life}
          </div>
        </div>
        
        {/* Stats */}
        <div className="text-xs text-slate-400 text-right">
          <div className="flex items-center gap-1 justify-end">
            <span>🃏</span>
            <span>{player.hand.length}</span>
          </div>
          <div className="flex items-center gap-1 justify-end">
            <span>⚔️</span>
            <span>{player.battlefield.length}</span>
          </div>
        </div>
      </div>
    </motion.button>
  )
}
