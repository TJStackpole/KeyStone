import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// Regression coverage for the weather trigger engine fixes (bug hunt #7 +
// iteration round): clearSimulated() re-arms a fired SIMULATED product so a
// scenario re-run re-fires its scripted trigger (the fired-once map used to
// block every second exercise run), decided suggestions survive as history,
// and one throwing rule can no longer silently kill evaluation of the rest.
//
// Both env seams MUST be set before the modules load: nycem is an import-time
// singleton and WeatherWatch resolves its state path at module load.
const scratch = mkdtempSync(join(tmpdir(), 'weather-test-'))
process.env.NYCEM_DATA_PATH = join(scratch, 'nycem-state.json')
process.env.WEATHER_STATE_PATH = join(scratch, 'weather-state.json')

// Pre-write exactly one enabled rule so firing behavior is deterministic.
const RULE = {
  id: 'rule-test-flood',
  plan: 'Flash Flood Emergency Plan',
  enabled: true,
  eventMatch: ['Flash Flood'],
  suggestedEocLevel: 3 as const,
  suggestedActions: [] as string[],
  validateSme: true,
}
writeFileSync(process.env.NYCEM_DATA_PATH, JSON.stringify({ eocHistory: [], plans: [], requests: [], rules: [RULE] }))

const nycem = await import('./nycem.js')
const { WeatherWatch } = await import('./weather.js')

function mockProduct(id: string, event = 'Flash Flood Warning') {
  return {
    id,
    event,
    headline: 'test product',
    severity: 'Severe',
    onset: new Date().toISOString(),
    ends: null,
    areaDesc: 'Queens',
    polygons: [] as [number, number][][],
  }
}

test('clearSimulated re-arms a fired SIM product; decided suggestions survive as history', () => {
  const w = new WeatherWatch()
  const fired: string[] = []
  w.on('suggestion', (s: { id: string }) => fired.push(s.id))

  w.injectMockProduct(mockProduct('SIM-T1'))
  assert.equal(fired.length, 1, 'first inject fires the rule')

  const sug = w.snapshot().suggestions.find((s) => s.state === 'pending')
  assert.ok(sug)
  assert.ok(w.decide(sug.id, 'dismissed', 'tester'), 'decision recorded')

  w.injectMockProduct(mockProduct('SIM-T1'))
  assert.equal(fired.length, 1, 'fired-once map blocks a re-inject within the run')

  w.clearSimulated()
  assert.equal(w.snapshot().alerts.filter((a) => a.simulated).length, 0, 'sim products cleared')
  assert.ok(
    w.snapshot().suggestions.some((s) => s.id === sug.id && s.state === 'dismissed'),
    'decided suggestion survives as history',
  )

  w.injectMockProduct(mockProduct('SIM-T1'))
  assert.equal(fired.length, 2, 'the re-run re-fires the scripted trigger')
})

test('one throwing rule is contained — remaining rules still fire', () => {
  const good = { ...RULE, id: 'rule-good-coastal', plan: 'Coastal Storm Plan', eventMatch: ['Coastal Flood'] }
  const poisoned = { ...RULE, id: 'rule-poisoned', eventMatch: null }
  // saveTriggerRules is deliberately below the sanitize boundary (the HTTP
  // layer validates) — this simulates a legacy/corrupt in-memory state.
  nycem.saveTriggerRules([poisoned, good] as never)

  const w = new WeatherWatch()
  const fired: { ruleId: string }[] = []
  w.on('suggestion', (s: { ruleId: string }) => fired.push(s))

  w.injectMockProduct(mockProduct('SIM-T2', 'Coastal Flood Warning'))
  assert.equal(fired.length, 1, 'evaluation continued past the throwing rule')
  assert.equal(fired[0].ruleId, 'rule-good-coastal')

  nycem.saveTriggerRules([RULE]) // restore for any later test in this file
})
