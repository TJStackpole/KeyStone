import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildReinforcements, ESCALATION_PLAN, nextAlarmLevel } from './sim/assignment.js'
import { FirstAlarmSimulator } from './sim/simulator.js'

// RESOURCES ledger contract: the alarm preview and a real escalation must
// never disagree — both consume ESCALATION_PLAN + buildReinforcements with
// the same assigned-set. These tests pin the ladder, the shared plan, and
// the determinism of the reinforcement builder itself.

test('alarm ladder climbs 10-75 → all-hands → 2nd..5th and tops out', () => {
  assert.equal(nextAlarmLevel(undefined), '10-75', 'a box with no alarm climbs to 10-75 first')
  assert.equal(nextAlarmLevel('10-75'), 'all-hands')
  assert.equal(nextAlarmLevel('all-hands'), '2nd')
  assert.equal(nextAlarmLevel('2nd'), '3rd')
  assert.equal(nextAlarmLevel('4th'), '5th')
  assert.equal(nextAlarmLevel('5th'), null)
})

test('every escalatable level has a plan (preview can never hit a hole)', () => {
  for (const level of ['all-hands', '2nd', '3rd', '4th', '5th'] as const) {
    const p = ESCALATION_PLAN[level]
    assert.ok(p && p.e + p.l + p.bc > 0, level)
  }
})

test('reinforcement builder is deterministic for identical inputs (synthetic path)', async () => {
  // Fail the firehouse fetch instantly (hermetic — no live Socrata call) so
  // both runs take the synthetic fallback, which must be deterministic:
  // preview===escalate by construction.
  const realFetch = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new Error('offline test'))) as typeof fetch
  try {
    const assigned = new Set(['E-1', 'L-1', 'E-200', 'L-201'])
    const a = await buildReinforcements(0, 0, ESCALATION_PLAN['2nd'], new Set(assigned))
    const b = await buildReinforcements(0, 0, ESCALATION_PLAN['2nd'], new Set(assigned))
    assert.deepEqual(
      a.map((s) => s.callsign),
      b.map((s) => s.callsign),
    )
    assert.ok(!a.some((s) => assigned.has(s.callsign)), 'never re-dispatches an assigned company')
    assert.equal(a.length, ESCALATION_PLAN['2nd'].e + ESCALATION_PLAN['2nd'].l + ESCALATION_PLAN['2nd'].bc)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('preview without an active sim dispatches nothing and returns empty', async () => {
  const sim = new FirstAlarmSimulator(() => true)
  assert.deepEqual(await sim.previewEscalation('2nd'), [])
  assert.deepEqual(await sim.escalate('2nd'), { added: [] })
})
