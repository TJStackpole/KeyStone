import express from 'express'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { SimComms, WhisperLink, type CommsChannel, type TranscriptLine } from './comms.js'
import { env } from './env.js'
import {
  appendTimeline,
  createIncident,
  getState,
  removeShape,
  updateIncident,
  upsertShape,
} from './incidentStore.js'
import { ScenarioEngine } from './scenario/engine.js'
import { FirstAlarmSimulator } from './sim/simulator.js'
import { TakClient } from './tak/client.js'
import { isUnitEvent } from './tak/cot.js'
import { shapeDeleteCot, shapeToCot } from './tak/shapes.js'
import type { IcsShape, Incident } from './types.js'
import { UnitRegistry } from './units.js'

// Deliberately NOT process.env.PORT — dev harnesses inject PORT for the web app,
// and picking it up here would collide with Vite on 5173. (4010 rather than the
// commonly-squatted 4000; override with WATCHTOWER_SERVER_PORT.)
const PORT = Number(process.env.WATCHTOWER_SERVER_PORT ?? 4010)

// TAK server CoT streaming endpoint (docker-compose publishes OTS TCP on host 8087).
const TAK_HOST = env('TAK_HOST', '127.0.0.1')
const TAK_PORT = Number(env('TAK_PORT', '8087'))

const app = express()
app.use(express.json())

const httpServer = createServer(app)

// ---------------------------------------------------------------------------
// WebSocket hub — pushes live state to every connected dashboard.
// Phase 3 will also pump CoT-derived unit updates through this.
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

export function broadcast(message: unknown): void {
  const raw = JSON.stringify(message)
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(raw)
  }
}

wss.on('connection', (socket) => {
  const state = getState()
  socket.send(
    JSON.stringify({
      type: 'snapshot',
      incident: state.incident,
      shapes: state.shapes,
      // Dashboards only need milestones (SITREP) — the unit.track flood stays
      // out of the snapshot (replay pulls the full timeline via REST).
      timeline: state.timeline.filter((e) => e.kind !== 'unit.track').slice(-400),
      units: registry.all(),
      takConnected: tak.connected,
    }),
  )
})

// ---------------------------------------------------------------------------
// TAK spine: CoT TCP client -> unit registry -> WebSocket fan-out.
// The registry is fed only by CoT that came THROUGH the real TAK server, so
// simulated units and real ATAK phones are indistinguishable downstream.
// ---------------------------------------------------------------------------
const registry = new UnitRegistry()
const tak = new TakClient(TAK_HOST, TAK_PORT)

// The simulator publishes on its OWN TAK connection, exactly like a real fleet
// of EUDs would — the TAK server then fans its traffic out to the dashboard's
// subscriber connection above. (Publishing on the subscriber socket wouldn't
// round-trip: TAK servers don't echo events back to their sender.)
const simTak = new TakClient(TAK_HOST, TAK_PORT, { uid: 'KEYSTONE-SIM', callsign: 'KS-SIM' })

/** Internal EUD identities — never shown as units. */
// Legacy WATCHTOWER-* uids stay filtered: a TAK server session started before
// the KeyStone rebrand may still fan out their old self-announcements.
const INTERNAL_UIDS = new Set(['KEYSTONE-COP', 'KEYSTONE-SIM', 'WATCHTOWER-COP', 'WATCHTOWER-SIM'])

tak.on('status', (connected: boolean) => broadcast({ type: 'tak.status', connected }))

tak.on('event', (ev) => {
  if (INTERNAL_UIDS.has(ev.uid)) return
  // Proof-of-protocol: log genuine CoT XML as it arrives off the TAK server.
  console.log(`[cot] rx ${(ev.raw ?? '').replace(/\s+/g, ' ').slice(0, 240)}`)
  if (isUnitEvent(ev)) registry.upsertFromCot(ev)
})

// Compact unit-track sampling for REPLAY: at most one timeline sample per unit
// per 8 s (plus every status change) keeps incident.json small but animatable.
const lastTrackSample = new Map<string, { t: number; status?: string }>()
registry.on('unit', (unit) => {
  broadcast({ type: 'unit', unit })
  const prev = lastTrackSample.get(unit.uid)
  const now = Date.now()
  if (!prev || now - prev.t > 8000 || prev.status !== unit.status) {
    lastTrackSample.set(unit.uid, { t: now, status: unit.status })
    appendTimeline('unit.track', {
      uid: unit.uid,
      callsign: unit.callsign,
      category: unit.category,
      agency: unit.agency,
      lat: unit.lat,
      lon: unit.lon,
      hae: unit.hae,
      floor: unit.floor,
      status: unit.status,
    })
  }
})
registry.on('remove', (uid) => broadcast({ type: 'unit.remove', uid }))

tak.start()
simTak.start()

/** Publish CoT XML into the TAK server (used by the simulator and shape tools). */
export function publishCot(xml: string): boolean {
  return simTak.send(xml)
}

// ---------------------------------------------------------------------------
// First-alarm simulator (Phase 4)
// ---------------------------------------------------------------------------
const simulator = new FirstAlarmSimulator(
  (xml) => publishCot(xml),
  (kind, payload) => {
    const ev = appendTimeline(kind, payload)
    broadcast({ type: 'timeline', event: ev })
  },
)

app.post('/api/dispatch', async (req, res) => {
  const state = getState()
  if (!state.incident) return res.status(400).json({ error: 'no active incident to dispatch to' })
  if (!tak.connected) return res.status(503).json({ error: 'TAK link down — cannot publish CoT' })
  try {
    const body = (req.body ?? {}) as { floors?: number }
    const result = await simulator.dispatch(state.incident.lat, state.incident.lon, {
      floors: typeof body.floors === 'number' ? body.floors : undefined,
    })
    res.status(201).json(result)
  } catch (err) {
    console.error('[sim] dispatch failed:', err)
    res.status(500).json({ error: 'dispatch failed' })
  }
})

app.post('/api/dispatch/stop', (_req, res) => {
  simulator.stop()
  res.json({ stopped: true })
})

// ---------------------------------------------------------------------------
// Staging tool (Phase 8+): auto-generate the next incoming unit designator —
// real next-nearest companies not already on the box, alternating E/L, with a
// synthetic fallback. Issued designators aren't repeated until a new incident.
// ---------------------------------------------------------------------------
const issuedStaging = new Set<string>()
let stagingFlip = 0

app.get('/api/staging/next', async (_req, res) => {
  const state = getState()
  if (!state.incident) return res.status(400).json({ error: 'no active incident' })
  const taken = new Set<string>([...registry.all().map((u) => u.callsign.toUpperCase()), ...issuedStaging])
  try {
    const { fetchFirehousesNear } = await import('./nyc.js')
    const houses = await fetchFirehousesNear(state.incident.lat, state.incident.lon)
    const wantLadder = stagingFlip++ % 3 === 2 // E, E, L, E, E, L …
    const pools: Array<{ prefix: string; nums: (f: (typeof houses)[number]) => number[] }> = wantLadder
      ? [
          { prefix: 'L', nums: (f) => f.ladders },
          { prefix: 'E', nums: (f) => f.engines },
        ]
      : [
          { prefix: 'E', nums: (f) => f.engines },
          { prefix: 'L', nums: (f) => f.ladders },
        ]
    for (const pool of pools) {
      for (const f of houses) {
        for (const n of pool.nums(f)) {
          const callsign = `${pool.prefix}-${n}`
          if (!taken.has(callsign)) {
            issuedStaging.add(callsign)
            return res.json({ callsign })
          }
        }
      }
    }
  } catch {
    // Open Data down — synthetic fallback below
  }
  let n = 200 + issuedStaging.size
  while (taken.has(`E-${n}`)) n++
  const callsign = `E-${n}`
  issuedStaging.add(callsign)
  res.json({ callsign })
})

app.post('/api/alarm', async (req, res) => {
  const { level } = req.body as { level?: string }
  if (!level || !['10-75', 'all-hands', '2nd', '3rd'].includes(level)) {
    return res.status(400).json({ error: 'level must be 10-75 | all-hands | 2nd | 3rd' })
  }
  const state = getState()
  if (!state.incident) return res.status(400).json({ error: 'no active incident' })
  const updated = updateIncident({ alarmLevel: level as Incident['alarmLevel'] })
  broadcast({ type: 'incident', incident: updated.incident })
  let added: string[] = []
  if (level !== '10-75') {
    const result = await simulator.escalate(level as 'all-hands' | '2nd' | '3rd')
    added = result.added
  }
  res.json({ level, added })
})

// ---------------------------------------------------------------------------
// ICS shapes (Phase 5): persist to incident.json, broadcast to dashboards,
// publish as CoT so connected ATAK clients render the same perimeter.
// ---------------------------------------------------------------------------
app.put('/api/shapes/:id', (req, res) => {
  const shape = req.body as IcsShape
  const knownKind = shape?.kind === 'zone' || shape?.kind === 'post' || shape?.kind === 'apparatus'
  if (!shape || shape.id !== req.params.id || !knownKind) {
    return res.status(400).json({ error: 'invalid shape' })
  }
  if (shape.kind === 'zone' && (!Array.isArray(shape.positions) || shape.positions.length < 3)) {
    return res.status(400).json({ error: 'zone needs >= 3 vertices' })
  }
  if (
    shape.kind === 'apparatus' &&
    (typeof shape.callsign !== 'string' ||
      !Number.isFinite(shape.lat) ||
      !Number.isFinite(shape.lon) ||
      !Number.isFinite(shape.heading))
  ) {
    return res.status(400).json({ error: 'apparatus needs callsign, lat, lon, heading' })
  }
  upsertShape(shape)
  broadcast({ type: 'shape', shape })
  publishCot(shapeToCot(shape))
  res.json(shape)
})

app.delete('/api/shapes/:id', (req, res) => {
  const removed = removeShape(req.params.id)
  if (!removed) return res.status(404).json({ error: 'unknown shape' })
  broadcast({ type: 'shape.remove', id: req.params.id })
  publishCot(shapeDeleteCot(req.params.id))
  res.json({ removed: true })
})

// ---------------------------------------------------------------------------
// Comms fusion (Phase 7): FDNY = real Whisper transcription (bundled recording
// as-if-live, or Broadcastify when configured); NYPD/EMS/OEM = scripted SIM.
// Legal posture documented in comms.ts and the README.
// ---------------------------------------------------------------------------
const AUDIO_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/audio/fdny-dispatch-demo.mp3')
const BROADCASTIFY_URL = env('BROADCASTIFY_URL', '')

app.get('/api/audio/fdny-dispatch-demo.mp3', (_req, res) => res.sendFile(AUDIO_PATH))

// Live audio proxy: browsers refuse user:pass@ URLs in media elements and
// undici's fetch rejects credentialed URLs outright — so the dashboard plays
// /api/audio/live and the server does the authenticated upstream fetch.
// Broadcastify credentials stay in .env and never reach the client.
app.get('/api/audio/live', async (req, res) => {
  if (!BROADCASTIFY_URL) return res.status(404).json({ error: 'no live stream configured' })
  const controller = new AbortController()
  req.on('close', () => controller.abort())
  try {
    const upstream = new URL(BROADCASTIFY_URL)
    const headers: Record<string, string> = {}
    if (upstream.username) {
      const user = decodeURIComponent(upstream.username)
      const pass = decodeURIComponent(upstream.password)
      headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
      upstream.username = ''
      upstream.password = ''
    }
    const proxied = await fetch(upstream, { headers, signal: controller.signal })
    if (!proxied.ok || !proxied.body) {
      return res.status(502).json({ error: `upstream ${proxied.status}` })
    }
    res.setHeader('content-type', proxied.headers.get('content-type') ?? 'audio/mpeg')
    res.setHeader('cache-control', 'no-store')
    const stream = Readable.fromWeb(proxied.body as unknown as import('node:stream/web').ReadableStream)
    // The abort on client disconnect surfaces as a stream 'error' — without a
    // listener that's an unhandled 'error' event and it takes the process down.
    stream.on('error', () => res.end())
    stream.pipe(res)
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error('[comms] live audio proxy failed:', err)
      if (!res.headersSent) res.status(502).json({ error: 'live stream unreachable' })
    }
  }
})

app.get('/api/comms/config', (_req, res) =>
  res.json({
    live: !!BROADCASTIFY_URL,
    audioUrl: BROADCASTIFY_URL ? '/api/audio/live' : '/api/audio/fdny-dispatch-demo.mp3',
  }),
)

const whisper = new WhisperLink(env('WHISPER_WS', 'ws://127.0.0.1:8765'))
whisper.on('line', (line: TranscriptLine) => {
  broadcast({ type: 'transcript', channel: 'fdny' as CommsChannel, line })
})
whisper.start()

const simComms = new SimComms()
simComms.on('line', (channel: CommsChannel, line: TranscriptLine) => {
  broadcast({ type: 'transcript', channel, line })
})
simComms.start()

// ---------------------------------------------------------------------------
// Incident API
// ---------------------------------------------------------------------------
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'keystone-server' }))

app.get('/api/incident', (_req, res) => res.json(getState()))

app.get('/api/units', (_req, res) => res.json({ units: registry.all(), takConnected: tak.connected }))

app.post('/api/incident', (req, res) => {
  const b = req.body as Partial<Incident>
  if (!b || typeof b.lat !== 'number' || typeof b.lon !== 'number' || !b.address || !b.id || !b.type) {
    return res.status(400).json({ error: 'incident requires id, address, lat, lon, type' })
  }
  const incident: Incident = {
    id: b.id,
    address: b.address,
    bin: b.bin,
    bbl: b.bbl,
    borough: b.borough,
    lat: b.lat,
    lon: b.lon,
    type: b.type,
    createdAt: b.createdAt ?? new Date().toISOString(),
  }
  // A new incident supersedes the old picture — stop any convergence in progress.
  simulator.stop()
  issuedStaging.clear()
  stagingFlip = 0
  const state = createIncident(incident)
  console.log(`[incident] created ${incident.id} — ${incident.type} @ ${incident.address}`)
  broadcast({ type: 'incident', incident: state.incident })
  res.status(201).json(state)
})

app.patch('/api/incident', (req, res) => {
  const state = getState()
  if (!state.incident) return res.status(404).json({ error: 'no active incident' })
  const updated = updateIncident(req.body as Partial<Incident>)
  broadcast({ type: 'incident', incident: updated.incident })
  res.json(updated)
})

app.post('/api/timeline', (req, res) => {
  const { kind, payload } = req.body as { kind?: string; payload?: unknown }
  if (!kind) return res.status(400).json({ error: 'kind required' })
  const ev = appendTimeline(kind, payload)
  broadcast({ type: 'timeline', event: ev })
  res.status(201).json(ev)
})

// ---------------------------------------------------------------------------
// Scenario playback (Prompt 8A): scripted incidents replayed through the SAME
// pipelines as live data — CoT via the sim TAK connection, transcripts on the
// comms bus, shapes through the store + CoT publisher.
// ---------------------------------------------------------------------------
const scenario = new ScenarioEngine({
  publishCot,
  broadcast,
  emitTimeline: (kind, payload) => {
    const ev = appendTimeline(kind, payload)
    broadcast({ type: 'timeline', event: ev })
  },
  createIncident: (incident) => {
    simulator.stop()
    issuedStaging.clear()
    stagingFlip = 0
    const state = createIncident(incident)
    console.log(`[scenario] incident ${incident.id} — ${incident.address}`)
    broadcast({ type: 'incident', incident: state.incident })
  },
  upsertShape,
  removeShape,
  removeUnit: (uid) => registry.remove(uid),
  setAlarm: (level) => {
    const updated = updateIncident({ alarmLevel: level })
    broadcast({ type: 'incident', incident: updated.incident })
  },
})

app.get('/api/scenario', (_req, res) => res.json(scenario.status()))

app.post('/api/scenario/load', async (req, res) => {
  const { name } = req.body as { name?: string }
  if (!name) return res.status(400).json({ error: 'name required' })
  try {
    await scenario.load(name)
    res.json(scenario.status())
  } catch (err) {
    console.error('[scenario] load failed:', err)
    res.status(404).json({ error: `scenario '${name}' not found or invalid` })
  }
})

app.post('/api/scenario/play', (_req, res) => {
  scenario.play()
  res.json(scenario.status())
})

app.post('/api/scenario/pause', (_req, res) => {
  scenario.pause()
  res.json(scenario.status())
})

app.post('/api/scenario/speed', (req, res) => {
  scenario.setSpeed(Number((req.body as { x?: number }).x))
  res.json(scenario.status())
})

app.post('/api/scenario/chapter', async (req, res) => {
  const { id } = req.body as { id?: string }
  if (!id) return res.status(400).json({ error: 'id required' })
  await scenario.seekChapter(id)
  res.json(scenario.status())
})

app.post('/api/scenario/stop', (_req, res) => {
  scenario.stop()
  res.json(scenario.status())
})

httpServer.listen(PORT, () => {
  console.log(`[keystone-server] listening on :${PORT} (http + ws /ws)`)
})
