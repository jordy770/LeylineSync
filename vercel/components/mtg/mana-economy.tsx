"use client"

import { motion } from 'framer-motion'
import { ManaOrb } from './mana-orb'
import { MTGCard } from './mtg-card'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { ManaPool, Card, ManaColor } from '@/lib/mtg/types'

interface ManaEconomyProps {
  manaPool: ManaPool
  lands: Card[]
  onTapMana: (color: ManaColor) => void
  onTapLand: (landId: string) => void
  glowingSources?: string[]
}

const manaOrder: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C']

export function ManaEconomy({ 
  manaPool, 
  lands, 
  onTapMana, 
  onTapLand,
  glowingSources = [] 
}: ManaEconomyProps) {
  const totalMana = Object.values(manaPool).reduce((a, b) => a + b, 0)
  
  return (
    <div className="h-full flex flex-col p-3 gap-3">
      {/* Section Title */}
      <div className="text-xs text-slate-400 font-semibold uppercase tracking-wider">
        The Economy
      </div>
      
      {/* Mana Pool */}
      <div className="flex-1 flex flex-col items-center justify-center gap-2">
        {/* Total Mana Indicator */}
        <motion.div
          className="text-2xl font-bold text-white mb-2"
          animate={{ scale: totalMana > 0 ? [1, 1.1, 1] : 1 }}
          transition={{ duration: 0.3 }}
        >
          {totalMana > 0 ? `${totalMana} Mana` : 'Empty Pool'}
        </motion.div>
        
        {/* Mana Orbs - 2 rows of 3 */}
        <div className="grid grid-cols-3 gap-2">
          {manaOrder.map((color) => (
            <ManaOrb
              key={color}
              color={color}
              count={manaPool[color]}
              size="lg"
              onClick={() => onTapMana(color)}
              isGlowing={glowingSources.includes(`mana-${color}`)}
            />
          ))}
        </div>
      </div>
      
      {/* Lands Grid */}
      <div className="flex-1">
        <div className="text-xs text-slate-500 mb-2">Tap Lands</div>
        <ScrollArea className="h-24">
          <div className="grid grid-cols-4 gap-1">
            {lands.map((land) => (
              <motion.button
                key={land.id}
                className="relative"
                onClick={() => onTapLand(land.id)}
                whileTap={{ scale: 0.9 }}
              >
                <MTGCard
                  id={land.id}
                  name={land.name}
                  imageUrl={land.imageUrl}
                  size="sm"
                  isTapped={land.isTapped}
                  isGlowing={glowingSources.includes(land.id)}
                  glowColor="#00ffff"
                />
                {land.isTapped && (
                  <div className="absolute inset-0 bg-black/50 rounded-lg flex items-center justify-center">
                    <span className="text-xs text-slate-300">Tapped</span>
                  </div>
                )}
              </motion.button>
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
