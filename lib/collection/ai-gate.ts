// The one paywall/quota gate every premium AI route calls before touching the
// model. Wraps consume_ai_credit (mig 382) and translates its verdict into the
// HTTP responses the UI understands (402 premium_required / 429 quota_exceeded).
// Returns null when the call may proceed.

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

export async function requireAiCredit(
  supabase: SupabaseClient,
  feature: string,
  limit: number,
): Promise<NextResponse | null> {
  const { data: credit, error } = await supabase.rpc('consume_ai_credit', { p_feature: feature, p_limit: limit })
  if (error) {
    return NextResponse.json({ error: `Credit check failed: ${error.message}` }, { status: 500 })
  }
  if (!credit?.allowed) {
    if (credit?.reason === 'premium_required') {
      return NextResponse.json(
        { error: 'This is a premium AI feature.', code: 'premium_required' },
        { status: 402 },
      )
    }
    return NextResponse.json(
      {
        error: `Monthly AI limit reached (${credit?.used ?? '?'}/${credit?.limit ?? limit}) — resets next month.`,
        code: 'quota_exceeded',
      },
      { status: 429 },
    )
  }
  return null
}
