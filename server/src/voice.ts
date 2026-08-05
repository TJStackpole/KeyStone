// ---------------------------------------------------------------------------
// Prompt 15 — Tier B of the voice command layer: the LLM fallback.
//
// The client sends the FINAL transcript, a compact incident snapshot, and the
// closed intent manifest (generated from the same registry the local grammar
// executes against). A Haiku-class Claude picks exactly ONE tool from that
// set — or no_match. The schema IS the security boundary: the model has no
// free-text action path, and the client's action layer re-applies the
// instant/confirm/deny split to whatever comes back, so Tier B can never
// bypass a confirmation or the tap-only deny list.
//
// Keyless-by-default: without ANTHROPIC_API_KEY this endpoint answers 503 and
// the client shows "assistant tier unavailable" — Tier A keeps working.
// ---------------------------------------------------------------------------

import Anthropic from '@anthropic-ai/sdk'
import type { Request, Response } from 'express'

interface WireIntent {
  id: string
  description: string
  slots: Record<string, { description: string; enum?: string[] }>
}

const ID_RE = /^[a-z0-9_]{1,48}$/
const MODEL = 'claude-haiku-4-5' // per the P15 spec: cheap, fast, tool-calling

let client: Anthropic | null = null
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null
  if (!client) client = new Anthropic()
  return client
}

function toTools(intents: WireIntent[]): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = intents.map((it) => ({
    name: it.id,
    description: it.description.slice(0, 400),
    input_schema: {
      type: 'object' as const,
      properties: Object.fromEntries(
        Object.entries(it.slots).map(([k, v]) => [
          k,
          v.enum ? { type: 'string', description: v.description.slice(0, 200), enum: v.enum.slice(0, 50) } : { type: 'string', description: v.description.slice(0, 200) },
        ]),
      ),
      additionalProperties: false,
    },
  }))
  tools.push({
    name: 'no_match',
    description:
      'The transcript does not map to ANY listed command. Always prefer this over guessing — a wrong action on a fireground console is worse than no action.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  })
  return tools
}

export async function interpretVoice(req: Request, res: Response): Promise<void> {
  const anthropic = getClient()
  if (!anthropic) {
    res.status(503).json({ error: 'tier B unavailable — set ANTHROPIC_API_KEY to enable the LLM fallback' })
    return
  }
  const { transcript, context, intents } = req.body as {
    transcript?: string
    context?: unknown
    intents?: WireIntent[]
  }
  const text = (transcript ?? '').trim().slice(0, 500)
  if (!text) {
    res.status(400).json({ error: 'transcript required' })
    return
  }
  if (!Array.isArray(intents) || intents.length === 0 || intents.length > 120 || intents.some((i) => !ID_RE.test(i.id))) {
    res.status(400).json({ error: 'invalid intent manifest' })
    return
  }
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 512,
      system:
        'You route voice transcripts from a fire-department incident commander to console commands. ' +
        'Call exactly ONE tool: the single command the transcript asks for, with slots filled from the transcript ' +
        'and the provided incident context. Transcripts are speech-to-text: expect homophones ' +
        '("exposure to" means exposure 2) and unit designators like "ladder 118". ' +
        'If the transcript is not clearly one of the listed commands, call no_match — never guess.',
      tool_choice: { type: 'any', disable_parallel_tool_use: true },
      tools: toTools(intents),
      messages: [
        {
          role: 'user',
          content: `TRANSCRIPT: "${text}"\n\nINCIDENT CONTEXT:\n${JSON.stringify(context ?? {}, null, 1).slice(0, 6000)}`,
        },
      ],
    })
    const call = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    if (!call || call.name === 'no_match') {
      res.json({ noMatch: true })
      return
    }
    // Belt and braces: the name must be one the CLIENT declared.
    if (!intents.some((i) => i.id === call.name)) {
      res.json({ noMatch: true })
      return
    }
    const slots: Record<string, string> = {}
    for (const [k, v] of Object.entries((call.input ?? {}) as Record<string, unknown>)) {
      if (typeof v === 'string') slots[k] = v.slice(0, 300)
      else if (typeof v === 'number') slots[k] = String(v)
    }
    res.json({ intent: call.name, slots })
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      console.warn('[voice] tier B API error:', err.status, err.message)
      res.status(502).json({ error: `assistant tier error (${err.status ?? 'network'})` })
      return
    }
    console.warn('[voice] tier B failed:', err)
    res.status(502).json({ error: 'assistant tier error' })
  }
}
