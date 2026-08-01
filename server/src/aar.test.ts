import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateAar } from './aar.js'
import type { InteragencyRequest } from './nycem.js'
import type { TriggerSuggestion } from './weather.js'

// Pure-function regression coverage for the AAR truthfulness fixes (bug hunt
// #7): the acknowledge clock stops at a request's terminal transition (a
// prompt decline is a documented decision, not a breach anchored to ENDEX),
// and the objectives report what actually happened — no "multiple incidents
// (MET)" fabrication at zero, and a dismissal is a documented decision.

const T0 = '2026-08-01T10:00:00.000Z'
const T1 = '2026-08-01T10:30:00.000Z'
const at = (offsetS: number) => new Date(Date.parse(T0) + offsetS * 1000).toISOString()

function req(partial: Partial<InteragencyRequest> & { id: string }): InteragencyRequest {
  return {
    incidentId: null,
    requestingAgency: 'OEM',
    assignedAgency: 'NYPD',
    description: 'test request',
    priority: 'immediate', // 2min ack threshold
    state: 'opened',
    createdBy: 'tester',
    createdAt: at(10),
    transitions: [{ state: 'opened', at: at(10), by: 'tester' }],
    updates: [],
    ...partial,
  }
}

const emptyInput = {
  scenario: 'test-scenario',
  startedAt: T0,
  endedAt: T1,
  timeline: [],
  ticker: [],
  requests: [] as InteragencyRequest[],
  eocChanges: [],
  plans: [],
  suggestions: [] as TriggerSuggestion[],
}

function suggestion(state: TriggerSuggestion['state']): TriggerSuggestion {
  return {
    id: 'SUG-T1',
    ruleId: 'rule-flash-flood',
    plan: 'Flash Flood Emergency Plan',
    suggestedEocLevel: 3,
    suggestedActions: [],
    firedAt: at(90),
    product: {
      id: 'SIM-T1',
      event: 'Flash Flood Warning',
      headline: '',
      severity: 'Severe',
      onset: null,
      ends: null,
      areaDesc: 'Queens',
      polygons: [],
      simulated: true,
    },
    state,
    decidedBy: state === 'pending' ? undefined : 'WC Ops',
    decidedAt: state === 'pending' ? undefined : at(140),
    validateSme: true,
  }
}

test('promptly-declined request is not flagged; slow decline and never-acked still are', () => {
  const prompt = req({
    id: 'REQ-PROMPT',
    state: 'declined',
    transitions: [
      { state: 'opened', at: at(10) },
      { state: 'declined', at: at(20), by: 'NYPD desk' }, // 10s — far inside 2min
    ],
  })
  const slow = req({
    id: 'REQ-SLOW',
    state: 'declined',
    transitions: [
      { state: 'opened', at: at(10) },
      { state: 'declined', at: at(600), by: 'NYPD desk' }, // ~10min unacked before declining
    ],
  })
  const stuck = req({ id: 'REQ-STUCK' }) // opened, never touched — anchored to ENDEX

  const { aar, evidence } = generateAar({ ...emptyInput, requests: [prompt, slow, stuck] })
  const coord = aar.improvements.filter((f) => f.area === 'Interagency coordination')

  assert.ok(!coord.some((f) => f.sources.includes('REQ-PROMPT')), 'prompt decline must not be a breach finding')
  const slowFinding = coord.find((f) => f.sources.includes('REQ-SLOW'))
  assert.ok(slowFinding, 'slow unacked decline still breaches')
  assert.match(slowFinding.finding, /never acknowledged before being declined/)
  const stuckFinding = coord.find((f) => f.sources.includes('REQ-STUCK'))
  assert.ok(stuckFinding, 'never-acked active request anchors to exercise end')
  assert.match(stuckFinding.finding, /was never acknowledged/)
  // Excluded from findings ≠ erased from the record.
  assert.ok(evidence.requests.some((r) => r.id === 'REQ-PROMPT'))
})

test('COP objective is truthful at zero, one, and multiple incidents', () => {
  const tick = (id: string) => ({ id: `TKR-${id}`, ts: at(60), kind: 'new-incident', text: 'x', incidentId: id })

  const zero = generateAar(emptyInput).aar.objectives[0]
  assert.equal(zero.met, 'not observed')
  assert.match(zero.observed, /No new incidents/)

  const one = generateAar({ ...emptyInput, ticker: [tick('A')] }).aar.objectives[0]
  assert.equal(one.met, 'partial')
  assert.match(one.observed, /1 incident\b/)

  const two = generateAar({ ...emptyInput, ticker: [tick('A'), tick('B')] }).aar.objectives[0]
  assert.equal(two.met, 'met')
  assert.match(two.observed, /2 incidents/)
})

test('a dismissed trigger is a documented decision, not "pending"', () => {
  const dismissed = generateAar({ ...emptyInput, suggestions: [suggestion('dismissed')] }).aar.objectives[2]
  assert.equal(dismissed.met, 'met')
  assert.match(dismissed.observed, /dismissed by WC Ops/)

  const pending = generateAar({ ...emptyInput, suggestions: [suggestion('pending')] }).aar.objectives[2]
  assert.equal(pending.met, 'partial')
  assert.match(pending.observed, /decision pending/)

  // A pending suggestion is still an auto-flagged improvement; a dismissal is not.
  const flagged = generateAar({ ...emptyInput, suggestions: [suggestion('pending')] }).aar.improvements
  assert.ok(flagged.some((f) => f.area === 'Plan activation'))
  const notFlagged = generateAar({ ...emptyInput, suggestions: [suggestion('dismissed')] }).aar.improvements
  assert.ok(!notFlagged.some((f) => f.area === 'Plan activation'))
})
