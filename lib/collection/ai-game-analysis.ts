// Post-game analysis — the feature only LeylineSync can build: the app IS the
// table, so the engine's own action log (game_action_log) is the ground truth.
// The model narrates what actually happened for YOUR seat: key moments, what
// went wrong, and what the deck should learn from it.

import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'

import { askClaudeJson, requireApiKey } from './ai-client'

const MAX_LOG_LINES = 400
const MAX_LOG_CHARS = 14000

const ReplySchema = z.object({
  summary: z.string(),
  keyMoments: z.array(z.string()),
  whatToImprove: z.array(z.string()),
  deckAdvice: z.array(z.string()),
})

export type GameAnalysis = z.infer<typeof ReplySchema>

const SYSTEM = `You are a Magic: The Gathering Commander game coach analysing a finished multiplayer game from the ENGINE'S OWN ACTION LOG.
The log lines are real events ("You: casts Sol Ring", "Opponent 2: life 9 → 6"). "You" is the player being coached; other seats are labeled Opponent 1..N.
Deliver:
- "summary": 2-4 sentences — how the game went for You and (if determinable) how it was won or lost.
- "keyMoments": 2-5 turning points, each one sentence, referencing actual log events.
- "whatToImprove": 2-4 concrete play-pattern observations about You (sequencing, threat assessment, resource use). Ground every claim in the log — if the log is too sparse to judge something, don't invent it.
- "deckAdvice": 1-3 deck-level takeaways ("you never held interaction for X", "your curve stalled on 3 twice"). Phrase them so the player can paste one into the AI Deck Doctor's goal field.
Rules: only reference cards and events that appear in the log. If the log is too thin for real analysis, say exactly that in the summary and keep the lists short.
Respond with ONLY a JSON object: {"summary": string, "keyMoments": [string], "whatToImprove": [string], "deckAdvice": [string]}. No prose, no code fences.`

export async function analyzeGame(
  supabase: SupabaseClient,
  userId: string,
  sessionId: string,
  options: { apiKey?: string } = {},
): Promise<{ result?: GameAnalysis; error?: string }> {
  const apiKey = requireApiKey(options.apiKey)

  // RLS: only session members can read the log — a non-member gets 0 rows.
  const { data: rows, error } = await supabase
    .from('game_action_log')
    .select('actor_player_id, description, created_at')
    .eq('session_id', sessionId)
    .is('undone_at', null)
    .order('created_at', { ascending: true })
    .limit(2000)
  if (error) return { error: `Could not read the game log: ${error.message}` }
  if (!rows || rows.length < 10) {
    return { error: 'This game has too little logged action to analyse.' }
  }

  // Label seats: You + Opponent N (stable by first appearance).
  const labels = new Map<string, string>()
  labels.set(userId, 'You')
  let opponentN = 0
  for (const r of rows) {
    const actor = r.actor_player_id as string | null
    if (actor && !labels.has(actor)) {
      opponentN += 1
      labels.set(actor, `Opponent ${opponentN}`)
    }
  }
  if (!rows.some((r) => r.actor_player_id === userId)) {
    return { error: 'You took no logged actions in this game.' }
  }

  let lines: string[] = rows.map((r) => `${labels.get(r.actor_player_id as string) ?? 'Someone'}: ${r.description}`)
  // Keep the END of long games — that's where they're decided.
  if (lines.length > MAX_LOG_LINES) lines = lines.slice(lines.length - MAX_LOG_LINES)
  while (lines.join('\n').length > MAX_LOG_CHARS && lines.length > 50) lines = lines.slice(25)

  const context = { players: [...labels.values()], log: lines }
  const result = await askClaudeJson(apiKey, SYSTEM, context, ReplySchema, 1500)
  return { result }
}
