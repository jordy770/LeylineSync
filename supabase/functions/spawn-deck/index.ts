import "@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

console.log("Spawn-deck function geactiveerd!")

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    if (req.method !== 'POST') {
      return new Response(
        JSON.stringify({ error: 'Method not allowed' }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 405 },
      )
    }

    // 1. Haal de data uit de request body (gestuurd vanuit je app)
    const { sessionId, deckId } = await req.json()

    // 2. Initialiseer de Supabase Client met Service Role Key
    // Deze keys zijn automatisch beschikbaar in de Supabase cloud omgeving
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const authHeader = req.headers.get('Authorization') ?? ''
    const token = authHeader.replace('Bearer ', '')
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(token)

    if (userError || !user) {
      throw new Error('Authentication required')
    }

    const ownerId = user.id

    const { data: membership, error: membershipError } = await supabase
      .from('game_session_players')
      .select('player_id')
      .eq('session_id', sessionId)
      .eq('player_id', ownerId)
      .maybeSingle()

    if (membershipError) {
      throw new Error(`Kon sessielidmaatschap niet controleren: ${membershipError.message}`)
    }

    if (!membership) {
      throw new Error('Je bent geen speler in deze sessie')
    }

    const { count: existingCardCount, error: existingCardsError } = await supabase
      .from('game_cards')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId)
      .eq('owner_id', ownerId)

    if (existingCardsError) {
      throw new Error(`Kon bestaande kaarten niet controleren: ${existingCardsError.message}`)
    }

    if ((existingCardCount ?? 0) > 0) {
      throw new Error('Deze speler heeft al een deck in deze sessie')
    }

    // 3. Haal de deck-lijst op uit je database
    const { data: deck, error: deckError } = await supabase
      .from('decks')
      .select('list_data')
      .eq('id', deckId)
      .maybeSingle()

    if (deckError) throw new Error(`Deck kon niet worden opgehaald: ${deckError.message}`)

    if (!deck) {
      throw new Error(`Deck niet gevonden voor id: ${deckId}`)
    }

    if (!Array.isArray(deck.list_data)) {
      throw new Error('Deck list_data is leeg of geen array')
    }

    const shuffledCardIds = shuffleArray(deck.list_data)

    // 4. Transformeer de deck-lijst naar rijen voor game_cards[cite: 1]
    const cardsToSpawn = shuffledCardIds.map((card_id: string, index: number) => ({
      session_id: sessionId,
      card_id: card_id,
      owner_id: ownerId,
      zone: 'library', // De kaarten beginnen in je deck/stapel[cite: 1]
      zone_position: index,
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
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    )

  } catch (error) {
    // Foutafhandeling[cite: 1]
    const message = error instanceof Error ? error.message : String(error)

    return new Response(
      JSON.stringify({ error: message }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 },
    )
  }
})

function shuffleArray<T>(items: T[]) {
  const shuffled = [...items]

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1))
    const item = shuffled[index]
    shuffled[index] = shuffled[randomIndex]
    shuffled[randomIndex] = item
  }

  return shuffled
}
