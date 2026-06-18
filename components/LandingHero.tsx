// LandingHero — the thesis of the page rendered as a Magic card: "Leyline Sync,"
// a Legendary Enchantment whose rules text is the product pitch and whose art is
// the product itself (one board node syncing gold conduits to four controllers).
// Static + CSS-only motion, so it stays a server component.

const MANA: Record<string, { ring: string; fill: string; ink: string }> = {
  generic: { ring: '#b9ad8e', fill: '#d9cdae', ink: '#3a3420' },
  G: { ring: '#2f6a44', fill: '#3c7a4e', ink: '#eafaef' },
  W: { ring: '#cfc6ad', fill: '#f4efdd', ink: '#3a3420' },
}

function Pip({ symbol, label }: { symbol: string; label: string }) {
  const c = MANA[symbol] ?? MANA.generic
  return (
    <span
      className="grid h-6 w-6 place-items-center rounded-full text-[11px] font-bold shadow-[0_1px_2px_rgba(0,0,0,0.4),inset_0_1px_1px_rgba(255,255,255,0.45)]"
      style={{ background: c.fill, color: c.ink, border: `1px solid ${c.ring}` }}
      aria-hidden
    >
      {label}
    </span>
  )
}

function LeylineArt() {
  // board → controller conduits; each drawn twice (faint base + flowing bright).
  const conduits = [
    'M300 150 Q 180 150 110 222',
    'M300 150 Q 252 212 235 260',
    'M300 150 Q 348 212 365 260',
    'M300 150 Q 420 150 490 222',
  ]
  const phones = [
    { x: 93, y: 222 },
    { x: 218, y: 260 },
    { x: 348, y: 260 },
    { x: 473, y: 222 },
  ]
  return (
    <svg viewBox="0 0 600 360" className="h-full w-full" role="img" aria-label="One board synced to four controllers along glowing leylines">
      <defs>
        <radialGradient id="field" cx="50%" cy="34%" r="75%">
          <stop offset="0%" stopColor="#1d2436" />
          <stop offset="55%" stopColor="#0e1018" />
          <stop offset="100%" stopColor="#080a10" />
        </radialGradient>
        <radialGradient id="screen" cx="50%" cy="35%" r="80%">
          <stop offset="0%" stopColor="#3a6f7e" />
          <stop offset="100%" stopColor="#10202b" />
        </radialGradient>
        <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f0ce78" />
          <stop offset="100%" stopColor="#c99a3a" />
        </linearGradient>
      </defs>

      <rect width="600" height="360" fill="url(#field)" />

      {/* conduits */}
      {conduits.map((d, i) => (
        <g key={i}>
          <path d={d} fill="none" stroke="#c99a3a" strokeOpacity="0.28" strokeWidth="2.5" />
          <path d={d} fill="none" stroke="url(#gold)" strokeWidth="2.5" strokeLinecap="round" className="ley-flow" />
        </g>
      ))}

      {/* controllers (phones) */}
      {phones.map((p, i) => (
        <g key={i} className="ley-node" style={{ animationDelay: `${i * 0.4}s` }}>
          <rect x={p.x} y={p.y} width="34" height="58" rx="7" fill="#0f1622" stroke="url(#gold)" strokeWidth="1.5" />
          <rect x={p.x + 4} y={p.y + 5} width="26" height="40" rx="3" fill="url(#screen)" />
          <circle cx={p.x + 17} cy={p.y + 51} r="1.6" fill="#c99a3a" />
        </g>
      ))}

      {/* board (TV) */}
      <g>
        <rect x="228" y="56" width="144" height="92" rx="9" fill="#0d1420" stroke="url(#gold)" strokeWidth="2" />
        <rect x="238" y="66" width="124" height="64" rx="4" fill="url(#screen)" />
        {/* a couple of "cards" on the board */}
        <rect x="252" y="80" width="18" height="26" rx="2" fill="#ece3cd" opacity="0.85" />
        <rect x="276" y="84" width="18" height="26" rx="2" fill="#cdbf9b" opacity="0.7" />
        <rect x="318" y="82" width="18" height="26" rx="2" fill="#ece3cd" opacity="0.78" />
        <line x1="300" y1="148" x2="300" y2="153" stroke="#c99a3a" strokeWidth="3" />
        {/* energy core */}
        <circle cx="300" cy="150" r="5" fill="#f0ce78" className="ley-node" />
        <circle cx="300" cy="150" r="11" fill="none" stroke="#f0ce78" strokeOpacity="0.4" strokeWidth="1" />
      </g>
    </svg>
  )
}

export default function LandingHero() {
  return (
    <div className="mx-auto w-full max-w-[430px] [perspective:1400px]">
      {/* gold legendary frame */}
      <div className="card-frame rounded-[20px] p-[7px]">
        <div className="overflow-hidden rounded-[15px] bg-[var(--ink-2)] p-2.5 ring-1 ring-black/40">
          {/* title plate */}
          <div className="flex items-center justify-between gap-2 rounded-md bg-gradient-to-b from-[#241c12] to-[var(--ink-warm)] px-3 py-2 shadow-inner ring-1 ring-[var(--frame-gold)]/30">
            <h2 className="font-display text-[19px] font-semibold leading-none tracking-wide text-[var(--text-bright)] [text-shadow:0_1px_0_rgba(0,0,0,0.6)]">
              Leyline Sync
            </h2>
            <div className="flex items-center gap-1">
              <Pip symbol="generic" label="4" />
              <Pip symbol="G" label="G" />
              <Pip symbol="W" label="W" />
            </div>
          </div>

          {/* art */}
          <div className="mt-2 overflow-hidden rounded-md ring-1 ring-[var(--frame-gold)]/40">
            <div className="aspect-[5/3] w-full">
              <LeylineArt />
            </div>
          </div>

          {/* type line */}
          <div className="mt-2 flex items-center justify-between rounded-md bg-gradient-to-b from-[#241c12] to-[var(--ink-warm)] px-3 py-1.5 ring-1 ring-[var(--frame-gold)]/30">
            <span className="font-display text-[12.5px] tracking-wide text-[var(--text)]">
              Legendary Enchantment — Table
            </span>
            <span
              className="grid h-5 w-5 rotate-45 place-items-center rounded-[3px] bg-gradient-to-br from-[#f0ce78] to-[#a87f2c] text-[8px] font-bold text-[#2a2010]"
              title="Mythic"
              aria-hidden
            >
              <span className="-rotate-45">◆</span>
            </span>
          </div>

          {/* rules text box */}
          <div className="card-parchment mt-2 rounded-md px-3.5 py-3 text-[var(--parchment-ink)] ring-1 ring-[#9c8c63]/40">
            <p className="font-rules text-[13.5px] leading-snug">
              One board on the big screen, a controller in every hand.
            </p>
            <div className="my-2 h-px bg-[#3a3420]/20" />
            <p className="font-rules text-[13px] leading-snug">
              <span className="font-semibold">⟢ , Tap a phone:</span> open a table. Up to four pilots
              join your pod.
            </p>
            <p className="mt-1.5 font-rules text-[13px] leading-snug">
              Whenever anyone casts a spell, every device sees it — the stack, the mana, and the
              board stay in sync.
            </p>
            <p className="mt-2.5 border-l-2 border-[#9c8c63]/40 pl-2 font-rules text-[12px] italic leading-snug text-[#5a4f33]">
              Where the leylines cross, the table remembers every spell.
            </p>
          </div>

          {/* collector line */}
          <div className="mt-2 flex items-center justify-between px-1 font-mono text-[9px] text-[var(--text-faint)]">
            <span>LS · 001 · M</span>
            <span>Couch-play Magic</span>
          </div>
        </div>
      </div>
    </div>
  )
}
