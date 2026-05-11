"use client"

import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { ManaColor } from '@/lib/mtg/types'

interface ManaOrbProps {
  color: ManaColor
  count: number
  onClick?: () => void
  size?: 'sm' | 'md' | 'lg'
  isGlowing?: boolean
}

const manaColors: Record<ManaColor, { bg: string; text: string; glow: string; symbol: string }> = {
  W: { bg: 'bg-amber-100', text: 'text-amber-900', glow: '#fef3c7', symbol: '☀' },
  U: { bg: 'bg-blue-500', text: 'text-white', glow: '#3b82f6', symbol: '💧' },
  B: { bg: 'bg-slate-800', text: 'text-slate-200', glow: '#475569', symbol: '💀' },
  R: { bg: 'bg-red-500', text: 'text-white', glow: '#ef4444', symbol: '🔥' },
  G: { bg: 'bg-green-600', text: 'text-white', glow: '#16a34a', symbol: '🌲' },
  C: { bg: 'bg-slate-400', text: 'text-slate-900', glow: '#94a3b8', symbol: '◇' },
}

const sizeClasses = {
  sm: 'w-10 h-10 text-sm',
  md: 'w-14 h-14 text-lg',
  lg: 'w-20 h-20 text-2xl',
}

export function ManaOrb({ color, count, onClick, size = 'md', isGlowing = false }: ManaOrbProps) {
  const colorConfig = manaColors[color]

  return (
    <motion.button
      className={cn(
        'relative rounded-full flex items-center justify-center font-bold',
        'border-2 border-white/20 shadow-lg',
        'active:scale-95 transition-transform',
        colorConfig.bg,
        colorConfig.text,
        sizeClasses[size]
      )}
      style={{
        boxShadow: isGlowing 
          ? `0 0 20px ${colorConfig.glow}, 0 0 40px ${colorConfig.glow}, inset 0 0 20px rgba(255,255,255,0.3)` 
          : `0 4px 15px rgba(0,0,0,0.3), inset 0 0 20px rgba(255,255,255,0.2)`,
      }}
      onClick={onClick}
      whileHover={{ scale: 1.1 }}
      whileTap={{ scale: 0.9 }}
      animate={isGlowing ? { 
        scale: [1, 1.05, 1],
        boxShadow: [
          `0 0 20px ${colorConfig.glow}`,
          `0 0 40px ${colorConfig.glow}`,
          `0 0 20px ${colorConfig.glow}`,
        ]
      } : {}}
      transition={isGlowing ? { repeat: Infinity, duration: 1.5 } : {}}
    >
      <span className="relative z-10">{count > 0 ? count : colorConfig.symbol}</span>
      
      {/* Inner Shine */}
      <div className="absolute inset-1 rounded-full bg-gradient-to-br from-white/40 to-transparent pointer-events-none" />
      
      {/* Ripple on tap */}
      {count > 0 && (
        <motion.div
          className="absolute inset-0 rounded-full bg-white/30"
          initial={{ scale: 0, opacity: 1 }}
          animate={{ scale: 0, opacity: 1 }}
          whileTap={{ scale: 2, opacity: 0 }}
          transition={{ duration: 0.4 }}
        />
      )}
    </motion.button>
  )
}
