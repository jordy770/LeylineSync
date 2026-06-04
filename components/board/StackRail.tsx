import { motion } from 'framer-motion'
import type { StackItem } from '@/lib/game/types'

export default function StackRail({ stackItems }: { stackItems: StackItem[] }) {
  return (
    <motion.section
      layout
      className="leyline-glass-panel relative z-30 order-first mx-auto w-full max-w-44 rounded-lg p-3 text-center [transform:translateZ(42px)] [@media(max-height:640px)]:order-none [@media(max-height:640px)]:h-full [@media(max-height:640px)]:max-w-none [@media(max-height:640px)]:p-2 xl:order-none"
    >
      <h2 className="mb-3 rounded-md border border-cyan-300/30 bg-cyan-950/30 py-1 text-xs font-bold uppercase tracking-[0.18em] text-cyan-50 [@media(max-height:640px)]:mb-2 [@media(max-height:640px)]:text-[10px]">
        The Stack
      </h2>
      <div className="grid gap-2 [@media(max-height:640px)]:gap-1 lg:min-h-[26rem] lg:content-start">
        {stackItems.length === 0 ? (
          <div className="rounded-md border border-white/10 px-2 py-12 text-xs text-slate-500 [@media(max-height:640px)]:py-8 [@media(max-height:640px)]:text-[10px] lg:py-24">
            Empty
          </div>
        ) : (
          stackItems.map((item) => (
            <motion.div
              key={item.id}
              layout
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="rounded-md border border-cyan-300/30 bg-cyan-950/25 p-2 text-left shadow-[0_0_14px_rgba(34,211,238,0.1)] [@media(max-height:640px)]:p-1.5"
            >
              <p className="truncate text-xs font-semibold text-white [@media(max-height:640px)]:text-[10px]">
                {item.source_card_name ?? item.action_type}
              </p>
              <p className="truncate text-[10px] text-cyan-200/70 [@media(max-height:640px)]:text-[9px]">{item.controller_username ?? 'Unknown'}</p>
            </motion.div>
          ))
        )}
      </div>
    </motion.section>
  )
}
