"use client"

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { GameProvider } from '@/lib/mtg/game-context'
import { BoardView } from '@/components/mtg/board-view'
import { ControllerView } from '@/components/mtg/controller-view'

type ViewMode = 'board' | 'controller'

export default function MTGPage() {
  const [viewMode, setViewMode] = useState<ViewMode>('board')
  const [selectedPlayer, setSelectedPlayer] = useState('p1')

  return (
    <GameProvider>
      <div className="min-h-screen bg-slate-950">
        {/* View Toggle */}
        <div className="fixed top-4 right-4 z-50 flex gap-2 bg-slate-900/90 backdrop-blur-sm rounded-xl p-1 border border-slate-700">
          <motion.button
            className={`px-4 py-2 rounded-lg font-medium text-sm transition-colors ${
              viewMode === 'board'
                ? 'bg-slate-700 text-white'
                : 'text-slate-400 hover:text-white'
            }`}
            onClick={() => setViewMode('board')}
            whileTap={{ scale: 0.95 }}
          >
            🖥️ Board View
          </motion.button>
          <motion.button
            className={`px-4 py-2 rounded-lg font-medium text-sm transition-colors ${
              viewMode === 'controller'
                ? 'bg-slate-700 text-white'
                : 'text-slate-400 hover:text-white'
            }`}
            onClick={() => setViewMode('controller')}
            whileTap={{ scale: 0.95 }}
          >
            📱 Controller View
          </motion.button>
        </div>

        {/* Player Selector (for Controller View) */}
        {viewMode === 'controller' && (
          <div className="fixed top-4 left-4 z-50 flex gap-2 bg-slate-900/90 backdrop-blur-sm rounded-xl p-1 border border-slate-700">
            {['p1', 'p2', 'p3', 'p4'].map((id, index) => (
              <motion.button
                key={id}
                className={`w-10 h-10 rounded-lg font-bold text-sm flex items-center justify-center transition-colors ${
                  selectedPlayer === id
                    ? 'bg-amber-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
                onClick={() => setSelectedPlayer(id)}
                whileTap={{ scale: 0.95 }}
              >
                P{index + 1}
              </motion.button>
            ))}
          </div>
        )}

        {/* Main Content */}
        <AnimatePresence mode="wait">
          {viewMode === 'board' ? (
            <motion.div
              key="board"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.3 }}
            >
              <BoardView />
            </motion.div>
          ) : (
            <motion.div
              key="controller"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.3 }}
            >
              <ControllerView playerId={selectedPlayer} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Instructions */}
        <div className="fixed bottom-4 left-4 z-50 max-w-sm bg-slate-900/90 backdrop-blur-sm rounded-xl p-4 border border-slate-700 text-sm text-slate-300">
          <h3 className="font-semibold text-white mb-2">Demo Controls</h3>
          {viewMode === 'board' ? (
            <ul className="space-y-1 text-xs">
              <li>• Click a player quadrant to enter <strong>Focus Mode</strong></li>
              <li>• Use &quot;Toggle Focus Mode&quot; button to switch views</li>
              <li>• &quot;Toggle Mana Cost Mode&quot; shows glowing valid mana sources</li>
              <li>• Priority indicator shows amber border</li>
            </ul>
          ) : (
            <ul className="space-y-1 text-xs">
              <li>• <strong>Left:</strong> Tap mana orbs or lands</li>
              <li>• <strong>Center:</strong> Flick cards up to play them</li>
              <li>• <strong>Right:</strong> Pass priority or access zones</li>
              <li>• Use P1-P4 buttons to switch controller</li>
            </ul>
          )}
        </div>
      </div>
    </GameProvider>
  )
}
