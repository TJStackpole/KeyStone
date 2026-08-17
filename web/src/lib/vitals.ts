import { getAppState, setAppState } from '../state/store'
import type { Incident, TimelineEvent } from '../types'

// ---------------------------------------------------------------------------
// Command vitals — the handful of numbers an IC re-checks constantly, derived
// from the incident record so every page (and the tab badges) agrees:
// PAR discipline, mayday-on-the-record, last benchmark, water assignments.
// One definition; the strip, the tabs, and any page chip all read from here.
// The PAR interval is the OPERATOR'S setting (OPS CLOCK chip cycles 10/15/
// 20/30 and mirrors to the server) — it lives in the store, never a constant.
// ---------------------------------------------------------------------------

export const PAR_PRESETS = [10, 15, 20, 30]
/** Mirrors the server's DEFAULT_PAR_INTERVAL_MIN (opsClock). VALIDATE—SME. */
export const PAR_INTERVAL_MIN = 20

/** Adopt the server clock's interval + last-PAR anchor into the store. The
 *  client timeline window is truncated on a long box; the server snapshot
 *  keeps the strip honest. Throttled — every vitals consumer may call it. */
let lastSyncMs = 0
export function syncParClock(): void {
  const now = Date.now()
  if (now - lastSyncMs < 30_000) return
  lastSyncMs = now
  fetch('/api/ops/par-interval')
    .then((r) => (r.ok ? r.json() : null))
    .then((p: { minutes?: number; lastParAt?: number } | null) => {
      if (!p) return
      setAppState({
        ...(PAR_PRESETS.includes(Number(p.minutes)) ? { parIntervalMin: Number(p.minutes) } : {}),
        parAnchorSrv: Number(p.lastParAt) || 0,
      })
    })
    .catch(() => {
      lastSyncMs = 0 // failed sync must not block the next attempt
    })
}

/** ms of the last completed PAR (client timeline OR server anchor — anchors
 *  only move forward, so max is always right), else incident stand-up. */
export function parAnchorMs(timeline: TimelineEvent[], incident: Incident | null): number | null {
  const start = incident ? Date.parse(incident.createdAt) : NaN
  if (!Number.isFinite(start)) return null
  let anchor = Math.max(start, getAppState().parAnchorSrv || 0)
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].kind !== 'ic.par-complete') continue
    const ms = Date.parse(timeline[i].t)
    if (Number.isFinite(ms) && ms > anchor) anchor = ms
    break
  }
  return anchor
}

/** Whether a PAR has ever been completed on this record (timeline window or
 *  the server anchor — either is proof). */
export function hasParOnRecord(timeline: TimelineEvent[]): boolean {
  return (getAppState().parAnchorSrv || 0) > 0 || timeline.some((ev) => ev.kind === 'ic.par-complete')
}

export interface ParState {
  /** The window has fully elapsed — matches the server clock's ops.par-due
   *  moment exactly (ms comparison, no floored-minute dead zone). */
  lapsed: boolean
  /** ms past the window when lapsed, else 0. */
  overdueMs: number
  taken: boolean
  intervalMin: number
}

export function parState(timeline: TimelineEvent[], incident: Incident | null, nowMs: number): ParState | null {
  const anchor = parAnchorMs(timeline, incident)
  if (anchor === null) return null
  const intervalMin = getAppState().parIntervalMin
  const over = nowMs - anchor - intervalMin * 60_000
  return { lapsed: over >= 0, overdueMs: Math.max(0, over), taken: hasParOnRecord(timeline), intervalMin }
}

/** A mayday holds the record until dispatch clears it — the scenarios (and
 *  the LOG) emit alert.clear / mayday.resolved when the member is recovered. */
export function maydayOnRecord(timeline: TimelineEvent[]): TimelineEvent | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const kind = timeline[i].kind
    if (kind === 'alert.mayday') return timeline[i]
    if (kind === 'alert.clear' || kind === 'mayday.resolved') return null
  }
  return null
}

/** The IC's most recent logged benchmark (10-75 / under control / …). */
export function lastBenchmark(timeline: TimelineEvent[]): { code: string; t: string } | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const ev = timeline[i]
    if (ev.kind !== 'ic.benchmark') continue
    const p = (ev.payload ?? {}) as { code?: unknown }
    return { code: typeof p.code === 'string' ? p.code : 'BENCHMARK', t: ev.t }
  }
  return null
}

/** hydrant -> engine, from the record. water.clear releases a hydrant. */
export function waterAssignments(timeline: TimelineEvent[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const ev of timeline) {
    const p = (ev.payload ?? {}) as { hydrant?: string; unit?: string }
    if (ev.kind === 'water.assign' && p.hydrant && p.unit) out[p.hydrant] = p.unit
    else if (ev.kind === 'water.clear' && p.hydrant) delete out[p.hydrant]
  }
  return out
}
