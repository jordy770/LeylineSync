"use client"

import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

interface MTGCardProps {
  id: string
  name: string
  imageUrl: string
  size?: 'sm' | 'md' | 'lg'
  isTapped?: boolean
  isAttacking?: boolean
  isGlowing?: boolean
  glowColor?: string
  onClick?: () => void
  onDrag?: (info: { offset: { x: number; y: number } }) => void
  onDragEnd?: (info: { offset: { x: number; y: number }; velocity: { x: number; y: number } }) => void
  draggable?: boolean
  className?: string
  style?: React.CSSProperties
}

const sizeClasses = {
  sm: 'w-16 h-22',
  md: 'w-24 h-34',
  lg: 'w-36 h-50',
}

export function MTGCard({
  id,
  name,
  imageUrl,
  size = 'md',
  isTapped = false,
  isAttacking = false,
  isGlowing = false,
  glowColor = 'cyan',
  onClick,
  onDrag,
  onDragEnd,
  draggable = false,
  className,
  style,
}: MTGCardProps) {
  return (
    <motion.div
      layoutId={id}
      className={cn(
        'relative rounded-lg overflow-hidden cursor-pointer transition-shadow',
        sizeClasses[size],
        isGlowing && 'animate-pulse',
        className
      )}
      style={{
        ...style,
        boxShadow: isGlowing 
          ? `0 0 20px ${glowColor}, 0 0 40px ${glowColor}` 
          : isAttacking
          ? '0 0 20px rgba(239, 68, 68, 0.8), 0 0 40px rgba(239, 68, 68, 0.5)'
          : undefined,
      }}
      animate={{
        rotate: isTapped ? 90 : 0,
        scale: isAttacking ? 1.1 : 1,
      }}
      transition={{ type: 'spring', stiffness: 300, damping: 20 }}
      onClick={onClick}
      drag={draggable}
      dragSnapToOrigin={!onDragEnd}
      onDrag={(_, info) => onDrag?.(info)}
      onDragEnd={(_, info) => onDragEnd?.(info)}
      whileHover={{ scale: draggable ? 1.05 : 1.02, y: -5 }}
      whileTap={{ scale: 0.98 }}
    >
      {/* Card Image */}
      <div className="w-full h-full bg-gradient-to-br from-slate-700 to-slate-900 flex items-center justify-center">
        <div className="text-xs text-slate-400 text-center px-1 truncate">
          {name}
        </div>
      </div>
      
      {/* Attacking Indicator */}
      {isAttacking && (
        <motion.div
          className="absolute inset-0 border-4 border-red-500 rounded-lg"
          animate={{ opacity: [0.5, 1, 0.5] }}
          transition={{ repeat: Infinity, duration: 1 }}
        />
      )}
      
      {/* Glow Effect */}
      {isGlowing && (
        <motion.div
          className="absolute inset-0 rounded-lg pointer-events-none"
          style={{
            background: `radial-gradient(circle, ${glowColor}33 0%, transparent 70%)`,
          }}
          animate={{ opacity: [0.3, 0.8, 0.3] }}
          transition={{ repeat: Infinity, duration: 1.5 }}
        />
      )}
    </motion.div>
  )
}
