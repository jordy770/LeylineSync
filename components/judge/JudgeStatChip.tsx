export default function JudgeStatChip({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'life' | 'hand' | 'library' | 'tapped'
}) {
  const toneClassName =
    tone === 'life'
      ? 'border-cyan-300/25 bg-cyan-950/35 text-cyan-100'
      : tone === 'hand'
        ? 'border-violet-300/20 bg-violet-950/25 text-violet-100'
        : tone === 'library'
          ? 'border-slate-300/15 bg-slate-950/55 text-slate-100'
          : 'border-amber-300/25 bg-amber-950/25 text-amber-100'

  return (
    <span className={`rounded-md border px-2.5 py-1 text-xs font-semibold ${toneClassName}`}>
      <span className="mr-1 text-[10px] uppercase tracking-[0.12em] opacity-60">{label}</span>
      {value}
    </span>
  )
}
