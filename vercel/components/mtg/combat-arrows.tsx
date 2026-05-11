"use client"

import { motion } from 'framer-motion'
import type { AttackDeclaration } from '@/lib/mtg/types'

interface CombatArrowsProps {
  attacks: AttackDeclaration[]
  cardPositions: Map<string, { x: number; y: number }>
  playerPositions: Map<string, { x: number; y: number }>
}

export function CombatArrows({ attacks, cardPositions, playerPositions }: CombatArrowsProps) {
  return (
    <svg className="absolute inset-0 w-full h-full pointer-events-none z-50">
      <defs>
        <marker
          id="arrowhead"
          markerWidth="10"
          markerHeight="7"
          refX="9"
          refY="3.5"
          orient="auto"
        >
          <polygon
            points="0 0, 10 3.5, 0 7"
            fill="#ef4444"
          />
        </marker>
        <filter id="glow">
          <feGaussianBlur stdDeviation="3" result="coloredBlur" />
          <feMerge>
            <feMergeNode in="coloredBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <linearGradient id="attackGradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#ef4444" stopOpacity="0.8" />
          <stop offset="50%" stopColor="#f97316" stopOpacity="1" />
          <stop offset="100%" stopColor="#ef4444" stopOpacity="0.8" />
        </linearGradient>
      </defs>
      
      {attacks.map((attack, index) => {
        const fromPos = cardPositions.get(attack.attackerCardId)
        const toPos = playerPositions.get(attack.targetPlayerId)
        
        if (!fromPos || !toPos) return null
        
        const midX = (fromPos.x + toPos.x) / 2
        const midY = (fromPos.y + toPos.y) / 2 - 50
        
        const path = `M ${fromPos.x} ${fromPos.y} Q ${midX} ${midY} ${toPos.x} ${toPos.y}`
        
        return (
          <g key={`${attack.attackerCardId}-${attack.targetPlayerId}-${index}`}>
            {/* Glow background */}
            <motion.path
              d={path}
              stroke="#ef4444"
              strokeWidth="8"
              fill="none"
              opacity="0.3"
              filter="url(#glow)"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
            
            {/* Main arrow path */}
            <motion.path
              d={path}
              stroke="url(#attackGradient)"
              strokeWidth="4"
              fill="none"
              markerEnd="url(#arrowhead)"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
            
            {/* Pulsing effect */}
            <motion.path
              d={path}
              stroke="#ffffff"
              strokeWidth="2"
              fill="none"
              opacity="0.5"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ 
                pathLength: [0, 1],
                opacity: [0.8, 0],
              }}
              transition={{ 
                duration: 1,
                repeat: Infinity,
                ease: 'linear'
              }}
            />
          </g>
        )
      })}
    </svg>
  )
}
