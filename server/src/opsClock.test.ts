import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_PAR_INTERVAL_MIN, OpsClock } from './opsClock.js'
import type { Incident, TimelineEvent } from './types.js'

// OPS CLOCK regression coverage: the drumbeat and the PAR nag are DERIVED
// from the persisted timeline on every tick — these tests pin the
// idempotency-across-restart contract and the reset semantics.

const T0 = Date.parse('2026-08-04T12:00:00.000Z')

function makeHarness(startedMinAgo: number, timeline: TimelineEvent[] = []) {
  const incident = { id: 'INC-1', createdAt: new Date(T0 - startedMinAgo * 60_000).toISOString() } as Incident
  const emitted: { kind: string; payload: Record<string, unknown> }[] = []
  const clock = new OpsClock({
    getIncident: () => incident,
    getTimeline: () => [...timeline, ...emitted.map((e) => ({ t: new Date(T0).toISOString(), kind: e.kind, payload: e.payload }))],
    emit: (kind, payload) => emitted.push({ kind, payload }),
  })
  return { clock, emitted, timeline }
}

const at = (minAgo: number, kind: string, payload?: unknown): TimelineEvent => ({
  t: new Date(T0 - minAgo * 60_000).toISOString(),
  kind,
  payload,
})

test('duration marks: latest due mark emits once, then holds until the next boundary', () => {
  const { clock, emitted } = makeHarness(23)
  clock.tick(T0)
  assert.deepEqual(emitted, [
    { kind: 'ops.duration-mark', payload: { minutes: 20 } },
    // 23 min elapsed with no PAR on record — the default 20-min cycle lapsed
    { kind: 'ops.par-due', payload: { sinceMin: 23, intervalMin: DEFAULT_PAR_INTERVAL_MIN } },
  ])
  clock.tick(T0 + 15_000) // next tick, still inside the same 10-min window
  assert.equal(emitted.filter((e) => e.kind === 'ops.duration-mark').length, 1, 'no re-emit inside the window')
})

test('restart idempotency: marks already on the persisted record never re-emit', () => {
  const { clock, emitted } = makeHarness(34, [at(24, 'ops.duration-mark', { minutes: 10 }), at(14, 'ops.duration-mark', { minutes: 20 }), at(4, 'ops.duration-mark', { minutes: 30 })])
  clock.tick(T0)
  assert.equal(emitted.filter((e) => e.kind === 'ops.duration-mark').length, 0, 'record already carries mark 30 at t+34')
  clock.tick(T0 + 6 * 60_000) // t+40 boundary crossed
  assert.deepEqual(
    emitted.filter((e) => e.kind === 'ops.duration-mark').map((e) => e.payload),
    [{ minutes: 40 }],
  )
})

test('PAR cycle: ic.par-complete resets the window; the nag fires once per lapse', () => {
  // PAR completed 5 min ago — inside the window, no nag.
  let h = makeHarness(60, [at(5, 'ic.par-complete', { units: ['E-6'] })])
  h.clock.tick(T0)
  assert.equal(h.emitted.filter((e) => e.kind === 'ops.par-due').length, 0)

  // PAR completed 25 min ago — lapsed; nag fires exactly once across ticks.
  h = makeHarness(60, [at(25, 'ic.par-complete', { units: ['E-6'] })])
  h.clock.tick(T0)
  h.clock.tick(T0 + 15_000)
  h.clock.tick(T0 + 30_000)
  const dues = h.emitted.filter((e) => e.kind === 'ops.par-due')
  assert.equal(dues.length, 1, 'one nag per lapsed cycle')
  assert.deepEqual(dues[0].payload, { sinceMin: 25, intervalMin: DEFAULT_PAR_INTERVAL_MIN })

  // A restart mid-lapse: the persisted ops.par-due suppresses a duplicate.
  h = makeHarness(60, [at(25, 'ic.par-complete', {}), at(3, 'ops.par-due', { sinceMin: 22, intervalMin: 20 })])
  h.clock.tick(T0)
  assert.equal(h.emitted.filter((e) => e.kind === 'ops.par-due').length, 0, 'already announced this cycle')
})

test('an ignored PAR nag repeats every lapsed window — it never goes silent', () => {
  // PAR taken 45 min ago, nag announced at the first lapse (t-22, i.e. 23 min
  // after the PAR). Two full 20-min windows have now lapsed — a second nag
  // is due even though no ic.par-complete ever arrived.
  const h = makeHarness(60, [at(45, 'ic.par-complete', { units: ['E-6'] }), at(22, 'ops.par-due', { sinceMin: 23, intervalMin: 20 })])
  h.clock.tick(T0)
  const dues = h.emitted.filter((e) => e.kind === 'ops.par-due')
  assert.equal(dues.length, 1, 'second window announces again')
  assert.deepEqual(dues[0].payload, { sinceMin: 45, intervalMin: DEFAULT_PAR_INTERVAL_MIN })
  // Same window, next tick: no duplicate.
  h.clock.tick(T0 + 15_000)
  assert.equal(h.emitted.filter((e) => e.kind === 'ops.par-due').length, 1, 'one nag per window')
})

test('interval is clamped and respected; no incident means no emissions at all', () => {
  const { clock, emitted } = makeHarness(8)
  assert.equal(clock.setParIntervalMin(2), 5, 'floor clamp')
  assert.equal(clock.setParIntervalMin(240), 60, 'ceiling clamp')
  clock.setParIntervalMin(5)
  clock.tick(T0)
  assert.deepEqual(emitted.map((e) => e.kind), ['ops.par-due'], '8 min elapsed > 5 min interval; no 10-min mark yet')

  const idle = new OpsClock({ getIncident: () => null, getTimeline: () => [], emit: () => assert.fail('emitted without an incident') })
  idle.tick(T0) // END semantics: no incident, dead silent
})
