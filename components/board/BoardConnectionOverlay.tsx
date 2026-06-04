import { AnimatePresence, motion } from 'framer-motion'
import type { BoardConnection } from '@/lib/game/board-selectors'

export default function BoardConnectionOverlay({ connections }: { connections: BoardConnection[] }) {
  if (connections.length === 0) {
    return null
  }

  return (
    <svg
      className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible opacity-80"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <filter id="board-connection-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.8" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <AnimatePresence>
        {connections.map((connection) => (
          <motion.path
            key={connection.id}
            d={connection.path}
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 0.85 }}
            exit={{ pathLength: 0, opacity: 0 }}
            transition={{ duration: 0.55, ease: 'easeOut' }}
            fill="none"
            filter="url(#board-connection-glow)"
            stroke={connection.lane === 'combat' ? '#f59e0b' : '#38bdf8'}
            strokeLinecap="round"
            strokeDasharray={connection.lane === 'combat' ? '2 1.5' : undefined}
            strokeWidth={connection.lane === 'combat' ? '0.38' : '0.32'}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </AnimatePresence>
    </svg>
  )
}
