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
  visualClassName?: string
} & Omit<HTMLMotionProps<'div'>, 'children'>

export default function MotionCard({
  card,
  size = 'board',
  interactive = false,
  useLayoutId = true,
  showNameFallback = true,
  className,
  visualClassName,
  ...motionProps
}: MotionCardProps) {
  const imageUrl = card.image_url ?? null
  const damageMarked = card.damage_marked ?? 0
  const isTapped = Boolean(card.is_tapped)

  return (
    <motion.div
      layout
      layoutId={useLayoutId ? `card-${card.id}` : undefined}
      whileHover={interactive ? { scale: 1.08, y: -4, zIndex: 20 } : undefined}
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
      className={cn(
        'relative shrink-0 touch-none select-none',
        size === 'thumb' && 'h-20 w-14',
        size === 'board' && 'w-full',
        size === 'preview' && 'w-28 sm:w-32',
        className,
      )}
      {...motionProps}
    >
      <div
        className={cn(
          'relative rounded-md border border-white/10 bg-slate-950 shadow-[0_16px_30px_rgba(0,0,0,0.35)]',
          size === 'thumb' ? 'h-full w-full' : 'w-full',
          isTapped && 'rotate-90 opacity-80',
          visualClassName,
        )}
      >
        <div className="pointer-events-none absolute -inset-px rounded-[inherit] bg-gradient-to-b from-white/15 via-transparent to-black/20" />
        <div
          className={cn(
            'relative overflow-hidden rounded-[inherit] bg-gradient-to-br from-slate-800 to-slate-950',
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
            <div className="flex h-full items-center justify-center p-2 text-center">
              <div>
                <div className="mx-auto mb-2 h-8 w-8 rounded-full border border-cyan-200/20 bg-cyan-950/30" />
                <p className="line-clamp-3 text-[10px] font-semibold text-slate-300">
                  {showNameFallback ? card.name || 'Unnamed Card' : 'No image'}
                </p>
              </div>
            </div>
          )}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-slate-950/35 via-transparent to-white/5" />
          {isTapped ? (
            <div className="absolute left-1.5 top-1.5 rounded bg-amber-500/90 px-1.5 py-0.5 text-[9px] font-bold uppercase text-white shadow">
              Tapped
            </div>
          ) : null}
          {damageMarked > 0 ? (
            <div className="absolute right-1.5 top-1.5 rounded-full border border-white/25 bg-red-500 px-2 py-0.5 text-xs font-bold text-white shadow">
              {damageMarked}
            </div>
          ) : null}
          {card.zone === 'combat' ? (
            <div className="absolute inset-0 rounded-[inherit] border-2 border-red-400/80 shadow-[inset_0_0_18px_rgba(248,113,113,0.28)]" />
          ) : null}
        </div>
      </div>
    </motion.div>
  )
}
