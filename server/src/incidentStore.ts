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

/** Synchronous write — shared by the debounce timer and the exit hooks. */
function flushNow(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  try {
    mkdirSync(dirname(DATA_PATH), { recursive: true })
    // Compact JSON: pretty-printing a multi-MB timeline roughly doubles the
    // stringify+write cost of every flush.
    writeFileSync(DATA_PATH, JSON.stringify(state))
  } catch (err) {
    // Persistence failure must never take the incident down — state stays in memory.
    console.error('[incidentStore] failed to write incident.json:', err)
  }
}

function flush(): void {
  if (flushTimer) return
  // 8 s matches the unit.track sampling cadence — the persisted data only
  // changes meaningfully at that rate, and the multi-MB synchronous
  // stringify+write stalls the event loop ~9 ms per flush at the timeline
  // cap. The exit/SIGINT/SIGTERM handlers still bound loss on shutdown.
  flushTimer = setTimeout(flushNow, 8000)
  flushTimer.unref?.()
}

// A restart inside the 1.5 s window (tsx watch fires on every file save)
// otherwise loses writes the client already saw acknowledged. Signals skip
// 'exit' handlers, so SIGINT/SIGTERM flush explicitly and re-raise.
process.on('exit', () => {
  if (flushTimer) flushNow()
})
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    if (flushTimer) flushNow()
    process.kill(process.pid, sig)
  })
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
