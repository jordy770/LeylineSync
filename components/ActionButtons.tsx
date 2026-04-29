'use client' // Cruciaal voor het gebruik van de client en hooks

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type ManaPool = Record<string, number>

type CardAction = {
  type: string
  color?: string
  amount?: number
}

type CardWithScript = {
  id: string
  is_tapped: boolean
  cards?: {
    script?: {
      actions?: CardAction[]
      triggers?: string[]
    } | null
  } | null
}

type SupabaseErrorLike = {
  code?: string
  details?: string
  hint?: string
  message?: string
}

interface ActionButtonsProps {
  card: CardWithScript;      // De kaart data inclusief het script
  sessionId: string;
  playerId: string;
}

function isSupabaseErrorLike(error: unknown): error is SupabaseErrorLike {
  return typeof error === 'object' && error !== null && 'message' in error
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  if (isSupabaseErrorLike(error)) {
    return [
      error.message,
      error.code ? `Code: ${error.code}` : null,
      error.details,
      error.hint,
    ]
      .filter(Boolean)
      .join(' ')
  }

  return 'Er is een onbekende fout opgetreden'
}

export default function ActionButtons({ card, sessionId, playerId }: ActionButtonsProps) {
  const supabase = createClient()
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
      if (requiresManualTap) {
        const { error: tapError } = await supabase
          .from('game_cards')
          .update({ is_tapped: true })
          .eq('id', card.id)
          .eq('is_tapped', false)

        if (tapError) throw tapError;
      }

      // 1. Haal de huidige mana_pool op van de speler in deze sessie
      const { data, error } = await supabase
        .from('game_players')
        .select('mana_pool')
        .eq('session_id', sessionId)
        .eq('player_id', playerId)
        .maybeSingle();

      if (error) throw error;

      // 2. Bereken de nieuwe pool
      const currentPool = (data?.mana_pool as ManaPool | null) || { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
      const newPool = { 
        ...currentPool, 
        [color]: (currentPool[color] || 0) + amount 
      };

      // 3. Update de database (Realtime zorgt voor de rest)
      const { error: updateError } = data
        ? await supabase
            .from('game_players')
            .update({ mana_pool: newPool })
            .eq('session_id', sessionId)
            .eq('player_id', playerId)
        : await supabase
            .from('game_players')
            .insert({
              session_id: sessionId,
              player_id: playerId,
              mana_pool: newPool,
            });

      if (updateError) throw updateError;
      
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
