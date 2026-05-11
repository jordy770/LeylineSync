"use client"

import { motion } from 'framer-motion'

interface EnergyBeamProps {
  fromX: number
  fromY: number
  toX: number
  toY: number
  color?: string
}

export function EnergyBeam({ fromX, fromY, toX, toY, color = '#00ffff' }: EnergyBeamProps) {
  const midX = (fromX + toX) / 2
  const midY = (fromY + toY) / 2 - 30
  
  const path = `M ${fromX} ${fromY} Q ${midX} ${midY} ${toX} ${toY}`
  
  return (
    <svg className="absolute inset-0 w-full h-full pointer-events-none z-40">
      <defs>
        <filter id="energyGlow">
          <feGaussianBlur stdDeviation="4" result="coloredBlur" />
          <feMerge>
            <feMergeNode in="coloredBlur" />
            <feMergeNode in="coloredBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <linearGradient id="energyGradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="50%" stopColor={color} stopOpacity="1" />
          <stop offset="100%" stopColor={color} stopOpacity="0.3" />
        </linearGradient>
      </defs>
      
      {/* Outer glow */}
      <motion.path
        d={path}
        stroke={color}
        strokeWidth="12"
        fill="none"
        opacity="0.2"
        filter="url(#energyGlow)"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
      />
      
      {/* Core beam */}
      <motion.path
        d={path}
        stroke="url(#energyGradient)"
        strokeWidth="4"
        fill="none"
        filter="url(#energyGlow)"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
      />
      
      {/* Bright center */}
      <motion.path
        d={path}
        stroke="#ffffff"
        strokeWidth="2"
        fill="none"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
      />
      
      {/* Traveling spark */}
      <motion.circle
        r="6"
        fill={color}
        filter="url(#energyGlow)"
        initial={{ offsetDistance: '0%' }}
        animate={{ offsetDistance: '100%' }}
        transition={{ 
          duration: 0.8,
          repeat: Infinity,
          ease: 'linear'
        }}
        style={{ offsetPath: `path('${path}')` }}
      />
    </svg>
  )
}
