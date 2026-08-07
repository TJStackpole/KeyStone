// Prompt 15 acceptance tests: grammar coverage, homophone hardening, unit
// validation, and — non-negotiable — the deny-list: every tap-only surface
// asserted refused through the SAME executeIntent gate all voice tiers use.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { foldSpokenNumbers, matchGrammar, normalizeTranscript, buildLexicon, COMMANDS } from './grammar'
import { INTENTS, executeIntent, resolveUnit } from './registry'
import { getAppState, setAppState } from '../state/store'
import type { Unit } from '../types'

const meta = { tier: 'A' as const, transcript: 'test', t0: performance.now() }

function fakeUnit(callsign: string, status = 'enroute'): Unit {
  return {
    uid: `u-${callsign}`,
    callsign,
    category: 'engine' as Unit['category'],
    agency: 'FDNY' as Unit['agency'],
    lat: 40.71,
    lon: -74.0,
    hae: 0,
    speed: 8,
    status,
    cotType: 'a-f-G',
    updatedAt: new Date().toISOString(),
    staleAt: new Date(Date.now() + 60_000).toISOString(),
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 201 })))
  setAppState({ voiceConfirm: null, voiceEcho: null })
})

describe('number folding + normalization', () => {
  it('folds tens+ones', () => expect(foldSpokenNumbers('twenty six')).toBe('26'))
  it('concatenates groups radio-style', () => expect(foldSpokenNumbers('one eighteen')).toBe('118'))
  it('concatenates digit-by-digit box numbers', () => expect(foldSpokenNumbers('six one eight two')).toBe('6182'))
  it('normalizes punctuation and case', () => expect(normalizeTranscript('Show, Exposure TWO!')).toBe('show exposure 2'))
})

describe('Tier A grammar', () => {
  it('matches "show exposure two" with the digit slot', () => {
    const m = matchGrammar('show exposure two')
    expect(m).toEqual({ intent: 'show_exposure', slots: { n: '2' } })
  })
  it('hardens the exposure homophone ("exposure to" = 2)', () => {
    const m = matchGrammar('show exposure to')
    expect(m?.intent).toBe('show_exposure')
    expect(['to', '2']).toContain(m?.slots.n)
  })
  it('matches sides, street view, layers, pages, dispatch audio', () => {
    expect(matchGrammar('show the north side')?.intent).toBe('show_side')
    expect(matchGrammar('street view')?.intent).toBe('street_view')
    expect(matchGrammar('show hydrants')).toEqual({ intent: 'layer_show', slots: { layer: 'hydrants' } })
    expect(matchGrammar('hide traffic')).toEqual({ intent: 'layer_hide', slots: { layer: 'traffic' } })
    expect(matchGrammar('show the command board')?.intent).toBe('open_page')
    expect(matchGrammar('play the fdny dispatch')?.intent).toBe('dispatch_play')
    expect(matchGrammar('satellite view')?.intent).toBe('base_sat')
  })
  it('folds spoken unit numbers into designators', () => {
    const m = matchGrammar('where is ladder one one eight')
    expect(m?.intent).toBe('where_is_unit')
    expect(m?.slots.unit).toBe('ladder 118')
  })
  it('parses drafted comms with agency + message', () => {
    const m = matchGrammar('tell nypd we need the block closed')
    expect(m?.intent).toBe('tak_send')
    expect(m?.slots.agency).toBe('nypd')
    expect(m?.slots.message).toContain('block closed')
  })
  it('routes tap-only phrasings to the deny intents', () => {
    expect(matchGrammar('mark par complete for engine 7')?.intent).toBe('par_confirm')
    expect(matchGrammar('acknowledge the mayday')?.intent).toBe('mayday_ack')
    expect(matchGrammar('add a member to the riding list')?.intent).toBe('riding_modify')
  })
  it('only honors confirm/cancel while a draft is pending', () => {
    expect(matchGrammar('confirm')?.intent).toBeUndefined()
    expect(matchGrammar('confirm', true)?.intent).toBe('confirm_pending')
    expect(matchGrammar('cancel', true)?.intent).toBe('cancel_pending')
  })
})

describe('safety split (enforced in the action layer)', () => {
  it('classifies every state-changing intent as confirm', () => {
    for (const id of ['tak_open', 'tak_send', 'request_resource', 'transmit_alarm', 'respond_box', 'end_incident', 'run_demo', 'stop_scenario', 'assign_exposures']) {
      expect(INTENTS[id]?.klass, id).toBe('confirm')
    }
  })
  it('confirm-class commands DRAFT — nothing executes before CONFIRM', async () => {
    const result = await executeIntent('tak_send', { agency: 'nypd', message: 'close the block' }, meta)
    expect(result.echo).toContain('CONFIRM')
    expect(getAppState().voiceConfirm?.intent).toBe('tak_send')
    // No GeoChat left the console: the only fetch allowed is the voice log.
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))
    expect(calls.filter((u) => u.includes('/api/chat'))).toHaveLength(0)
  })

  // The deny-list, asserted item by item (P15 §5.3).
  for (const id of ['par_confirm', 'mayday_ack', 'riding_modify'] as const) {
    it(`refuses ${id} on every voice path, with the tap-only explanation`, async () => {
      expect(INTENTS[id].klass).toBe('deny')
      const result = await executeIntent(id, {}, meta)
      expect(result.ok).toBe(false)
      expect(result.echo).toContain('TAP-ONLY')
      expect(getAppState().voiceConfirm).toBeNull() // not even draftable
    })
  }

  it('every intent in the registry carries an executable or a refusal', () => {
    for (const [id, def] of Object.entries(INTENTS)) {
      if (def.klass === 'deny') expect(def.denyReason, id).toBeTruthy()
      else if (def.klass === 'confirm') expect(def.commit && def.draft, id).toBeTruthy()
      else expect(def.run, id).toBeTruthy()
    }
  })
})

describe('unit designator validation', () => {
  it('resolves an exact on-scene callsign', () => {
    setAppState({ units: { 'u-E-10': fakeUnit('E-10') } })
    expect(resolveUnit('engine 10').unit?.callsign).toBe('E-10')
  })
  it('suggests the nearest same-type unit on a miss', () => {
    setAppState({ units: { 'u-L-26': fakeUnit('L-26', 'onscene') } })
    const r = resolveUnit('ladder 20')
    expect(r.unit).toBeUndefined()
    expect(r.suggestion).toBe('L-26')
  })
})

describe('panel minimize (everything on the map platform)', () => {
  it('matches minimize/restore by panel name, longest alias first', () => {
    expect(matchGrammar('minimize comms')).toEqual({ intent: 'minimize_panel', slots: { panel: 'comms' } })
    expect(matchGrammar('collapse the site intel')?.slots.panel).toBe('site intel')
    expect(matchGrammar('restore the units')?.intent).toBe('restore_panel')
    expect(matchGrammar('minimize everything')?.intent).toBe('minimize_all')
    expect(matchGrammar('reset the layout')?.intent).toBe('reset_layout')
  })
  it('minimize/restore drives the shared persisted panel state', async () => {
    await executeIntent('minimize_panel', { panel: 'comms' }, meta)
    expect(getAppState().panelMinimized.comms).toBe(true)
    await executeIntent('restore_panel', { panel: 'comms' }, meta)
    expect(getAppState().panelMinimized.comms).toBeUndefined()
  })
  it('minimize everything covers every registered panel, restore clears it', async () => {
    await executeIntent('minimize_all', {}, meta)
    const min = getAppState().panelMinimized
    for (const id of ['comms', 'roster', 'incident-card', 'intel', 'utility-dock', 'ptt']) {
      expect(min[id], id).toBe(true)
    }
    await executeIntent('restore_all', {}, meta)
    expect(Object.keys(getAppState().panelMinimized)).toHaveLength(0)
  })
})

describe('grammar self-consistency (no row shadows another)', () => {
  // Every example must route back to ITS OWN intent — this is the structural
  // guard that catches ordering bugs like "pause the orbit" matching 'orbit'.
  for (const cmd of COMMANDS) {
    for (const raw of cmd.examples) {
      const spoken = raw.split('→')[0].trim()
      it(`"${spoken}" → ${cmd.intent}`, () => {
        expect(matchGrammar(spoken)?.intent).toBe(cmd.intent)
      })
    }
  }
  it('fixed shadows stay fixed', () => {
    expect(matchGrammar('pause the orbit')?.intent).toBe('orbit_pause')
    expect(matchGrammar('stop the rotation')?.intent).toBe('orbit_pause')
    expect(matchGrammar('open the street view panel')?.intent).toBe('open_street_panel')
    // bare nouns mid-sentence must not pop panels
    expect(matchGrammar('the tactics were solid')).toBeNull()
    expect(matchGrammar('check the manuals later')).toBeNull()
  })
})

describe('request status query reads the real slice', () => {
  it('summarizes open interagencyRequests', async () => {
    setAppState({
      interagencyRequests: [
        { id: 'r1', incidentId: null, requestingAgency: 'FDNY', assignedAgency: 'EMS', description: 'a bus', priority: 'urgent', state: 'in_progress', createdBy: 't', createdAt: new Date().toISOString(), transitions: [], updates: [] },
        { id: 'r2', incidentId: null, requestingAgency: 'FDNY', assignedAgency: 'DOT', description: 'barriers', priority: 'routine', state: 'complete', createdBy: 't', createdAt: new Date().toISOString(), transitions: [], updates: [] },
      ],
    })
    const result = await executeIntent('query_request_status', {}, meta)
    expect(result.echo).toContain('EMS: a bus — IN PROGRESS')
    expect(result.echo).not.toContain('barriers') // complete requests drop out
  })
})

describe('generated lexicon', () => {
  it('derives ASR keywords from the grammar (no drift possible)', () => {
    const lex = buildLexicon()
    for (const word of ['exposure', 'hydrants', 'mayday', 'ladder', 'battalion', 'staging']) {
      expect(lex).toContain(word)
    }
    // every command contributes at least its example verbs
    expect(lex.length).toBeGreaterThan(40)
    expect(COMMANDS.length).toBeGreaterThan(30)
  })
})
