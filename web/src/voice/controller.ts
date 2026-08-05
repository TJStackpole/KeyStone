// ---------------------------------------------------------------------------
// Prompt 15 — the voice pipeline: transcript → Tier A grammar (local, <50ms,
// offline) → Tier B LLM fallback (online, closed schema) → action layer.
//
// Tier A matches NEVER route through the LLM — determinism and latency are
// the point. Tier B is only consulted when the grammar has no answer, and it
// can only return an intent from the same closed set (or no_match); the
// safety split is enforced downstream in registry.executeIntent either way.
// ---------------------------------------------------------------------------

import { getAppState, setAppState } from '../state/store'
import { matchGrammar } from './grammar'
import { cancelPending, confirmPending, executeIntent, intentManifest, type ExecResult } from './registry'
import { interpretRemote } from './tierB'

let echoTimer: ReturnType<typeof setTimeout> | null = null

function showEcho(result: ExecResult): void {
  setAppState({ voiceEcho: { text: result.echo, tone: result.tone ?? (result.ok ? 'ok' : 'warn') } })
  if (echoTimer) clearTimeout(echoTimer)
  // Queries carry multi-line answers — hold those a little longer than the
  // 2-second action echo so they are actually readable.
  const holdMs = result.echo.includes('\n') ? 6000 : 2200
  echoTimer = setTimeout(() => setAppState({ voiceEcho: null }), holdMs)
  earcon(result.ok)
  if (result.speak && getAppState().voiceReplies) speak(result.speak)
}

/** Soft earcon — a 60ms sine blip, no audio assets needed. */
function earcon(ok: boolean): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = ok ? 880 : 220
    gain.gain.value = 0.04
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.06)
    osc.onended = () => void ctx.close()
  } catch {
    /* no audio device */
  }
}

function speak(text: string): void {
  try {
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 1.05
    window.speechSynthesis.speak(u)
  } catch {
    /* no synthesis */
  }
}

/**
 * The end of an utterance (PTT release, or a scenario-injected transcript).
 * `tier` in the log records which path answered.
 */
export async function handleFinalTranscript(raw: string, origin: 'ptt' | 'scenario' = 'ptt'): Promise<void> {
  const t0 = performance.now()
  const text = raw.trim()
  setAppState({ voicePartial: '' })
  if (!text) return

  const pendingConfirm = getAppState().voiceConfirm !== null
  const parsed = matchGrammar(text, pendingConfirm)

  // Held-PTT confirm/cancel while a drafted action is up.
  if (parsed?.intent === 'confirm_pending') {
    const result = await confirmPending()
    if (result) showEcho(result)
    return
  }
  if (parsed?.intent === 'cancel_pending') {
    const result = cancelPending()
    if (result) showEcho(result)
    return
  }

  if (parsed) {
    const result = await executeIntent(parsed.intent, parsed.slots, {
      tier: origin === 'scenario' ? 'scenario' : 'A',
      transcript: text,
      t0,
    })
    showEcho(result)
    return
  }

  // Tier B — online only, closed schema. Offline: honest no-match.
  if (!navigator.onLine) {
    showEcho({ ok: false, echo: `OFFLINE — CORE COMMANDS ONLY\n“${text}”`, tone: 'warn' })
    return
  }
  const remote = await interpretRemote(text, intentManifest())
  if (remote.unavailable) {
    showEcho({ ok: false, echo: `“${text}”\nDIDN'T CATCH A COMMAND (ASSISTANT TIER ${remote.reason ?? 'OFFLINE'})`, tone: 'warn' })
    return
  }
  if (!remote.intent) {
    // Never guess, never execute low confidence: transcript + no-match chip.
    showEcho({ ok: false, echo: `“${text}”\nDIDN'T CATCH A COMMAND`, tone: 'warn' })
    return
  }
  const result = await executeIntent(remote.intent, remote.slots ?? {}, {
    tier: 'B',
    transcript: text,
    t0,
  })
  showEcho(result)
}

/** Scenario engine hook: scripted `voice_command` events inject transcripts
 *  directly into the intent tier — the dual-screen demo shows voice control
 *  with zero ASR keys and no live audio. */
export function injectTranscript(transcript: string): void {
  setAppState({ voicePartial: transcript })
  window.setTimeout(() => void handleFinalTranscript(transcript, 'scenario'), 450)
}

/** Tap handlers for the confirm chip (same gate as the voice path). */
export async function tapConfirm(): Promise<void> {
  const result = await confirmPending()
  if (result) showEcho(result)
}
export function tapCancel(): void {
  const result = cancelPending()
  if (result) showEcho(result)
}
