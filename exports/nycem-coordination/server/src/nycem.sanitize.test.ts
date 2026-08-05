import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// sanitizeTriggerRules is the single trust boundary for PUT bodies and
// nycem-state.json (bug hunt #7): one malformed persisted rule used to throw
// inside every 5-minute NWS poll — mislogged as a network failure — and crash
// the rules editor on every dashboard, surviving restarts.
//
// The env seam MUST be set before the module loads: nycem is a singleton that
// reads (and later writes) its state path at import time.
process.env.NYCEM_DATA_PATH = join(mkdtempSync(join(tmpdir(), 'nycem-test-')), 'nycem-state.json')
const { sanitizeTriggerRules } = await import('./nycem.js')

test('non-array input returns null', () => {
  assert.equal(sanitizeTriggerRules(null), null)
  assert.equal(sanitizeTriggerRules('rules'), null)
  assert.equal(sanitizeTriggerRules({ 0: {} }), null)
})

test('malformed elements are dropped and counted', () => {
  const out = sanitizeTriggerRules([
    null,
    42,
    {},
    { id: 'a' }, // missing plan/eventMatch/level
    { id: 'a', plan: 'p', eventMatch: 'not-an-array', suggestedEocLevel: 3 },
    { id: 'a', plan: 'p', eventMatch: ['x'], suggestedEocLevel: 5 }, // level out of range
  ])
  assert.ok(out)
  assert.equal(out.rules.length, 0)
  assert.equal(out.dropped, 6)
})

test('valid rule is normalized; survivors kept alongside drops', () => {
  const out = sanitizeTriggerRules([
    { id: ' r1 ', plan: ' P ', enabled: true, eventMatch: [' Flood ', 7, ''], suggestedEocLevel: 3, suggestedActions: ['a', 9], validateSme: 'yes' },
    null,
  ])
  assert.ok(out)
  assert.equal(out.dropped, 1)
  assert.deepEqual(out.rules, [
    {
      id: 'r1',
      plan: 'P',
      enabled: true,
      eventMatch: ['Flood'], // trimmed; non-strings and empties dropped
      suggestedEocLevel: 3,
      suggestedActions: ['a'], // non-strings dropped
      validateSme: false, // only === true passes
    },
  ])
})

test('enabled must be exactly true', () => {
  const out = sanitizeTriggerRules([
    { id: 'r', plan: 'p', enabled: 'true', eventMatch: ['x'], suggestedEocLevel: 4 },
  ])
  assert.ok(out)
  assert.equal(out.rules[0].enabled, false)
})
