"use client"

import { motion, AnimatePresence } from 'framer-motion'
import type { AttackDeclaration, Player } from '@/lib/mtg/types'

interface AttackOverlayProps {
  isVisible: boolean
  attacks: AttackDeclaration[]
  attackerName: string
  onDismiss: () => void
}

export function AttackOverlay({ isVisible, attacks, attackerName, onDismiss }: AttackOverlayProps) {
  const totalDamage = attacks.length * 3 // Placeholder damage calculation
  
  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {/* Dark Overlay */}
          <motion.div
            className="absolute inset-0 bg-black/80"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            onClick={onDismiss}
          />
          
          {/* Alert Content */}
          <motion.div
            className="relative z-10 max-w-md w-full mx-4"
            initial={{ scale: 0.5, y: 50 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.5, y: 50 }}
            transition={{ type: 'spring', stiffness: 300, damping: 20 }}
          >
            {/* Glowing Border */}
            <motion.div
              className="absolute inset-0 rounded-2xl bg-gradient-to-r from-red-500 via-orange-500 to-red-500"
              animate={{
                backgroundPosition: ['0% 50%', '100% 50%', '0% 50%'],
              }}
              transition={{ repeat: Infinity, duration: 2 }}
              style={{ padding: '3px' }}
            >
              <div className="w-full h-full rounded-2xl bg-slate-950" />
            </motion.div>
            
            {/* Content */}
            <div className="relative p-6 rounded-2xl">
              {/* Warning Icon */}
              <motion.div
                className="text-center mb-4"
                animate={{ scale: [1, 1.2, 1] }}
                transition={{ repeat: Infinity, duration: 0.5 }}
              >
                <span className="text-6xl">⚔️</span>
              </motion.div>
              
              {/* Title */}
              <motion.h2
                className="text-3xl font-bold text-center text-red-500 mb-2"
                animate={{ 
                  textShadow: [
                    '0 0 10px rgba(239, 68, 68, 0.5)',
                    '0 0 20px rgba(239, 68, 68, 0.8)',
                    '0 0 10px rgba(239, 68, 68, 0.5)',
                  ]
                }}
                transition={{ repeat: Infinity, duration: 1 }}
              >
                INCOMING ATTACK!
              </motion.h2>
              
              {/* Attacker Info */}
              <p className="text-center text-slate-300 mb-4">
                <span className="font-semibold text-white">{attackerName}</span> is attacking you!
              </p>
              
              {/* Attack Details */}
              <div className="bg-red-950/30 rounded-xl p-4 mb-4 border border-red-800/50">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-slate-400">Attackers:</span>
                  <span className="text-white font-bold">{attacks.length} creatures</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-400">Potential Damage:</span>
                  <span className="text-red-400 font-bold text-xl">{totalDamage}</span>
                </div>
              </div>
              
              {/* Dismiss Button */}
              <motion.button
                className="w-full py-4 rounded-xl bg-gradient-to-r from-red-600 to-orange-600 text-white font-bold text-lg"
                onClick={onDismiss}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                DECLARE BLOCKERS
              </motion.button>
            </div>
          </motion.div>
          
          {/* Screen shake effect */}
          <motion.div
            className="fixed inset-0 pointer-events-none"
            animate={{
              x: [0, -5, 5, -5, 5, 0],
              y: [0, 5, -5, 5, -5, 0],
            }}
            transition={{ duration: 0.5 }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
