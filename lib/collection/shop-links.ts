// Marketplace deep links for buying a card — pure URL builders, no I/O.
//
// Cardmarket is the primary (EU audience); CardTrader and TCGplayer are the
// alternates. Only TCGplayer runs a real link-based affiliate program (Impact,
// first-click, whole-cart — verified 2026-07-08); Cardmarket and CardTrader
// only have capped refer-a-friend credit, so those links are pure UX.
//
// Affiliate: once the Impact account exists, paste its deep-link prefix
// (everything up to and including `?u=`, e.g.
// 'https://tcgplayer.pxf.io/c/<partnerId>/<adId>/21018?u=') into
// TCGPLAYER_AFFILIATE_PREFIX and every TCGplayer link becomes tracked.

export const TCGPLAYER_AFFILIATE_PREFIX: string | null = null

/** Wrap a target URL in an Impact-style deep-link prefix (no-op without one). */
export function wrapAffiliate(url: string, prefix: string | null): string {
  return prefix ? `${prefix}${encodeURIComponent(url)}` : url
}

export function cardmarketUrl(name: string): string {
  return `https://www.cardmarket.com/en/Magic/Products/Search?searchString=${encodeURIComponent(name)}`
}

export function cardtraderUrl(name: string): string {
  // The site's own search endpoint (the /en/search page's form action).
  return `https://www.cardtrader.com/en/manasearch_results?q=${encodeURIComponent(name)}`
}

export function tcgplayerUrl(name: string): string {
  const url = `https://www.tcgplayer.com/search/magic/product?productLineName=magic&q=${encodeURIComponent(name)}`
  return wrapAffiliate(url, TCGPLAYER_AFFILIATE_PREFIX)
}
