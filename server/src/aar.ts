import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REQUEST_THRESHOLDS_MS,
  type EocChange,
  type InteragencyRequest,
  type PlanActivation,
  type TickerEvent,
} from './nycem.js'
import type { TriggerSuggestion } from './weather.js'
import type { TimelineEvent } from './types.js'

// ---------------------------------------------------------------------------
// Prompt 11 Module 8 — AAR / Exercise package generator.
// Structured to the HSEEP AAR/Improvement Plan format (public FEMA standard):
// exercise overview, timeline of key events, objectives vs observed
// performance, strengths, areas for improvement (auto-flagged), and an
// improvement-plan table with EMPTY owner/deadline columns for the
// facilitator. Every auto-filled item carries its source events; the
// facilitator review screen can edit anything; export is manual only —
// KeyStone never auto-distributes.
// ---------------------------------------------------------------------------

export interface AarMetric {
  name: string
  value: string
  detail: string
  /** Timestamps / ids of the events this number came from. */
  sources: string[]
}

export interface AarFinding {
  area: string
  finding: string
  sources: string[]
}

export interface AarDraft {
  title: string
  generatedAt: string
  overview: {
    exerciseName: string
    date: string
    durationMin: number
    scope: string
    participatingAgencies: string[]
  }
  keyEvents: { at: string; text: string }[]
  objectives: { objective: string; observed: string; met: 'met' | 'partial' | 'not observed' }[]
  strengths: AarFinding[]
  improvements: AarFinding[]
  improvementPlan: { item: string; owner: string; deadline: string }[]
  metrics: AarMetric[]
}

export interface ExerciseSession {
  id: string
  scenario: string
  startedAt: string
  endedAt: string
  aar: AarDraft
  /** Raw evidence the review screen links back to. */
  evidence: {
    timeline: TimelineEvent[]
    ticker: TickerEvent[]
    requests: InteragencyRequest[]
    eocChanges: EocChange[]
    plans: PlanActivation[]
    suggestions: TriggerSuggestion[]
  }
}

const EXERCISE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../data/exercises')

const fmtMs = (ms: number) => {
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return m ? `${m}m ${s}s` : `${s}s`
}

export function generateAar(input: {
  scenario: string
  startedAt: string
  endedAt: string
  timeline: TimelineEvent[]
  ticker: TickerEvent[]
  requests: InteragencyRequest[]
  eocChanges: EocChange[]
  plans: PlanActivation[]
  suggestions: TriggerSuggestion[]
}): ExerciseSession {
  const t0 = Date.parse(input.startedAt)
  const t1 = Date.parse(input.endedAt)
  const inWindow = (iso: string) => {
    const t = Date.parse(iso)
    return t >= t0 && t <= t1 + 60_000
  }
  const requests = input.requests.filter((r) => inWindow(r.createdAt))
  const eocChanges = input.eocChanges.filter((c) => inWindow(c.changedAt))
  const plans = input.plans.filter((p) => inWindow(p.activatedAt))
  const suggestions = input.suggestions.filter((s) => inWindow(s.firedAt))
  const timeline = input.timeline.filter((e) => inWindow(e.t))

  const agencies = new Set<string>()
  for (const r of requests) {
    agencies.add(r.requestingAgency)
    agencies.add(r.assignedAgency)
  }

  // ---- metrics, each linked to its sources -------------------------------
  const metrics: AarMetric[] = []

  const firstAccepted = suggestions.find((s) => s.state === 'accepted')
  if (firstAccepted) {
    metrics.push({
      name: 'Trigger-to-acceptance',
      value: fmtMs(Date.parse(firstAccepted.decidedAt!) - Date.parse(firstAccepted.firedAt)),
      detail: `${firstAccepted.plan} suggestion fired ${firstAccepted.firedAt}, accepted by ${firstAccepted.decidedBy}`,
      sources: [firstAccepted.id, firstAccepted.product.id],
    })
  }

  for (const r of requests) {
    const ack = r.transitions.find((t) => t.state === 'acknowledged')
    const done = r.transitions.find((t) => t.state === 'complete')
    if (done) {
      metrics.push({
        name: `Request cycle — ${r.requestingAgency}→${r.assignedAgency}`,
        value: fmtMs(Date.parse(done.at) - Date.parse(r.createdAt)),
        detail: `${r.description} (${r.priority}${ack ? `, acked in ${fmtMs(Date.parse(ack.at) - Date.parse(r.createdAt))}` : ', never acknowledged'})`,
        sources: [r.id],
      })
    }
  }

  const mayday = timeline.find((e) => e.kind === 'alert.mayday')
  if (mayday) {
    const fast = timeline.find(
      (e) => Date.parse(e.t) > Date.parse(mayday.t) && JSON.stringify(e.payload ?? '').toLowerCase().includes('fast'),
    )
    metrics.push({
      name: 'Mayday-to-FAST interval',
      value: fast ? fmtMs(Date.parse(fast.t) - Date.parse(mayday.t)) : 'FAST deployment not observed',
      detail: fast ? 'From mayday declaration to FAST/FAST-truck committal' : 'No FAST event found after mayday',
      sources: [mayday.t, ...(fast ? [fast.t] : [])],
    })
  }

  const pars = timeline.filter((e) => JSON.stringify(e).toLowerCase().includes('"par'))
  if (pars.length >= 2) {
    metrics.push({
      name: 'PAR completion',
      value: fmtMs(Date.parse(pars[pars.length - 1].t) - Date.parse(pars[0].t)),
      detail: `${pars.length} PAR events observed`,
      sources: pars.map((p) => p.t),
    })
  }

  // ---- auto-flagged improvement areas -------------------------------------
  const improvements: AarFinding[] = []
  for (const r of requests) {
    const ack = r.transitions.find((t) => t.state === 'acknowledged')
    const ackMs = ack ? Date.parse(ack.at) - Date.parse(r.createdAt) : t1 - Date.parse(r.createdAt)
    if (ackMs > REQUEST_THRESHOLDS_MS[r.priority]) {
      improvements.push({
        area: 'Interagency coordination',
        finding: `${r.priority.toUpperCase()} request "${r.description}" (${r.requestingAgency}→${r.assignedAgency}) ${ack ? `took ${fmtMs(ackMs)} to acknowledge` : 'was never acknowledged'} — exceeds the ${fmtMs(REQUEST_THRESHOLDS_MS[r.priority])} threshold (threshold VALIDATE—SME).`,
        sources: [r.id],
      })
    }
  }
  for (const s of suggestions) {
    if (s.state === 'pending') {
      improvements.push({
        area: 'Plan activation',
        finding: `Weather trigger for ${s.plan} fired at ${s.firedAt} and was never actioned during the exercise.`,
        sources: [s.id],
      })
    }
  }
  if (mayday && !metrics.some((m) => m.name === 'Mayday-to-FAST interval' && !m.value.includes('not observed'))) {
    improvements.push({
      area: 'Member safety',
      finding: 'A mayday was declared but no FAST deployment event was recorded.',
      sources: [mayday.t],
    })
  }

  // ---- strengths -----------------------------------------------------------
  const strengths: AarFinding[] = []
  const fastAcks = requests.filter((r) => {
    const ack = r.transitions.find((t) => t.state === 'acknowledged')
    return ack && Date.parse(ack.at) - Date.parse(r.createdAt) < REQUEST_THRESHOLDS_MS[r.priority] / 2
  })
  if (fastAcks.length) {
    strengths.push({
      area: 'Interagency coordination',
      finding: `${fastAcks.length} of ${requests.length} requests acknowledged in under half the priority threshold.`,
      sources: fastAcks.map((r) => r.id),
    })
  }
  if (firstAccepted) {
    strengths.push({
      area: 'Plan activation',
      finding: `${firstAccepted.plan} trigger recognized and actioned by ${firstAccepted.decidedBy}.`,
      sources: [firstAccepted.id],
    })
  }
  if (eocChanges.length) {
    const c = eocChanges[0]
    strengths.push({
      area: 'EOC posture',
      finding: `EOC level moved to ${c.level} by ${c.changedBy} at ${c.changedAt} — logged with attribution.`,
      sources: [c.changedAt],
    })
  }

  // ---- objectives (generic HSEEP-style; facilitator edits) -----------------
  const objectives: AarDraft['objectives'] = [
    {
      objective: 'Establish a common operating picture across all concurrent incidents',
      observed: `Watch Command view tracked ${new Set(input.ticker.filter((e) => e.kind === 'new-incident' && inWindow(e.ts)).map((e) => e.incidentId)).size || 'multiple'} incidents concurrently.`,
      met: 'met',
    },
    {
      objective: 'Track interagency requests through their full lifecycle with attribution',
      observed: `${requests.length} requests processed; ${requests.filter((r) => r.state === 'complete').length} completed, ${requests.filter((r) => r.state === 'declined').length} declined.`,
      met: requests.length ? 'met' : 'not observed',
    },
    {
      objective: 'Recognize weather triggers and make a documented activation decision',
      observed: firstAccepted
        ? `Trigger accepted; EOC moved per plan suggestion.`
        : suggestions.length
          ? 'Trigger fired but decision pending at exercise end.'
          : 'No trigger fired during the window.',
      met: firstAccepted ? 'met' : suggestions.length ? 'partial' : 'not observed',
    },
  ]

  const keyEvents: AarDraft['keyEvents'] = [
    ...input.ticker.filter((e) => inWindow(e.ts)).map((e) => ({ at: e.ts, text: e.text })),
  ].sort((a, b) => a.at.localeCompare(b.at))

  const aar: AarDraft = {
    title: `After-Action Report / Improvement Plan (DRAFT) — ${input.scenario}`,
    generatedAt: new Date().toISOString(),
    overview: {
      exerciseName: input.scenario,
      date: input.startedAt.slice(0, 10),
      durationMin: Math.round((t1 - t0) / 60_000),
      scope: 'Functional exercise conducted on the KeyStone coordination layer (SIMULATED — no live operations).',
      participatingAgencies: [...agencies].sort(),
    },
    keyEvents,
    objectives,
    strengths,
    improvements,
    improvementPlan: improvements.map((i) => ({ item: i.finding, owner: '', deadline: '' })),
    metrics,
  }

  return {
    id: `EX-${Date.now().toString(36).toUpperCase()}`,
    scenario: input.scenario,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    aar,
    evidence: { timeline, ticker: input.ticker.filter((e) => inWindow(e.ts)), requests, eocChanges, plans, suggestions },
  }
}

// ------------------------------ Exercise library -----------------------------

export function saveExercise(session: ExerciseSession): void {
  mkdirSync(EXERCISE_DIR, { recursive: true })
  writeFileSync(resolve(EXERCISE_DIR, `${session.id}.json`), JSON.stringify(session))
}

export function listExercises(): { id: string; scenario: string; startedAt: string; metrics: AarMetric[] }[] {
  try {
    return readdirSync(EXERCISE_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const s = JSON.parse(readFileSync(resolve(EXERCISE_DIR, f), 'utf8')) as ExerciseSession
        return { id: s.id, scenario: s.scenario, startedAt: s.startedAt, metrics: s.aar.metrics }
      })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  } catch {
    return []
  }
}

export function getExercise(id: string): ExerciseSession | null {
  try {
    const safe = id.replace(/[^A-Z0-9-]/gi, '')
    return JSON.parse(readFileSync(resolve(EXERCISE_DIR, `${safe}.json`), 'utf8')) as ExerciseSession
  } catch {
    return null
  }
}

/** Facilitator edits from the review screen — the draft is theirs to shape. */
export function updateExercise(id: string, aar: AarDraft): boolean {
  const s = getExercise(id)
  if (!s) return false
  s.aar = aar
  saveExercise(s)
  return true
}
