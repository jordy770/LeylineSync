'use client'

import Image from 'next/image'
import { motion, type HTMLMotionProps } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { GameZone } from '@/lib/game/types'

export type MotionCardModel = {
  id: string
  name: string | null
  image_url?: string | null
  is_tapped?: boolean
  damage_marked?: number
  zone?: GameZone | 'draft' | 'combat'
}

type MotionCardProps = {
  card: MotionCardModel
  size?: 'thumb' | 'board' | 'preview'
  interactive?: boolean
  useLayoutId?: boolean
  showNameFallback?: boolean
  className?: string
} & Omit<HTMLMotionProps<'div'>, 'children'>

export default function MotionCard({
  card,
  size = 'board',
  interactive = false,
  useLayoutId = true,
  showNameFallback = true,
  className,
  ...motionProps
}: MotionCardProps) {
  const imageUrl = card.image_url ?? null
  const damageMarked = card.damage_marked ?? 0

  return (
    <motion.div
      layout
      layoutId={useLayoutId ? `card-${card.id}` : undefined}
      whileHover={interactive ? { scale: 1.1, zIndex: 20 } : undefined}
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
      className={cn(
        'relative shrink-0 touch-none select-none rounded-md border border-white/10 bg-slate-950 shadow-lg shadow-black/30',
        size === 'thumb' && 'h-20 w-14',
        size === 'board' && 'w-full',
        size === 'preview' && 'w-28 sm:w-32',
        card.is_tapped && 'rotate-90 opacity-75',
        className,
      )}
      {...motionProps}
    >
      <div
        className={cn(
          'relative overflow-hidden rounded-[inherit] bg-slate-900',
          size === 'thumb' ? 'h-full w-full' : 'aspect-[2/3] w-full',
        )}
      >
        {imageUrl ? (
          <Image
            src={imageUrl}
            alt={card.name || 'Magic card'}
            fill
            draggable={false}
            sizes={size === 'thumb' ? '56px' : '(min-width: 1024px) 15vw, 34vw'}
            className="object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center p-2 text-center text-[10px] font-medium text-slate-400">
            {showNameFallback ? card.name || 'Unnamed Card' : 'No image'}
          </div>
        )}
        {damageMarked > 0 ? (
          <div className="absolute right-1.5 top-1.5 rounded-full bg-red-500 px-2 py-0.5 text-xs font-bold text-white shadow">
            {damageMarked}
          </div>
        ) : null}
      </div>
    </motion.div>
  )
}
