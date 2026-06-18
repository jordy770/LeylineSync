'use client'

import { parseManaCost } from '@/lib/game/mana'
import type { ManaColor, ManaPool, RestrictedManaEntry } from '@/lib/game/types'
import { KEYWORD_LABELS, manaColors, manaColorStyles } from './shared'

// ─── Mana Display Components ──────────────────────────────────────────────────

export function ManaSymbol({ color, size = 'sm' }: { color: string; size?: 'sm' | 'md' }) {
  const style = manaColorStyles[color as ManaColor] ?? { bg: 'bg-slate-600', text: 'text-slate-400', dot: 'bg-slate-600' }
  const sizeClass = size === 'md' ? 'h-7 w-7 text-[11px]' : 'h-5 w-5 text-[9px]'
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-black text-black ${style.bg} ${sizeClass}`}
    >
      {color}
    </span>
  )
}

export function KeywordBadges({ keywords }: { keywords: string[] }) {
  if (keywords.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1">
      {keywords.map((k) => (
        <span
          key={k}
          className="rounded bg-white/10 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wide text-slate-300"
        >
          {KEYWORD_LABELS[k] ?? k}
        </span>
      ))}
    </div>
  )
}

export function ManaCostDisplay({ manaCost, dark }: { manaCost?: string | null; dark?: boolean }) {
  if (!manaCost) return null
  const parsed = parseManaCost(manaCost)
  const pips: React.ReactNode[] = []

  if (parsed.generic > 0) {
    pips.push(
      <span
        key="generic"
        className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-black ${
          dark ? 'bg-amber-800 text-amber-100' : 'bg-slate-700 text-white'
        }`}
      >
        {parsed.generic}
      </span>,
    )
  }

  for (const [color, count] of Object.entries(parsed.colored)) {
    for (let i = 0; i < count; i++) {
      pips.push(<ManaSymbol key={`${color}-${i}`} color={color} />)
    }
  }

  return <div className="flex items-center gap-1">{pips}</div>
}

export function ManaPoolDisplay({ manaPool }: { manaPool: ManaPool }) {
  return (
    <div className="flex items-center gap-1">
      {manaColors.map((c) => {
        const amount = manaPool[c] ?? 0
        return (
          <span key={c} className="flex items-center gap-0.5">
            <span
              className={`h-1.5 w-1.5 rounded-full transition-opacity ${manaColorStyles[c].dot} ${
                amount > 0 ? 'opacity-100' : 'opacity-20'
              }`}
            />
            {amount > 0 && (
              <span className={`text-[9px] font-black leading-none ${manaColorStyles[c].text}`}>
                {amount}
              </span>
            )}
          </span>
        )
      })}
    </div>
  )
}

// "Spend only to …" mana, shown apart from the open pool with a short label so
// the player knows what it can pay for (Haven of the Spirit Dragon, Drover, …).
function restrictionLabel(e: RestrictedManaEntry): string {
  if (e.commander) return 'Commander'
  const t = e.spell_type_line ?? e.ability_source_type_line
  if (t && t !== '$chosen') return `${t}s only`
  return 'Restricted'
}

export function RestrictedManaDisplay({ entries }: { entries: RestrictedManaEntry[] }) {
  if (!entries || entries.length === 0) return null
  return (
    <div className="flex items-center gap-1">
      {entries.map((e, i) => (
        <span
          key={`${e.color}-${i}`}
          title={restrictionLabel(e)}
          className="flex items-center gap-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-1 py-0.5"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${manaColorStyles[e.color as ManaColor]?.dot ?? 'bg-slate-600'}`} />
          <span className={`text-[9px] font-black leading-none ${manaColorStyles[e.color as ManaColor]?.text ?? 'text-slate-300'}`}>
            {e.amount}
          </span>
          <span className="text-[7px] font-bold uppercase tracking-wide text-amber-300/80">{restrictionLabel(e)}</span>
        </span>
      ))}
    </div>
  )
}
