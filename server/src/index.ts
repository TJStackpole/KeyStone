import express from 'express'
import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { appendTimeline, createIncident, getState, updateIncident } from './incidentStore.js'
import type { Incident } from './types.js'

// Deliberately NOT process.env.PORT — dev harnesses inject PORT for the web app,
// and picking it up here would collide with Vite on 5173.
const PORT = Number(process.env.WATCHTOWER_SERVER_PORT ?? 4000)

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
  socket.send(JSON.stringify({ type: 'snapshot', ...getState() }))
})

// ---------------------------------------------------------------------------
// Incident API
// ---------------------------------------------------------------------------
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'watchtower-server' }))

app.get('/api/incident', (_req, res) => res.json(getState()))

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
