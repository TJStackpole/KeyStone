import { describe, expect, it } from 'vitest'
import { setAppState } from '../state/store'
import type { Incident, TimelineEvent } from '../types'
import { maydayOnRecord, parState, waterAssignments } from './vitals'

// ---------------------------------------------------------------------------
// The vitals derivations feed a safety-critical strip on every page — these
// pin the exact semantics the review confirmed: ms-exact PAR windows (no
// floored-minute dead zone), operator-set interval, mayday clears, and
// water.clear releasing a hydrant.
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-08-17T12:00:00.000Z')
const iso = (offsetMin: number) => new Date(T0 + offsetMin * 60_000).toISOString()
const ev = (kind: string, offsetMin: number, payload?: Record<string, unknown>): TimelineEvent =>
  ({ t: iso(offsetMin), kind, payload }) as TimelineEvent
const incident = { createdAt: iso(0) } as Incident

describe('parState', () => {
  it('lapses at EXACTLY the interval — no floored-minute dead zone', () => {
    setAppState({ parIntervalMin: 20, parAnchorSrv: 0 })
    const atWindow = parState([], incident, T0 + 20 * 60_000)
    expect(atWindow?.lapsed).toBe(true)
    const oneMsBefore = parState([], incident, T0 + 20 * 60_000 - 1)
    expect(oneMsBefore?.lapsed).toBe(false)
  })

  it('honors the operator-set interval, not a constant', () => {
    setAppState({ parIntervalMin: 10, parAnchorSrv: 0 })
    expect(parState([], incident, T0 + 12 * 60_000)?.lapsed).toBe(true)
    setAppState({ parIntervalMin: 30 })
    expect(parState([], incident, T0 + 12 * 60_000)?.lapsed).toBe(false)
    setAppState({ parIntervalMin: 20 })
  })

  it('anchors on the last completed PAR and on the server anchor', () => {
    setAppState({ parIntervalMin: 20, parAnchorSrv: 0 })
    const withPar = [ev('ic.par-complete', 15)]
    expect(parState(withPar, incident, T0 + 30 * 60_000)?.lapsed).toBe(false)
    // Server anchor survives a truncated timeline window.
    setAppState({ parAnchorSrv: T0 + 25 * 60_000 })
    expect(parState([], incident, T0 + 40 * 60_000)?.lapsed).toBe(false)
    expect(parState([], incident, T0 + 46 * 60_000)?.lapsed).toBe(true)
    setAppState({ parAnchorSrv: 0 })
  })
})

describe('maydayOnRecord', () => {
  it('holds the record until cleared', () => {
    expect(maydayOnRecord([ev('alert.mayday', 5)])).not.toBeNull()
    expect(maydayOnRecord([ev('alert.mayday', 5), ev('alert.clear', 8)])).toBeNull()
    expect(maydayOnRecord([ev('alert.mayday', 5), ev('mayday.resolved', 8)])).toBeNull()
    // A SECOND mayday after a clear re-arms it.
    expect(maydayOnRecord([ev('alert.mayday', 5), ev('alert.clear', 8), ev('alert.mayday', 12)])).not.toBeNull()
  })
})

describe('waterAssignments', () => {
  it('assign then clear releases the hydrant; history order wins', () => {
    const tl = [
      ev('water.assign', 3, { hydrant: 'H1', unit: 'E-6' }),
      ev('water.assign', 4, { hydrant: 'H2', unit: 'E-7' }),
      ev('water.clear', 6, { hydrant: 'H1' }),
      ev('water.assign', 8, { hydrant: 'H1', unit: 'E-10' }),
    ]
    expect(waterAssignments(tl)).toEqual({ H1: 'E-10', H2: 'E-7' })
  })
})
