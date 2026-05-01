'use client' // Cruciaal voor het gebruik van de client en hooks

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { addManaFromCard, getErrorMessage } from '@/lib/game/actions'
import type { CardScript } from '@/lib/game/types'

type CardWithScript = {
  id: string
  is_tapped: boolean
  cards?: {
    script?: CardScript | null
  } | null
}

interface ActionButtonsProps {
  card: CardWithScript;      // De kaart data inclusief het script
  sessionId: string;
  playerId: string;
}

export default function ActionButtons({ card, sessionId, playerId }: ActionButtonsProps) {
  const supabase = useMemo(() => createClient(), [])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  
  // Haal het script op uit de gejoinde 'cards' tabel
  const script = card.cards?.script;
  const requiresManualTap = script?.triggers?.includes('manual_tap') ?? false

  // Stop als er geen script of acties zijn
  if (!script || !script.actions) return null;

  const handleManaAction = async (color: string, amount: number) => {
    setErrorMessage(null)

    if (requiresManualTap && card.is_tapped) {
      return
    }

    try {
      await addManaFromCard({
        supabase,
        cardId: card.id,
        sessionId,
        playerId,
        color,
        amount,
        shouldTapCard: requiresManualTap,
      })
      
      console.log(`Mana toegevoegd: ${amount}x ${color}`);
    } catch (err) {
      const message = getErrorMessage(err)
      console.error('Fout bij bijwerken mana:', message, err);
      setErrorMessage(message)
    }
  };

  return (
    <div className="space-y-2 p-4">
      <div className="grid grid-cols-2 gap-3">
        {script.actions.map((action, index) => {
          // Alleen knoppen tekenen voor acties die we al ondersteunen
          if (action.type === 'add_mana' && action.color && typeof action.amount === 'number') {
            const color = action.color
            const amount = action.amount
            const isDisabled = requiresManualTap && card.is_tapped

            return (
              <button
                key={index}
                type="button"
                disabled={isDisabled}
                onClick={() => handleManaAction(color, amount)}
                className="flex items-center justify-center gap-2 bg-zinc-800 border border-zinc-700 p-3 rounded-xl transition-transform active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="font-bold text-white">
                  {requiresManualTap ? 'Tap: ' : ''}Add {amount} {color}
                </span>
              </button>
            );
          }
          
          // Voeg hier later andere acties toe, zoals 'deal_damage'
          return null;
        })}
      </div>
      {errorMessage ? <p className="text-xs text-red-300">{errorMessage}</p> : null}
    </div>
  );
}
