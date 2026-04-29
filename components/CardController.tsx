'use client'

import { useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function CardController({
  cardId,
  isTapped,
}: {
  cardId: string
  isTapped: boolean
}) {
  const supabase = useMemo(() => createClient(), [])

  const toggleTapped = async () => {
    await supabase
      .from('game_cards')
      .update({ is_tapped: !isTapped })
      .eq('id', cardId)
  }

  return (
    <button
      type="button"
      onClick={toggleTapped}
      className="rounded-md bg-white px-3 py-2 text-sm font-medium text-slate-900"
    >
      {isTapped ? 'Untap' : 'Tap'}
    </button>
  )
}
