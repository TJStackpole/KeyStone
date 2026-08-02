import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { IcsShape } from '../types.js'
import { ScenarioEngine, type EngineDeps } from './engine.js'

// Regression coverage for the Prompt 11 request/alarm lifecycle across
// rewinds, run against the real bundled exercise (pabt-flood-exercise ships
// 8 scripted requests at t=30..240, their transitions through t=1300, and
// alarm escalations at t=378 ('2nd') and t=626 ('3rd')).
//
// The bugs these lock in (bug hunt #7): teardown() on a rewind used to wipe
// the refId→REQ-id dedupe map, so every scrub-back re-opened all scripted
// requests as persisted duplicates; and replayed alarm/transition events
// re-announced through the deps on every scrub.

function makeHarness() {
  const opened: string[] = []
  const transitions: { id: string; state: string }[] = []
  const alarms: { level: string; replay: boolean }[] = []
  const shapes = new Map<string, IcsShape>()
  const deps: EngineDeps = {
    publishCot: () => true,
    broadcast: () => {},
    emitTimeline: () => {},
    createIncident: () => {},
    upsertShape: (s) => {
      shapes.set(s.id, s)
    },
    removeShape: (id) => shapes.delete(id),
    removeUnit: () => {},
    setAlarm: (level, replay) => {
      alarms.push({ level: String(level), replay: !!replay })
    },
    openRequest: (r) => {
      opened.push(r.refId)
      return `REAL-${r.refId}`
    },
    transitionRequest: (id, state) => {
      transitions.push({ id, state })
    },
  }
  return { engine: new ScenarioEngine(deps), opened, transitions, alarms }
}

test('scripted requests open exactly once across rewind and re-cross; replayed transitions and alarms are suppressed', async () => {
  const { engine, opened, transitions, alarms } = makeHarness()
  await engine.load('pabt-flood-exercise')

  // Forward to t=400: all 8 scripted requests and the 9 transitions ≤400.
  engine.seekTo(400)
  assert.equal(opened.length, 8, 'all scripted requests open on first pass')
  assert.equal(new Set(opened).size, 8, 'refIds are unique')
  assert.equal(transitions.length, 10, 'transitions ≤400 applied once')
  assert.deepEqual(alarms, [{ level: '2nd', replay: false }], 'first alarm announces live')

  // Rewind to t=200: requests persist (they are the accountability record) —
  // the replay must not re-open or re-transition anything.
  engine.seekTo(200)
  assert.equal(opened.length, 8, 'rewind must not re-open scripted requests')
  assert.equal(transitions.length, 10, 'rewind must not re-apply transitions')

  // Forward re-cross of already-emitted span: still nothing new, and the
  // alarm restore is flagged replay=true (board updates, ticker suppressed).
  engine.seekTo(400)
  assert.equal(opened.length, 8, 're-cross must not re-open')
  assert.equal(transitions.length, 10, 're-cross must not re-apply transitions')
  assert.deepEqual(alarms.at(-1), { level: '2nd', replay: true }, 're-crossed alarm is a flagged replay')

  // Genuinely new span (400,800]: 11 more transitions, second alarm live.
  engine.seekTo(800)
  assert.equal(opened.length, 8, 'no request events exist past t=240')
  assert.equal(transitions.length, 23, 'new-span transitions apply exactly once')
  assert.deepEqual(alarms.at(-1), { level: '3rd', replay: false }, 'genuinely new alarm announces live')
  for (const t of transitions) {
    assert.ok(t.id.startsWith('REAL-REQ-'), `transition routed through the dedupe map: ${t.id}`)
  }

  // Full unload resets the map: a fresh run intentionally opens NEW records.
  engine.stop()
  await engine.load('pabt-flood-exercise')
  engine.seekTo(60)
  assert.equal(opened.length, 11, 'a new run opens fresh requests (3 scripted ≤60)')
  engine.stop()
})
