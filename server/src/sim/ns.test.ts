import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DRILL_UID_PREFIX, SIM_NS, SIM_UID_PREFIX, isForeignSimUid } from './ns.js'

// The truth table behind parallel-dev isolation: exactly the two simulated
// families are namespace-checked; everything else (real EUDs) always passes.

test('own-namespace sim and drill uids pass ingest', () => {
  assert.equal(isForeignSimUid(`${SIM_UID_PREFIX}E-6`), false)
  assert.equal(isForeignSimUid(`${DRILL_UID_PREFIX}E-3-4`), false)
})

test('foreign-namespace sim and drill uids are dropped', () => {
  // <ns>0 can never equal <ns> and never reach the "-" boundary, so these
  // read as another stack's namespace no matter what SIM_NS resolves to.
  assert.equal(isForeignSimUid(`WT-SIM-${SIM_NS}0-E-6`), true)
  assert.equal(isForeignSimUid(`DRILL-${SIM_NS}0-E-3-4`), true)
})

test('un-namespaced family uids (pre-namespace stack) are foreign', () => {
  assert.equal(isForeignSimUid('WT-SIM-E-6'), true)
  assert.equal(isForeignSimUid('DRILL-E-3-4'), true)
})

test('real EUD uids always pass', () => {
  assert.equal(isForeignSimUid('ANDROID-8f2c1a90d3e4'), false)
  assert.equal(isForeignSimUid('S-1-CHIEF-PHONE'), false)
  assert.equal(isForeignSimUid('KEYSTONE-COP'), false)
  assert.equal(isForeignSimUid(''), false)
})
