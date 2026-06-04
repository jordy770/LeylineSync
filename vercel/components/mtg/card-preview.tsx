"use client"

import { motion, AnimatePresence } from 'framer-motion'
import type { Card } from '@/lib/mtg/types'

interface CardPreviewProps {
  card: Card | null
  onClose?: () => void
  position?: 'left' | 'right' | 'center'
}

const manaColorMap: Record<string, { bg: string; text: string }> = {
  W: { bg: 'bg-amber-100', text: 'text-amber-900' },
  U: { bg: 'bg-blue-500', text: 'text-white' },
  B: { bg: 'bg-slate-800', text: 'text-white' },
  R: { bg: 'bg-red-500', text: 'text-white' },
  G: { bg: 'bg-green-600', text: 'text-white' },
  C: { bg: 'bg-slate-400', text: 'text-slate-900' },
}

function ManaCostDisplay({ cost }: { cost: string }) {
  // Parse mana cost like "{2}{U}{B}" into symbols
  const symbols = cost.match(/\{[^}]+\}/g) || []
  
  return (
    <div className="flex gap-1">
      {symbols.map((symbol, i) => {
        const value = symbol.replace(/[{}]/g, '')
        const isNumber = /^\d+$/.test(value)
        const colors = manaColorMap[value]
        
        return (
          <span
            key={i}
            className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
              isNumber 
                ? 'bg-slate-500 text-white' 
                : colors 
                  ? `${colors.bg} ${colors.text}` 
                  : 'bg-slate-600 text-white'
            }`}
          >
            {value}
          </span>
        )
      })}
    </div>
  )
}

export function CardPreview({ card, onClose, position = 'right' }: CardPreviewProps) {
  const positionStyles = {
    left: 'left-4',
    right: 'right-4',
    center: 'left-1/2 -translate-x-1/2',
  }

  return (
    <AnimatePresence>
      {card && (
        <motion.div
          initial={{ opacity: 0, scale: 0.8, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.8, y: 20 }}
          transition={{ type: 'spring', stiffness: 400, damping: 25 }}
          className={`absolute top-16 ${positionStyles[position]} z-50 w-56`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Backdrop blur panel */}
          <div className="relative bg-slate-900/95 backdrop-blur-md rounded-xl border border-slate-700/50 shadow-2xl shadow-black/50 overflow-hidden">
            {/* Card Image */}
            <div className="relative aspect-[5/7] bg-gradient-to-br from-slate-800 to-slate-900">
              {card.imageUrl ? (
                <img
                  src={card.imageUrl}
                  alt={card.name}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <div className="text-center p-4">
                    <div className="text-4xl mb-2 opacity-50">
                      {card.type === 'creature' ? '🗡️' : 
                       card.type === 'instant' ? '⚡' :
                       card.type === 'sorcery' ? '✨' :
                       card.type === 'artifact' ? '⚙️' :
                       card.type === 'enchantment' ? '🔮' :
                       card.type === 'land' ? '🏔️' :
                       card.type === 'planeswalker' ? '👤' : '📜'}
                    </div>
                    <div className="text-white font-bold text-sm">{card.name}</div>
                  </div>
                </div>
              )}
              
              {/* Gradient overlay */}
              <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-transparent to-transparent" />
              
              {/* P/T badge for creatures */}
              {card.power !== undefined && (
                <div className="absolute bottom-2 right-2 bg-black/80 px-3 py-1 rounded-lg">
                  <span className="text-white font-bold text-lg">
                    {card.power}/{card.toughness}
                  </span>
                </div>
              )}
              
              {/* Tapped indicator */}
              {card.isTapped && (
                <motion.div 
                  className="absolute top-2 left-2 bg-amber-500/90 text-white text-xs font-bold px-2 py-1 rounded"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                >
                  TAPPED
                </motion.div>
              )}
              
              {/* Attacking indicator */}
              {card.isAttacking && (
                <motion.div 
                  className="absolute top-2 right-2 bg-red-500/90 text-white text-xs font-bold px-2 py-1 rounded"
                  animate={{ 
                    boxShadow: ['0 0 0 0 rgba(239,68,68,0)', '0 0 0 8px rgba(239,68,68,0)'],
                  }}
                  transition={{ repeat: Infinity, duration: 1 }}
                >
                  ATTACKING
                </motion.div>
              )}
            </div>
            
            {/* Card Info */}
            <div className="p-3 space-y-2">
              {/* Name and Mana Cost */}
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-white font-bold text-sm leading-tight flex-1">
                  {card.name}
                </h3>
                {card.manaCost && (
                  <ManaCostDisplay cost={card.manaCost} />
                )}
              </div>
              
              {/* Type line */}
              <div className="text-slate-400 text-xs capitalize">
                {card.type}
              </div>
              
              {/* Quick Stats */}
              <div className="flex gap-2 flex-wrap">
                {card.isTapped !== undefined && (
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    card.isTapped 
                      ? 'bg-amber-500/20 text-amber-400' 
                      : 'bg-emerald-500/20 text-emerald-400'
                  }`}>
                    {card.isTapped ? 'Tapped' : 'Untapped'}
                  </span>
                )}
                {card.isAttacking && (
                  <span className="text-xs px-2 py-0.5 rounded bg-red-500/20 text-red-400">
                    Attacking
                  </span>
                )}
                {card.isBlocking && (
                  <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-400">
                    Blocking
                  </span>
                )}
              </div>
            </div>
            
            {/* Close hint */}
            <div className="px-3 pb-2">
              <div className="text-slate-600 text-[10px] text-center">
                Tap anywhere to close
              </div>
            </div>
          </div>
          
          {/* Decorative glow */}
          <div className="absolute -inset-4 bg-blue-500/10 rounded-2xl blur-xl -z-10" />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
