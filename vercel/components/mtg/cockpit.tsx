"use client"

import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { Card } from '@/lib/mtg/types'

interface CockpitProps {
  hasPriority: boolean
  onPassPriority: () => void
  commanderZone: Card[]
  graveyard: Card[]
  onOpenCommander: () => void
  onOpenGraveyard: () => void
}

export function Cockpit({
  hasPriority,
  onPassPriority,
  commanderZone,
  graveyard,
  onOpenCommander,
  onOpenGraveyard,
}: CockpitProps) {
  return (
    <div className="h-full flex flex-col p-3 gap-3">
      {/* Section Title */}
      <div className="text-xs text-slate-400 font-semibold uppercase tracking-wider">
        The Cockpit
      </div>
      
      {/* Pass Priority Button - Large and Prominent */}
      <motion.button
        className={cn(
          'flex-1 rounded-2xl font-bold text-xl transition-colors',
          'flex flex-col items-center justify-center gap-2',
          'border-4',
          hasPriority
            ? 'bg-gradient-to-br from-amber-500 to-orange-600 border-amber-400 text-white'
            : 'bg-slate-800 border-slate-600 text-slate-400'
        )}
        onClick={onPassPriority}
        whileHover={{ scale: hasPriority ? 1.02 : 1 }}
        whileTap={{ scale: 0.95 }}
        disabled={!hasPriority}
        animate={hasPriority ? {
          boxShadow: [
            '0 0 20px rgba(245, 158, 11, 0.5)',
            '0 0 40px rgba(245, 158, 11, 0.8)',
            '0 0 20px rgba(245, 158, 11, 0.5)',
          ]
        } : {}}
        transition={hasPriority ? { repeat: Infinity, duration: 1.5 } : {}}
      >
        <span className="text-3xl">
          {hasPriority ? '✓' : '⏸'}
        </span>
        <span>
          {hasPriority ? 'PASS PRIORITY' : 'Waiting...'}
        </span>
        
        {/* Priority indicator pulse */}
        <AnimatePresence>
          {hasPriority && (
            <motion.div
              className="absolute inset-0 rounded-2xl border-4 border-amber-300"
              initial={{ scale: 0.8, opacity: 1 }}
              animate={{ scale: 1.1, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ repeat: Infinity, duration: 1 }}
            />
          )}
        </AnimatePresence>
      </motion.button>
      
      {/* Zone Buttons */}
      <div className="flex gap-2">
        {/* Commander Zone */}
        <motion.button
          className="flex-1 p-3 rounded-xl bg-gradient-to-br from-purple-900/80 to-purple-950/80 border border-purple-700/50 flex flex-col items-center gap-1"
          onClick={onOpenCommander}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <div className="w-10 h-14 rounded-lg bg-purple-800/50 border border-purple-600/50 flex items-center justify-center">
            <span className="text-xl">👑</span>
          </div>
          <span className="text-xs text-purple-300">Commander</span>
          <span className="text-xs text-purple-500">{commanderZone.length}</span>
        </motion.button>
        
        {/* Graveyard */}
        <motion.button
          className="flex-1 p-3 rounded-xl bg-gradient-to-br from-slate-800/80 to-slate-900/80 border border-slate-600/50 flex flex-col items-center gap-1"
          onClick={onOpenGraveyard}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <div className="w-10 h-14 rounded-lg bg-slate-700/50 border border-slate-500/50 flex items-center justify-center">
            <span className="text-xl">💀</span>
          </div>
          <span className="text-xs text-slate-300">Graveyard</span>
          <span className="text-xs text-slate-500">{graveyard.length}</span>
        </motion.button>
      </div>
    </div>
  )
}
