import { cardmarketUrl, cardtraderUrl, tcgplayerUrl } from '@/lib/collection/shop-links'

// Buy-a-card links, one per marketplace. No hooks, so server AND client
// components can render it. Two shapes:
//   * ShopLinks       — primary Cardmarket button (with price) + alternates row
//   * ShopLinksInline — one quiet text row, for tight action rows

export function ShopLinks({ name, priceEur }: { name: string; priceEur?: number | null }) {
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <a
        href={cardmarketUrl(name)}
        target="_blank"
        rel="noreferrer"
        className="rounded-lg px-3 py-1.5 text-sm"
        style={{ border: '1px solid rgba(201,154,58,0.4)', color: 'var(--text)' }}
      >
        {priceEur != null ? `€${priceEur.toFixed(2)} · Cardmarket ↗` : 'Cardmarket ↗'}
      </a>
      <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
        <a href={cardtraderUrl(name)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          CardTrader
        </a>
        {' · '}
        <a href={tcgplayerUrl(name)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          TCGplayer
        </a>
      </span>
    </div>
  )
}

export function ShopLinksInline({ name }: { name: string }) {
  return (
    <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
      buy:{' '}
      <a href={cardmarketUrl(name)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
        Cardmarket
      </a>
      {' · '}
      <a href={cardtraderUrl(name)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
        CardTrader
      </a>
      {' · '}
      <a href={tcgplayerUrl(name)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
        TCGplayer
      </a>
    </span>
  )
}
