import "@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

console.log("Spawn-deck function geactiveerd!")

Deno.serve(async (req) => {
  try {
    // 1. Haal de data uit de request body (gestuurd vanuit je app)
    const { sessionId, deckId, ownerId } = await req.json()

    // 2. Initialiseer de Supabase Client met Service Role Key
    // Deze keys zijn automatisch beschikbaar in de Supabase cloud omgeving
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // 3. Haal de deck-lijst op uit je database
    const { data: deck, error: deckError } = await supabase
      .from('decks')
      .select('list_data')
      .eq('id', deckId)
      .single()

    if (deckError) throw new Error(`Deck niet gevonden: ${deckError.message}`)

    // 4. Transformeer de deck-lijst naar rijen voor game_cards[cite: 1]
    const cardsToSpawn = deck.list_data.map((card_id: string) => ({
      session_id: sessionId,
      card_id: card_id,
      owner_id: ownerId,
      zone: 'library', // De kaarten beginnen in je deck/stapel[cite: 1]
      is_tapped: false,
      position_x: 0,
      position_y: 0
    }))

    // 5. Bulk insert in de database (zeer efficiënt voor 60 kaarten)[cite: 1]
    const { error: insertError } = await supabase
      .from('game_cards')
      .insert(cardsToSpawn)

    if (insertError) throw new Error(`Fout bij spawnen: ${insertError.message}`)

    // 6. Succesvolle Response[cite: 1]
    return new Response(
      JSON.stringify({ 
        message: "Deck succesvol gespawnd!", 
        count: cardsToSpawn.length 
      }),
      { headers: { "Content-Type": "application/json" }, status: 200 },
    )

  } catch (error) {
    // Foutafhandeling[cite: 1]
    const message = error instanceof Error ? error.message : String(error)

    return new Response(
      JSON.stringify({ error: message }),
      { headers: { "Content-Type": "application/json" }, status: 400 },
    )
  }
})
