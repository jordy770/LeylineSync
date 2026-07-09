// The binder theme's typography (Outfit for display, Karla for body), shared
// by every page that wears the .binder-shell wrapper: the collection, the
// landing and the decks page. next/font requires module-scope consts.

import { Karla, Outfit } from 'next/font/google'

const outfit = Outfit({ subsets: ['latin'], variable: '--font-outfit', weight: ['400', '500', '600', '700'] })
const karla = Karla({ subsets: ['latin'], variable: '--font-karla', weight: ['400', '500', '600', '700'] })

export const binderFonts = `${outfit.variable} ${karla.variable}`
