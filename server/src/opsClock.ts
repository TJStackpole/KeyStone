import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Incident, TimelineEvent } from './types.js'

// Env override is a TEST seam (mirrors requests.ts) — the suite must never
// write the real demo config; a stray test value would silently re-cadence
// the live PAR clock at the next boot.
function opsSettingsPath(): string {
  return process.env.OPS_SETTINGS_PATH ?? resolve(dirname(fileURLToPath(import.meta.url)), '../data/ops-settings.json')
}

// ---------------------------------------------------------------------------
// OPS CLOCK — server-authoritative elapsed-time + PAR discipline, so every
// screen agrees on the same clock. Two duties while an incident is active:
//
//   ops.duration-mark {minutes}   every 10 elapsed minutes from incident
//                                 start — the IC's operational drumbeat
//   ops.par-due {sinceMin, intervalMin}
//                                 the PAR interval lapsed without a PAR;
//                                 a posted ic.par-complete resets the cycle
//
// Everything is DERIVED from the incident start time and the persisted
// timeline on every tick — no internal counters — so restarts never
// double-emit (idempotent by construction) and END clears state for free:
// the timeline dies with the incident.
//
// PAR interval defaults to 20 minutes — VALIDATE—SME: FDNY's real PAR
// cadence must be confirmed with the department; the client exposes the
// setting and mirrors it here via POST /api/ops/par-interval.
// ---------------------------------------------------------------------------

const TICK_MS = 15_000
const MARK_EVERY_MIN = 10
export const DEFAULT_PAR_INTERVAL_MIN = 20 // VALIDATE—SME

export interface OpsClockDeps {
  getIncident: () => Incident | null
  getTimeline: () => TimelineEvent[]
  emit: (kind: string, payload: Record<string, unknown>) => void
}

export class OpsClock {
  private timer: NodeJS.Timeout | null = null
  private parIntervalMin = (() => {
    try {
      const v = (JSON.parse(readFileSync(opsSettingsPath(), 'utf8')) as { parIntervalMin?: number }).parIntervalMin
      if (typeof v === 'number' && v >= 5 && v <= 60) return Math.round(v)
    } catch {
      // no settings file yet — default cadence
    }
    return DEFAULT_PAR_INTERVAL_MIN
  })()

  constructor(private deps: OpsClockDeps) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Clamped 5..60 — a sub-5-minute PAR cycle is alert spam, not discipline. */
  setParIntervalMin(min: number): number {
    this.parIntervalMin = Math.max(5, Math.min(60, Math.round(min)))
    // The operator's cadence choice must survive a mid-incident server
    // bounce — snapping back to 20 silently would corrupt PAR discipline.
    try {
      writeFileSync(opsSettingsPath(), JSON.stringify({ parIntervalMin: this.parIntervalMin }))
    } catch {
      // read-only disk — session-only setting
    }
    return this.parIntervalMin
  }

  getParIntervalMin(): number {
    return this.parIntervalMin
  }

  /** One evaluation pass — public so tests drive it without wall-clock. */
  tick(now = Date.now()): void {
    const inc = this.deps.getIncident()
    if (!inc) return
    const startedAt = Date.parse(inc.createdAt)
    if (!Number.isFinite(startedAt) || now <= startedAt) return
    const timeline = this.deps.getTimeline()
    const elapsedMin = (now - startedAt) / 60_000

    // Duration marks: the highest mark already on the record is the truth —
    // emit only the LATEST due mark (no catch-up spam after long gaps).
    let lastMark = 0
    for (const ev of timeline) {
      if (ev.kind === 'ops.duration-mark') {
        const m = Number((ev.payload as { minutes?: number } | undefined)?.minutes)
        if (Number.isFinite(m) && m > lastMark) lastMark = m
      }
    }
    const dueMark = Math.floor(elapsedMin / MARK_EVERY_MIN) * MARK_EVERY_MIN
    if (dueMark > lastMark && dueMark >= MARK_EVERY_MIN) {
      this.deps.emit('ops.duration-mark', { minutes: dueMark })
    }

    // PAR cycle: last completed PAR (or incident start) anchors the window;
    // announce ONCE per lapsed window — an ops.par-due newer than the anchor
    // means this cycle is already announced.
    let lastParAt = startedAt
    let lastDueAt = 0
    for (const ev of timeline) {
      const t = Date.parse(ev.t)
      if (!Number.isFinite(t)) continue
      if (ev.kind === 'ic.par-complete' && t > lastParAt) lastParAt = t
      if (ev.kind === 'ops.par-due' && t > lastDueAt) lastDueAt = t
    }
    // Count lapsed windows, not a boolean — an ignored first nag must NOT
    // silence the clock: with a 20-min cycle and no PAR ever taken, the nag
    // repeats at t+20, t+40, t+60...
    const intervalMs = this.parIntervalMin * 60_000
    const lapsedWindows = Math.floor((now - lastParAt) / intervalMs)
    const announcedWindows = lastDueAt > lastParAt ? Math.floor((lastDueAt - lastParAt) / intervalMs) : 0
    if (lapsedWindows >= 1 && lapsedWindows > announcedWindows) {
      this.deps.emit('ops.par-due', {
        sinceMin: Math.floor((now - lastParAt) / 60_000),
        intervalMin: this.parIntervalMin,
      })
    }
  }
}
