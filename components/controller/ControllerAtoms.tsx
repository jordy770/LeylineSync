import { BookOpen } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ManaColor, ManaPool } from '@/lib/game/types'

const manaColors: Array<{ color: ManaColor; label: string }> = [
  { color: 'W', label: 'White' },
  { color: 'U', label: 'Blue' },
  { color: 'B', label: 'Black' },
  { color: 'R', label: 'Red' },
  { color: 'G', label: 'Green' },
  { color: 'C', label: 'Colorless' },
]

export function MiniManaPool({ manaPool }: { manaPool: ManaPool }) {
  return (
    <div className="grid grid-cols-3 gap-1">
      {manaColors.map((item) => (
        <div key={item.color} title={item.label} className={`flex h-8 w-8 items-center justify-center rounded-full border text-xs font-black ${getManaOrbClass(item.color, manaPool[item.color] ?? 0)}`}>
          {manaPool[item.color] ?? 0}
        </div>
      ))}
    </div>
  )
}

export function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-white/10 bg-black/20 px-3 py-2">
      <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className="text-sm font-black text-white">{value}</p>
    </div>
  )
}

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'amber' | 'red' }) {
  const className =
    tone === 'amber'
      ? 'border-amber-300/25 bg-amber-500/15 text-amber-100'
      : tone === 'red'
        ? 'border-red-300/25 bg-red-500/15 text-red-100'
        : 'border-white/15 bg-white/10 text-slate-100'

  return <span className={`rounded-md border px-2 py-0.5 text-xs font-bold ${className}`}>{children}</span>
}

export function EmptyPanel({ title, description }: { title: string; description: string }) {
  return (
    <section className="flex min-h-[18rem] flex-col items-center justify-center rounded-lg border border-dashed border-white/10 bg-slate-950/55 p-5 text-center">
      <BookOpen className="mb-3 h-8 w-8 text-slate-500" aria-hidden="true" />
      <h2 className="text-sm font-black text-white">{title}</h2>
      <p className="mt-1 max-w-64 text-xs text-slate-500">{description}</p>
    </section>
  )
}

function getManaOrbClass(color: ManaColor, value: number) {
  const baseClass = 'border-white/10'

  if (value <= 0) {
    return `${baseClass} bg-slate-900 text-slate-500`
  }

  if (color === 'W') {
    return 'border-yellow-100 bg-yellow-100 text-slate-950'
  }

  if (color === 'U') {
    return 'border-blue-400 bg-blue-500 text-white'
  }

  if (color === 'B') {
    return 'border-purple-800 bg-purple-950 text-purple-100'
  }

  if (color === 'R') {
    return 'border-red-400 bg-red-500 text-white'
  }

  if (color === 'G') {
    return 'border-emerald-400 bg-emerald-500 text-white'
  }

  return 'border-slate-300 bg-slate-300 text-slate-950'
}
