import { NextResponse } from 'next/server'

import { AiNotConfiguredError } from '@/lib/collection/ai-client'
import { analyzeGame } from '@/lib/collection/ai-game-analysis'
import { requireAiCredit } from '@/lib/collection/ai-gate'
import { createClient } from '@/lib/supabase/server'

// POST /api/games/:id/analyze — premium post-game coaching from the engine's
// own action log. RLS on game_action_log already limits reads to session
// members, so a stranger's session yields "too little logged action".

const ANALYSIS_MONTHLY_LIMIT = 20

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data, error: authError } = await supabase.auth.getClaims()
  if (authError || !data?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const userId = data.claims.sub as string
  const { id: sessionId } = await params

  const gate = await requireAiCredit(supabase, 'game_analysis', ANALYSIS_MONTHLY_LIMIT)
  if (gate) return gate

  try {
    const outcome = await analyzeGame(supabase, userId, sessionId)
    if (outcome.error) return NextResponse.json({ error: outcome.error }, { status: 422 })
    return NextResponse.json(outcome.result)
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 501 })
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Analysis failed' }, { status: 502 })
  }
}
