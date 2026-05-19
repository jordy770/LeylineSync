import type { ManaColor, ManaPool } from '@/lib/game/types'

const manaColorsForDisplay: Array<{
  color: ManaColor
  label: string
  className: string
}> = [
  { color: 'W', label: 'White', className: 'border-stone-300 bg-stone-100 text-stone-950' },
  { color: 'U', label: 'Blue', className: 'border-sky-300 bg-sky-500 text-white' },
  { color: 'B', label: 'Black', className: 'border-zinc-700 bg-zinc-950 text-white' },
  { color: 'R', label: 'Red', className: 'border-red-400 bg-red-600 text-white' },
  { color: 'G', label: 'Green', className: 'border-emerald-400 bg-emerald-600 text-white' },
  { color: 'C', label: 'Colorless', className: 'border-neutral-500 bg-neutral-300 text-neutral-950' },
]

export default function PlayerManaPool({ manaPool }: { manaPool: ManaPool }) {
  return (
    <div className="mt-3 rounded-lg border border-white/10 bg-slate-950/55 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">Mana Pool</h3>
        <span className="text-xs text-slate-500">
          Total {manaColorsForDisplay.reduce((total, item) => total + (manaPool[item.color] ?? 0), 0)}
        </span>
      </div>
      <div className="grid grid-cols-6 gap-1.5">
        {manaColorsForDisplay.map((item) => (
          <div
            key={item.color}
            title={item.label}
            className={`flex min-h-10 flex-col items-center justify-center rounded-md border px-1 py-1 ${item.className}`}
          >
            <span className="text-[10px] font-bold leading-none">{item.color}</span>
            <span className="text-sm font-bold leading-none">{manaPool[item.color] ?? 0}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
