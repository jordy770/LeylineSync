'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { BoardCard, CombatAssignment } from '@/lib/game/types'
import MotionCard from './MotionCard'

type CombatArrow = {
  id: string
  path: string
  isBlocked: boolean
}

export default function CombatManager({
  assignments,
  cards,
  boardElement,
  targetElements,
}: {
  assignments: CombatAssignment[]
  cards: BoardCard[]
  boardElement: HTMLElement | null
  targetElements: Map<string, HTMLElement>
}) {
  const attackerRefs = useRef(new Map<string, HTMLElement>())
  const [arrows, setArrows] = useState<CombatArrow[]>([])
  const cardsById = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards])

  useEffect(() => {
    const measureArrows = () => {
      if (!boardElement) {
        setArrows([])
        return
      }

      const boardRect = boardElement.getBoundingClientRect()
      const nextArrows = assignments
        .map((assignment) => {
          const sourceElement = attackerRefs.current.get(assignment.attacker_card_id)
          const targetElement = targetElements.get(assignment.defending_player_id)

          if (!sourceElement || !targetElement) {
            return null
          }

          const sourceRect = sourceElement.getBoundingClientRect()
          const targetRect = targetElement.getBoundingClientRect()
          const sourceX = sourceRect.left + sourceRect.width / 2 - boardRect.left
          const sourceY = sourceRect.top + sourceRect.height / 2 - boardRect.top
          const targetX = targetRect.left + targetRect.width / 2 - boardRect.left
          const targetY = targetRect.top + targetRect.height / 2 - boardRect.top
          const controlY = Math.min(sourceY, targetY) - Math.max(70, Math.abs(targetX - sourceX) * 0.12)

          return {
            id: assignment.id,
            isBlocked: Boolean(assignment.blocker_card_id || (assignment.blockers?.length ?? 0) > 0),
            path: `M ${sourceX} ${sourceY} C ${sourceX} ${controlY}, ${targetX} ${controlY}, ${targetX} ${targetY}`,
          }
        })
        .filter(Boolean) as CombatArrow[]

      setArrows(nextArrows)
    }

    measureArrows()
    window.addEventListener('resize', measureArrows)

    const frame = window.requestAnimationFrame(measureArrows)

    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', measureArrows)
    }
  }, [assignments, boardElement, cardsById, targetElements])

  if (assignments.length === 0) {
    return null
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-50">
      <svg className="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
        <defs>
          <marker
            id="combat-arrowhead"
            markerHeight="10"
            markerWidth="10"
            orient="auto"
            refX="8"
            refY="5"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#ef4444" />
          </marker>
        </defs>
        <AnimatePresence>
          {arrows.map((arrow) => (
            <motion.path
              key={arrow.id}
              d={arrow.path}
              initial={{ opacity: 0, pathLength: 0 }}
              animate={{ opacity: arrow.isBlocked ? 0.45 : [0.55, 1, 0.55], pathLength: 1 }}
              exit={{ opacity: 0, pathLength: 0 }}
              transition={{
                opacity: { duration: 1.2, repeat: arrow.isBlocked ? 0 : Infinity },
                pathLength: { duration: 0.5, ease: 'easeOut' },
              }}
              fill="none"
              markerEnd="url(#combat-arrowhead)"
              stroke={arrow.isBlocked ? '#f97316' : '#ef4444'}
              strokeLinecap="round"
              strokeWidth="5"
            />
          ))}
        </AnimatePresence>
      </svg>

      <motion.section
        layout
        className="absolute left-1/2 top-[52%] w-[min(38rem,46vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-red-400/40 bg-red-950/20 p-3 shadow-[0_0_34px_rgba(239,68,68,0.22)] backdrop-blur-sm"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-xs font-bold uppercase tracking-[0.18em] text-red-100">Combat Zone</h2>
          <span className="rounded bg-red-500/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-red-200">
            {assignments.length} incoming
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
          <AnimatePresence initial={false}>
            {assignments.map((assignment) => {
              const attacker = cardsById.get(assignment.attacker_card_id)
              const blockers = assignment.blockers
                ?.map((blocker) => cardsById.get(blocker.blocker_card_id))
                .filter(Boolean) as BoardCard[] | undefined

              if (!attacker) {
                return null
              }

              return (
                <motion.div
                  key={assignment.id}
                  layout
                  initial={{ opacity: 0, y: 24, scale: 0.92 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 24, scale: 0.92 }}
                  className="relative rounded-md border border-red-300/25 bg-black/55 p-2"
                >
                  <div
                    ref={(element) => {
                      if (element) {
                        attackerRefs.current.set(assignment.attacker_card_id, element)
                      } else {
                        attackerRefs.current.delete(assignment.attacker_card_id)
                      }
                    }}
                    className="mx-auto max-w-28 rotate-90"
                  >
                    <MotionCard
                      card={{
                        id: attacker.id,
                        name: attacker.name,
                        image_url: attacker.image_url,
                        is_tapped: false,
                        damage_marked: attacker.damage_marked,
                        zone: 'combat',
                      }}
                      size="board"
                      className="shadow-[0_0_22px_rgba(239,68,68,0.3)]"
                    />
                  </div>
                  {blockers && blockers.length > 0 ? (
                    <div className="mt-3 flex justify-center gap-1">
                      {blockers.map((blocker) => (
                        <div key={blocker.id} className="max-w-14">
                          <MotionCard
                            card={{
                              id: blocker.id,
                              name: blocker.name,
                              image_url: blocker.image_url,
                              is_tapped: blocker.is_tapped,
                              damage_marked: blocker.damage_marked,
                              zone: 'combat',
                            }}
                            size="thumb"
                            className="border-orange-300/40"
                          />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-center text-[10px] font-semibold uppercase tracking-[0.12em] text-red-200">
                      Unblocked
                    </p>
                  )}
                </motion.div>
              )
            })}
          </AnimatePresence>
        </div>
      </motion.section>
    </div>
  )
}
