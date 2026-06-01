import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'

import { buildBehaviorAuthoringGuide } from '@/lib/game/card-behavior-llm'
import { validateCardScript } from '@/lib/game/card-behavior-schema'
import { createClient } from '@/lib/supabase/server'

// POST /api/cards/generate-behavior
// Body: { name?, type_line?, oracle_text }
// Returns: { script, version } | { error }
//
// Turns a card's rules text into a behavior script using Claude, then validates
// the output against the same Zod schema the editor uses (validateCardScript),
// retrying once with the validation errors fed back. The ANTHROPIC_API_KEY never
// leaves the server; the route is gated to authenticated users.

const MODEL = 'claude-opus-4-8'

export async function POST(request: Request) {
  // Gate to signed-in users so the API key can't be exercised anonymously.
  const supabase = await createClient()
  const { data, error: authError } = await supabase.auth.getClaims()
  if (authError || !data?.claims) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json(
      { error: 'AI generation is not configured. Set ANTHROPIC_API_KEY on the server.' },
      { status: 501 },
    )
  }

  let body: { name?: string; type_line?: string; oracle_text?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const oracleText = (body.oracle_text ?? '').trim()
  if (!oracleText) {
    return NextResponse.json(
      { error: 'This card has no rules text to generate behavior from.' },
      { status: 400 },
    )
  }

  const client = new Anthropic({ apiKey })

  const cardDescription = [
    body.name ? `Card name: ${body.name}` : null,
    body.type_line ? `Type line: ${body.type_line}` : null,
    `Rules text:\n${oracleText}`,
    '',
    'Output the behavior script JSON for this card.',
  ]
    .filter(Boolean)
    .join('\n')

  // System prompt is large and stable across requests — cache it.
  const system: Anthropic.TextBlockParam[] = [
    {
      type: 'text',
      text: buildBehaviorAuthoringGuide(),
      cache_control: { type: 'ephemeral' },
    },
  ]

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: cardDescription }]

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 2000,
        thinking: { type: 'adaptive' },
        system,
        messages,
      })

      const rawText = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')

      const parsed = extractJson(rawText)
      if (parsed === null) {
        // Couldn't even parse JSON — ask the model to fix on the next attempt.
        messages.push({ role: 'assistant', content: rawText })
        messages.push({
          role: 'user',
          content: 'That was not valid JSON. Respond with only the JSON object, no prose or code fences.',
        })
        continue
      }

      const validation = validateCardScript(parsed)
      if (validation.success) {
        return NextResponse.json({ script: parsed, version: validation.version })
      }

      // Feed the validation errors back for one corrective attempt.
      messages.push({ role: 'assistant', content: JSON.stringify(parsed) })
      messages.push({
        role: 'user',
        content: `The script failed validation:\n${validation.errors.join('\n')}\nFix it and output only the corrected JSON object.`,
      })
    }

    return NextResponse.json(
      { error: 'The AI could not produce a valid script for this card. Try editing manually.' },
      { status: 422 },
    )
  } catch (err) {
    const message =
      err instanceof Anthropic.APIError
        ? `AI request failed (${err.status}): ${err.message}`
        : err instanceof Error
          ? err.message
          : 'Unknown error generating behavior'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}

// Pull a JSON object out of the model's text — tolerate stray code fences.
function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) {
    return null
  }
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}
