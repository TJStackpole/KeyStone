import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Prompt 11 — NYCEM coordination layer, shared server state.
//
// KeyStone is a NEUTRAL READ-AND-COORDINATE LAYER: nothing here claims
// command authority for NYCEM over any agency, and agency-facing labels use
// CIMS terminology exactly (Primary / Supporting / Coordinating Agency).
// This module owns the pieces that sit ABOVE individual incidents:
//   - EOC activation level (Level 4 Watch Command default → Level 1 Full
//     EOC), manual changes only, immutable history.
//   - The citywide event ticker (ring buffer, broadcast + snapshot).
//   - Plan activations (tracked objects; shaded bands on the citywide
//     timeline).
//   - Persistence for all of the above plus the interagency requests and
//     weather trigger rules (nycem-state.json — same no-database posture as
//     incident.json).
// ---------------------------------------------------------------------------

export type Agency = 'FDNY' | 'NYPD' | 'EMS' | 'PAPD' | 'OEM' | 'DEP' | 'DOT' | 'DOB' | 'MTA' | 'ConEd'

export type EocLevel = 1 | 2 | 3 | 4

export const EOC_LEVEL_LABEL: Record<EocLevel, string> = {
  4: 'Level 4 — Watch Command',
  3: 'Level 3 — Situation Room',
  2: 'Level 2 — Partial EOC',
  1: 'Level 1 — Full EOC',
}

export interface EocChange {
  level: EocLevel
  changedBy: string
  changedAt: string
}

export interface TickerEvent {
  id: string
  ts: string
  /** new-incident | incident-closed | alarm | mayday | mci | request | plan | eoc | weather */
  kind: string
  text: string
  incidentId?: string
  agency?: string
  borough?: string
  severity?: number
}

export interface PlanActivation {
  id: string
  plan: string
  activatedAt: string
  activatedBy: string
  deactivatedAt?: string
  deactivatedBy?: string
}

/** One rule of the weather trigger engine (M5). Thresholds VALIDATE—SME. */
export interface TriggerRule {
  id: string
  plan: string
  enabled: boolean
  /** Substrings matched (case-insensitive) against NWS alert event names. */
  eventMatch: string[]
  suggestedEocLevel: EocLevel
  suggestedActions: string[]
  /** Placeholder thresholds pending NYCEM's internal values. */
  validateSme: boolean
}

export interface InteragencyRequestTransition {
  state: string
  at: string
  by?: string
  note?: string
}

export type RequestState = 'opened' | 'acknowledged' | 'assigned' | 'in_progress' | 'complete' | 'declined'
export type RequestPriority = 'routine' | 'urgent' | 'immediate'

export interface InteragencyRequest {
  id: string
  /** Nullable — citywide requests are allowed. */
  incidentId: string | null
  requestingAgency: string
  assignedAgency: string
  description: string
  priority: RequestPriority
  state: RequestState
  declineReason?: string
  createdBy: string
  createdAt: string
  transitions: InteragencyRequestTransition[]
  updates: { at: string; by: string; text: string }[]
}

interface NycemFile {
  eocHistory: EocChange[]
  plans: PlanActivation[]
  requests: InteragencyRequest[]
  rules: TriggerRule[]
}

const DATA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../data/nycem-state.json')

/**
 * Starter rules for the three plans in NYCEM's PUBLIC doctrine. Exact
 * trigger values are internal to NYCEM — these ship as VALIDATE—SME
 * placeholders designed to be edited in minutes by an NYCEM planner.
 */
const STARTER_RULES: TriggerRule[] = [
  {
    id: 'rule-flash-flood',
    plan: 'Flash Flood Emergency Plan',
    enabled: true,
    eventMatch: ['Flash Flood Warning', 'Flash Flood Emergency', 'Flood Warning'],
    suggestedEocLevel: 3,
    suggestedActions: [
      'Notify DEP + DOT duty officers',
      'Activate basement-apartment outreach protocol (VALIDATE—SME)',
      'Stage swift-water assets per plan annex (VALIDATE—SME)',
    ],
    validateSme: true,
  },
  {
    id: 'rule-coastal-storm',
    plan: 'Coastal Storm Plan',
    enabled: true,
    eventMatch: ['Coastal Flood Warning', 'Storm Surge', 'Hurricane', 'Tropical Storm'],
    suggestedEocLevel: 2,
    suggestedActions: [
      'Review evacuation zone messaging readiness',
      'Poll shelter system status (VALIDATE—SME)',
      'Confirm healthcare-facility evacuation liaison staffing (VALIDATE—SME)',
    ],
    validateSme: true,
  },
  {
    id: 'rule-winter-weather',
    plan: 'Winter Weather Plan',
    enabled: true,
    eventMatch: ['Winter Storm Warning', 'Blizzard Warning', 'Ice Storm Warning', 'Winter Weather Advisory'],
    suggestedEocLevel: 3,
    suggestedActions: [
      'Notify DSNY snow desk',
      'Review Code Blue outreach status (VALIDATE—SME)',
      'Confirm salt/plow pre-positioning per plan matrix (VALIDATE—SME)',
    ],
    validateSme: true,
  },
]

function load(): NycemFile {
  try {
    const parsed = JSON.parse(readFileSync(DATA_PATH, 'utf8')) as Partial<NycemFile>
    return {
      eocHistory: parsed.eocHistory ?? [],
      plans: parsed.plans ?? [],
      requests: parsed.requests ?? [],
      rules: parsed.rules?.length ? parsed.rules : STARTER_RULES,
    }
  } catch {
    return { eocHistory: [], plans: [], requests: [], rules: STARTER_RULES }
  }
}

const state: NycemFile = load()

let flushTimer: ReturnType<typeof setTimeout> | null = null

function flushNow(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  try {
    mkdirSync(dirname(DATA_PATH), { recursive: true })
    writeFileSync(DATA_PATH, JSON.stringify(state))
  } catch (err) {
    console.error('[nycem] failed to write nycem-state.json:', err)
  }
}

function flush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(flushNow, 4000)
  flushTimer.unref?.()
}

process.on('exit', () => {
  if (flushTimer) flushNow()
})

// ------------------------------- EOC level ----------------------------------

/** Level 4 (Watch Command) is the always-on default. */
export function eocLevel(): EocLevel {
  return state.eocHistory.length ? state.eocHistory[state.eocHistory.length - 1].level : 4
}

export function eocHistory(): EocChange[] {
  return state.eocHistory
}

/** Manual change only; "changed by" is REQUIRED; every change is immutable. */
export function setEocLevel(level: EocLevel, changedBy: string): EocChange {
  const change: EocChange = { level, changedBy, changedAt: new Date().toISOString() }
  state.eocHistory.push(change)
  flush()
  return change
}

// -------------------------------- Ticker ------------------------------------

const TICKER_CAP = 300
const ticker: TickerEvent[] = []
let tickerSeq = 1

export function tickerFeed(): TickerEvent[] {
  return ticker
}

export function pushTicker(ev: Omit<TickerEvent, 'id' | 'ts'>): TickerEvent {
  const full: TickerEvent = { ...ev, id: `TKR-${tickerSeq++}`, ts: new Date().toISOString() }
  ticker.push(full)
  if (ticker.length > TICKER_CAP) ticker.shift()
  return full
}

// ------------------------------ Plan activations -----------------------------

let planSeq = 1

export function plans(): PlanActivation[] {
  return state.plans
}

export function activatePlan(plan: string, activatedBy: string): PlanActivation {
  const p: PlanActivation = {
    id: `PLAN-${Date.now().toString(36)}-${planSeq++}`,
    plan,
    activatedAt: new Date().toISOString(),
    activatedBy,
  }
  state.plans.push(p)
  flush()
  return p
}

export function deactivatePlan(id: string, deactivatedBy: string): PlanActivation | null {
  const p = state.plans.find((x) => x.id === id && !x.deactivatedAt)
  if (!p) return null
  p.deactivatedAt = new Date().toISOString()
  p.deactivatedBy = deactivatedBy
  flush()
  return p
}

// ---------------------------- Interagency requests ---------------------------

/** Acknowledge-by thresholds per priority, milliseconds. PLACEHOLDERS —
 *  VALIDATE—SME (NYCEM's real escalation values are internal; these are
 *  sized so a compressed exercise can demonstrate a breach). */
export const REQUEST_THRESHOLDS_MS: Record<RequestPriority, number> = {
  immediate: 2 * 60_000,
  urgent: 5 * 60_000,
  routine: 30 * 60_000,
}

const REQUEST_FLOW: Record<RequestState, RequestState[]> = {
  opened: ['acknowledged', 'declined'],
  acknowledged: ['assigned', 'declined'],
  assigned: ['in_progress', 'declined'],
  in_progress: ['complete', 'declined'],
  complete: [],
  declined: [],
}

let requestSeq = 1

export function requests(): InteragencyRequest[] {
  return state.requests
}

export function openRequest(input: {
  incidentId: string | null
  requestingAgency: string
  assignedAgency: string
  description: string
  priority: RequestPriority
  createdBy: string
}): InteragencyRequest {
  const now = new Date().toISOString()
  const req: InteragencyRequest = {
    id: `REQ-${Date.now().toString(36).toUpperCase()}-${requestSeq++}`,
    ...input,
    state: 'opened',
    createdAt: now,
    transitions: [{ state: 'opened', at: now, by: input.createdBy }],
    updates: [],
  }
  state.requests.push(req)
  flush()
  return req
}

export function transitionRequest(
  id: string,
  next: RequestState,
  by: string,
  reason?: string,
): InteragencyRequest | { error: string } {
  const req = state.requests.find((r) => r.id === id)
  if (!req) return { error: 'no such request' }
  if (!REQUEST_FLOW[req.state].includes(next)) {
    return { error: `illegal transition ${req.state} -> ${next}` }
  }
  req.state = next
  if (next === 'declined') req.declineReason = reason ?? 'no reason given'
  req.transitions.push({ state: next, at: new Date().toISOString(), by, note: reason })
  flush()
  return req
}

export function appendRequestUpdate(id: string, by: string, text: string): InteragencyRequest | null {
  const req = state.requests.find((r) => r.id === id)
  if (!req) return null
  req.updates.push({ at: new Date().toISOString(), by, text })
  flush()
  return req
}

/**
 * Accountability metrics (the Comptroller's April 2024 "shared interagency
 * tracking and data sharing tool" recommendation): median time-to-acknowledge
 * and time-to-complete by agency pair and priority.
 */
export function requestMetrics(fromIso?: string, toIso?: string) {
  const from = fromIso ? Date.parse(fromIso) : -Infinity
  const to = toIso ? Date.parse(toIso) : Infinity
  const buckets = new Map<string, { ackMs: number[]; completeMs: number[]; count: number }>()
  for (const r of state.requests) {
    const created = Date.parse(r.createdAt)
    if (created < from || created > to) continue
    const key = `${r.requestingAgency}→${r.assignedAgency}|${r.priority}`
    let b = buckets.get(key)
    if (!b) {
      b = { ackMs: [], completeMs: [], count: 0 }
      buckets.set(key, b)
    }
    b.count++
    const ack = r.transitions.find((t) => t.state === 'acknowledged')
    if (ack) b.ackMs.push(Date.parse(ack.at) - created)
    const done = r.transitions.find((t) => t.state === 'complete')
    if (done) b.completeMs.push(Date.parse(done.at) - created)
  }
  const median = (xs: number[]) => {
    if (!xs.length) return null
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
  }
  return [...buckets.entries()].map(([key, b]) => {
    const [pair, priority] = key.split('|')
    return {
      pair,
      priority,
      count: b.count,
      medianAckMs: median(b.ackMs),
      medianCompleteMs: median(b.completeMs),
    }
  })
}

// ------------------------------ Trigger rules --------------------------------

export function triggerRules(): TriggerRule[] {
  return state.rules
}

export function saveTriggerRules(rules: TriggerRule[]): void {
  state.rules = rules
  flush()
}

/** Exercise/AAR support: everything the coordination layer knows, in one grab. */
export function nycemSnapshot() {
  return {
    eoc: { level: eocLevel(), history: state.eocHistory },
    ticker,
    plans: state.plans,
    requests: state.requests,
    rules: state.rules,
  }
}
