// Shared Claude plumbing for every premium AI feature (deck doctor, combos,
// mulligan trainer, trade builder, game analysis). One place owns the model
// choice, the JSON-only retry loop, and the cached system block — features
// supply a static system prompt (cache-safe) plus a per-request context object.

import Anthropic from '@anthropic-ai/sdk'
import type { z } from 'zod'

export const AI_MODEL = 'claude-opus-4-8'

export class AiNotConfiguredError extends Error {}

export function requireApiKey(explicit?: string): string {
  const key = explicit ?? process.env.ANTHROPIC_API_KEY
  if (!key) throw new AiNotConfiguredError('AI is not configured. Set ANTHROPIC_API_KEY on the server.')
  return key
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}

/** One JSON-shaped exchange: cached static system prompt, JSON context in the
 *  user turn, schema-validated reply with one retry on shape mismatch. */
export async function askClaudeJson<T>(
  apiKey: string,
  systemText: string,
  context: unknown,
  schema: z.ZodType<T>,
  maxTokens = 2000,
): Promise<T> {
  const client = new Anthropic({ apiKey })
  const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: JSON.stringify(context) }]

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await client.messages.create({ model: AI_MODEL, max_tokens: maxTokens, system, messages })
    const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('')
    const validated = schema.safeParse(extractJson(text))
    if (validated.success) return validated.data

    messages.push({ role: 'assistant', content: text })
    messages.push({ role: 'user', content: 'That was not the required JSON shape. Respond with ONLY the JSON object in the exact shape described in the system prompt.' })
  }
  throw new Error('The AI could not produce a valid response.')
}
