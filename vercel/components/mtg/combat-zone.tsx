"use client"

import { motion, AnimatePresence } from 'framer-motion'
import { MTGCard } from './mtg-card'
import type { Card, AttackDeclaration } from '@/lib/mtg/types'

interface CombatZoneProps {
  attackers: AttackDeclaration[]
  attackerCards: Card[]
  isActive: boolean
}

export function CombatZone({ attackers, attackerCards, isActive }: CombatZoneProps) {
  return (
    <AnimatePresence>
      {isActive && attackers.length > 0 && (
        <motion.div
          className="absolute inset-x-0 top-1/2 -translate-y-1/2 z-40"
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
        >
          {/* Combat Zone Container */}
          <div className="mx-auto max-w-2xl">
            {/* Title */}
            <motion.div
              className="text-center mb-4"
              initial={{ y: -20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.2 }}
            >
              <span className="px-6 py-2 rounded-full bg-red-500/20 border border-red-500/50 text-red-400 font-bold text-lg">
                ⚔️ COMBAT ZONE ⚔️
              </span>
            </motion.div>
            
            {/* Attackers */}
            <motion.div
              className="flex justify-center gap-4 p-6 rounded-2xl bg-gradient-to-b from-red-950/40 to-slate-950/60 border border-red-500/30"
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.3 }}
            >
              {attackerCards.map((card, index) => (
                <motion.div
                  key={card.id}
                  initial={{ x: -100, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  transition={{ delay: 0.4 + index * 0.1 }}
                >
                  <MTGCard
                    id={`combat-${card.id}`}
                    name={card.name}
                    imageUrl={card.imageUrl}
                    size="md"
                    isAttacking={true}
                  />
                </motion.div>
              ))}
            </motion.div>
            
            {/* Pulsing Border Effect */}
            <motion.div
              className="absolute inset-0 rounded-2xl border-2 border-red-500 pointer-events-none"
              style={{ top: '2rem' }}
              animate={{
                boxShadow: [
                  '0 0 20px rgba(239, 68, 68, 0.3)',
                  '0 0 40px rgba(239, 68, 68, 0.5)',
                  '0 0 20px rgba(239, 68, 68, 0.3)',
                ],
              }}
              transition={{ repeat: Infinity, duration: 2 }}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
