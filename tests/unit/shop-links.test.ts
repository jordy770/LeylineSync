// Marketplace buy links — pure URL builders. Names with commas/apostrophes
// must be encoded, and the Impact affiliate wrap must double-encode the
// target URL into the prefix's ?u= parameter (and be a no-op without one).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cardmarketUrl, cardtraderUrl, tcgplayerUrl, wrapAffiliate } from '../../lib/collection/shop-links'

test('shop URLs encode awkward card names', () => {
  const name = "Atraxa, Praetors' Voice"
  assert.equal(cardmarketUrl(name), "https://www.cardmarket.com/en/Magic/Products/Search?searchString=Atraxa%2C%20Praetors'%20Voice")
  assert.ok(cardtraderUrl(name).endsWith("manasearch_results?q=Atraxa%2C%20Praetors'%20Voice"))
  assert.ok(tcgplayerUrl(name).includes("q=Atraxa%2C%20Praetors'%20Voice"))
})

test('wrapAffiliate is a no-op without a prefix and encodes the target with one', () => {
  const target = 'https://www.tcgplayer.com/search/magic/product?productLineName=magic&q=Sol%20Ring'
  assert.equal(wrapAffiliate(target, null), target)
  const wrapped = wrapAffiliate(target, 'https://tcgplayer.pxf.io/c/1/2/21018?u=')
  assert.ok(wrapped.startsWith('https://tcgplayer.pxf.io/c/1/2/21018?u=https%3A%2F%2Fwww.tcgplayer.com'))
  // The target's own query string must survive as one encoded value.
  assert.ok(wrapped.includes('%3FproductLineName%3Dmagic%26q%3DSol%2520Ring'))
})
