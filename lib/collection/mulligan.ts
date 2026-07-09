// Pure sample-hand drawing for the mulligan trainer. The caller supplies the
// randomness (Math.random in the UI, a seeded fn in tests).

export interface HandDeckCard {
  name: string
  qty: number
  isCommander: boolean
}

export function drawSampleHand(cards: HandDeckCard[], rand: () => number, size = 7): string[] {
  const pool: string[] = []
  for (const c of cards) {
    if (c.isCommander) continue // the commander starts in the command zone
    for (let i = 0; i < c.qty; i += 1) pool.push(c.name)
  }
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, Math.min(size, pool.length))
}
