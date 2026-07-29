import express from 'express'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
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
import { FirstAlarmSimulator } from './sim/simulator.js'
import { TakClient } from './tak/client.js'
import { isUnitEvent } from './tak/cot.js'
import { shapeDeleteCot, shapeToCot } from './tak/shapes.js'
import type { IcsShape, Incident } from './types.js'
import { UnitRegistry } from './units.js'

// Deliberately NOT process.env.PORT — dev harnesses inject PORT for the web app,
// and picking it up here would collide with Vite on 5173.
const PORT = Number(process.env.WATCHTOWER_SERVER_PORT ?? 4000)

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
  socket.send(
    JSON.stringify({
      type: 'snapshot',
      ...getState(), // includes shapes
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
const simTak = new TakClient(TAK_HOST, TAK_PORT, { uid: 'WATCHTOWER-SIM', callsign: 'WT-SIM' })

/** Internal EUD identities — never shown as units. */
const INTERNAL_UIDS = new Set(['WATCHTOWER-COP', 'WATCHTOWER-SIM'])

tak.on('status', (connected: boolean) => broadcast({ type: 'tak.status', connected }))

tak.on('event', (ev) => {
  if (INTERNAL_UIDS.has(ev.uid)) return
  // Proof-of-protocol: log genuine CoT XML as it arrives off the TAK server.
  console.log(`[cot] rx ${(ev.raw ?? '').replace(/\s+/g, ' ').slice(0, 240)}`)
  if (isUnitEvent(ev)) registry.upsertFromCot(ev)
})

registry.on('unit', (unit) => broadcast({ type: 'unit', unit }))
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

app.post('/api/dispatch', async (_req, res) => {
  const state = getState()
  if (!state.incident) return res.status(400).json({ error: 'no active incident to dispatch to' })
  if (!tak.connected) return res.status(503).json({ error: 'TAK link down — cannot publish CoT' })
  try {
    const result = await simulator.dispatch(state.incident.lat, state.incident.lon)
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
// ICS shapes (Phase 5): persist to incident.json, broadcast to dashboards,
// publish as CoT so connected ATAK clients render the same perimeter.
// ---------------------------------------------------------------------------
app.put('/api/shapes/:id', (req, res) => {
  const shape = req.body as IcsShape
  if (!shape || shape.id !== req.params.id || (shape.kind !== 'zone' && shape.kind !== 'post')) {
    return res.status(400).json({ error: 'invalid shape' })
  }
  if (shape.kind === 'zone' && (!Array.isArray(shape.positions) || shape.positions.length < 3)) {
    return res.status(400).json({ error: 'zone needs >= 3 vertices' })
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

app.get('/api/comms/config', (_req, res) =>
  res.json({
    live: !!BROADCASTIFY_URL,
    audioUrl: BROADCASTIFY_URL || '/api/audio/fdny-dispatch-demo.mp3',
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
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'watchtower-server' }))

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

httpServer.listen(PORT, () => {
  console.log(`[watchtower-server] listening on :${PORT} (http + ws /ws)`)
})
