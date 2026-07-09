'use client'

import { useState } from 'react'

// The binder theme's signature element: a card in a plastic pocket. Loads the
// real Scryfall scan (browser <img> — the UA problem only bites server-side
// fetches, see image-loader.ts); falls back to a color-identity gradient with
// the name overlaid when the scan can't load.

const MANA_GRADIENT: Record<string, string> = {
  W: 'linear-gradient(150deg,#8a8262,#26241c 72%)',
  U: 'linear-gradient(150deg,#2e4152,#12181d 72%)',
  B: 'linear-gradient(150deg,#3a2e52,#191722 72%)',
  R: 'linear-gradient(150deg,#54372e,#1d1512 72%)',
  G: 'linear-gradient(150deg,#2e5237,#141d17 72%)',
}
const FALLBACK_GRADIENT = 'linear-gradient(150deg,#4a4a52,#1a1a20 72%)'

export function CardPocket({
  name,
  colors = [],
  priceEur,
  qty,
  dimmed = false,
  className = '',
}: {
  name: string
  colors?: string[]
  priceEur?: number | null
  qty?: number
  dimmed?: boolean
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  const src = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=image&version=normal`
  const gradient = MANA_GRADIENT[colors[0]?.toUpperCase() ?? ''] ?? FALLBACK_GRADIENT

  return (
    <div className={`bnd-pocket ${dimmed ? 'bnd-dimmed' : ''} ${className}`} title={name}>
      {failed ? (
        <>
          <div style={{ position: 'absolute', inset: 0, background: gradient }} />
          <span className="bnd-pocket-name">{name}</span>
        </>
      ) : (
        // Scryfall serves ready-made scans; next/image adds nothing here.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={name} loading="lazy" onError={() => setFailed(true)} />
      )}
      {qty != null && qty > 1 ? <em className="bnd-badge left">×{qty}</em> : null}
      {priceEur != null ? <em className="bnd-badge">€{priceEur.toFixed(priceEur >= 10 ? 0 : 2)}</em> : null}
    </div>
  )
}
