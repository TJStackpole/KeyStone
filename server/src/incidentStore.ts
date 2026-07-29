import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Incident, IncidentFile, TimelineEvent } from './types.js'

// Single-file persistence per CLAUDE.md: in-memory state mirrored to data/incident.json.
const DATA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../data/incident.json')

const EMPTY: IncidentFile = { incident: null, shapes: [], timeline: [] }

let state: IncidentFile = load()

function load(): IncidentFile {
  try {
    const raw = readFileSync(DATA_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Partial<IncidentFile>
    return {
      incident: parsed.incident ?? null,
      shapes: Array.isArray(parsed.shapes) ? parsed.shapes : [],
      timeline: Array.isArray(parsed.timeline) ? parsed.timeline : [],
    }
  } catch {
    return structuredClone(EMPTY)
  }
}

function flush(): void {
  try {
    mkdirSync(dirname(DATA_PATH), { recursive: true })
    writeFileSync(DATA_PATH, JSON.stringify(state, null, 2))
  } catch (err) {
    // Persistence failure must never take the incident down — state stays in memory.
    console.error('[incidentStore] failed to write incident.json:', err)
  }
}

export function getState(): IncidentFile {
  return state
}

export function appendTimeline(kind: string, payload?: unknown): TimelineEvent {
  const ev: TimelineEvent = { t: new Date().toISOString(), kind, payload }
  state.timeline.push(ev)
  flush()
  return ev
}

/** Starting a new incident replaces the previous one entirely (single incident at a time). */
export function createIncident(incident: Incident): IncidentFile {
  state = { incident, shapes: [], timeline: [] }
  appendTimeline('incident.created', { id: incident.id, address: incident.address, type: incident.type })
  return state
}

export function updateIncident(patch: Partial<Incident>): IncidentFile {
  if (!state.incident) return state
  state.incident = { ...state.incident, ...patch }
  appendTimeline('incident.updated', patch)
  return state
}
