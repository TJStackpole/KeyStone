import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IcsShape, Incident, IncidentFile, TimelineEvent } from './types.js'

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

// Personnel tracks arrive several times a second; rewriting the file on every
// append would thrash the disk. Coalesce writes on a short trailing debounce.
let flushTimer: ReturnType<typeof setTimeout> | null = null

function flush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    try {
      mkdirSync(dirname(DATA_PATH), { recursive: true })
      // Compact JSON: pretty-printing a multi-MB timeline roughly doubles the
      // stringify+write cost of every flush.
      writeFileSync(DATA_PATH, JSON.stringify(state))
    } catch (err) {
      // Persistence failure must never take the incident down — state stays in memory.
      console.error('[incidentStore] failed to write incident.json:', err)
    }
  }, 1500) // sustained track appends make this a steady cadence, not a debounce
  flushTimer.unref?.()
}

export function getState(): IncidentFile {
  return state
}

/** Bound the timeline so multi-hour incidents can't balloon incident.json. */
const MAX_TIMELINE_EVENTS = 12_000

export function appendTimeline(kind: string, payload?: unknown): TimelineEvent {
  const ev: TimelineEvent = { t: new Date().toISOString(), kind, payload }
  state.timeline.push(ev)
  if (state.timeline.length > MAX_TIMELINE_EVENTS) {
    // Drop the oldest unit.track samples first — milestones stay forever.
    const firstTrack = state.timeline.findIndex((e) => e.kind === 'unit.track')
    state.timeline.splice(firstTrack === -1 ? 0 : firstTrack, 1)
  }
  flush()
  return ev
}

/** Starting a new incident replaces the previous one entirely (single incident at a time). */
export function createIncident(incident: Incident): IncidentFile {
  state = { incident, shapes: [], timeline: [] }
  appendTimeline('incident.created', { id: incident.id, address: incident.address, type: incident.type })
  return state
}

/** Tear the whole board down — no incident, no shapes, fresh timeline. */
export function clearIncident(): IncidentFile {
  state = { incident: null, shapes: [], timeline: [] }
  appendTimeline('incident.cleared', {})
  return state
}

export function updateIncident(patch: Partial<Incident>): IncidentFile {
  if (!state.incident) return state
  state.incident = { ...state.incident, ...patch }
  appendTimeline('incident.updated', patch)
  return state
}

/** Insert or replace one ICS shape (vertex edits arrive as full replacements). */
export function upsertShape(shape: IcsShape): void {
  const i = state.shapes.findIndex((s) => s.id === shape.id)
  if (i >= 0) state.shapes[i] = shape
  else state.shapes.push(shape)
  appendTimeline('shape.upserted', shape)
}

export function removeShape(id: string): boolean {
  const before = state.shapes.length
  state.shapes = state.shapes.filter((s) => s.id !== id)
  if (state.shapes.length !== before) {
    appendTimeline('shape.removed', { id })
    return true
  }
  return false
}
