import express from 'express'
import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { env } from './env.js'
import { appendTimeline, createIncident, getState, updateIncident } from './incidentStore.js'
import { TakClient } from './tak/client.js'
import { isUnitEvent } from './tak/cot.js'
import type { Incident } from './types.js'
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
      ...getState(),
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

tak.on('status', (connected: boolean) => broadcast({ type: 'tak.status', connected }))

tak.on('event', (ev) => {
  // Proof-of-protocol: log genuine CoT XML as it arrives off the TAK server.
  console.log(`[cot] rx ${(ev.raw ?? '').replace(/\s+/g, ' ').slice(0, 240)}`)
  if (isUnitEvent(ev)) registry.upsertFromCot(ev)
})

registry.on('unit', (unit) => broadcast({ type: 'unit', unit }))
registry.on('remove', (uid) => broadcast({ type: 'unit.remove', uid }))

tak.start()

/** Publish CoT XML into the TAK server (used by the simulator and shape tools). */
export function publishCot(xml: string): boolean {
  return tak.send(xml)
}

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
