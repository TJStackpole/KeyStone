import express from 'express'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { SimComms, WhisperLink, type CommsChannel, type TranscriptLine } from './comms.js'
import { DispatchFeed } from './dispatchFeed.js'
import { env } from './env.js'
import {
  appendTimeline,
  clearIncident,
  createIncident,
  getState,
  removeShape,
  updateIncident,
  upsertShape,
} from './incidentStore.js'
import { ScenarioEngine } from './scenario/engine.js'
import { FirstAlarmSimulator } from './sim/simulator.js'
import { buildGeoChatXml, extractGeoChat, type ChatMsg } from './tak/chat.js'
import { CHAT_ROOMS, SimUnitChatter } from './simChat.js'
import { doctrine, MIN_RELEVANT_SCORE } from './doctrine.js'
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

// Backpressure policy: a slow or half-open dashboard must not queue the live
// feed unboundedly in server memory. High-rate SA frames (units.batch) are
// DROPPABLE — every unit re-emits within seconds, so a skipped delta heals on
// its own. Small history-bearing frames (transcript/chat/timeline/incident/
// shape) are never shed: the snapshot doesn't resync transcripts.
const DROPPABLE_TYPES = new Set(['units.batch', 'unit'])
const SOFT_BUFFER_LIMIT = 256 * 1024
const HARD_BUFFER_LIMIT = 4 * 1024 * 1024

export function broadcast(message: unknown): void {
  const raw = JSON.stringify(message)
  const droppable = DROPPABLE_TYPES.has((message as { type?: string }).type ?? '')
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue
    if (client.bufferedAmount > HARD_BUFFER_LIMIT) {
      // Hopeless backlog — cut it loose; the client's reconnect-forever loop
      // plus the connection snapshot restores full state.
      client.terminate()
      continue
    }
    if (droppable && client.bufferedAmount > SOFT_BUFFER_LIMIT) continue
    client.send(raw)
  }
}

// One malformed frame from ANY client (flaky proxy, buggy EUD, port scan)
// raises 'error' on the socket — unlistened, that is an uncaught exception
// that kills the entire server mid-demo. ws closes the connection itself.
wss.on('error', (err) => console.warn('[ws] server error:', err.message))

// Canonical ws heartbeat: half-open dashboards (sleeping laptops, dropped
// Wi-Fi) never fire 'close' on their own — ping them and reap the silent.
const socketAlive = new WeakMap<WebSocket, boolean>()
setInterval(() => {
  for (const client of wss.clients) {
    if (socketAlive.get(client) === false) {
      client.terminate()
      continue
    }
    socketAlive.set(client, false)
    client.ping()
  }
}, 30_000).unref()

wss.on('connection', (socket) => {
  socket.on('error', (err) => console.warn('[ws] client error:', err.message))
  socketAlive.set(socket, true)
  socket.on('pong', () => socketAlive.set(socket, true))
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
      chats: chatLog.slice(-200), // match the retention cap — reconnects must not shear scrollback
      // Reconnecting dashboards learn drill state here — a server restart
      // mid-drill otherwise leaves a stale "playing" DRILL bar forever.
      scenario: scenario.status(),
      // SIMULATED citywide dispatch feed (FDNY/NYPD/PAPD dispatch centers).
      dispatchFeed: dispatchFeed.all(),
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

// ------------------------------- TAK GeoChat --------------------------------
const chatLog: ChatMsg[] = []
const seenChatIds = new Set<string>()

function recordChat(msg: ChatMsg): void {
  if (seenChatIds.has(msg.id)) return
  seenChatIds.add(msg.id)
  chatLog.push(msg)
  if (chatLog.length > 200) {
    // Keep the dedupe set bounded to the retained window — it only needs to
    // catch the TAK fan-out echo, which arrives within a round-trip.
    const evicted = chatLog.shift()
    if (evicted) seenChatIds.delete(evicted.id)
  }
  broadcast({ type: 'chat', msg })
}

tak.on('event', (ev) => {
  if (INTERNAL_UIDS.has(ev.uid)) return
  // GeoChat from any EUD on the server (including our own fan-out echo,
  // which the id-dedupe drops).
  if (ev.type === 'b-t-f' && ev.raw) {
    const msg = extractGeoChat(ev.raw, ev.uid)
    if (msg) recordChat(msg)
    return
  }
  // Proof-of-protocol: log genuine CoT as it arrives off the TAK server —
  // but not the simulator's own echo (20-30 sync stdout writes/s at a
  // 3rd alarm; real ATAK traffic still logs every event).
  if (!ev.uid.startsWith('WT-SIM-') && !ev.uid.startsWith('DRILL-')) {
    console.log(`[cot] rx ${(ev.raw ?? '').replace(/\s+/g, ' ').slice(0, 240)}`)
  }
  if (isUnitEvent(ev)) registry.upsertFromCot(ev)
})

app.get('/api/chat', (_req, res) => res.json({ chats: chatLog.slice(-200) }))

// ---------------------- Module 1: Ask the Manuals ---------------------------
// Extractive search over the locally-indexed FD Books corpus. Only short
// query-relevant snippets with full citations ever leave this process.
doctrine.load()

app.get('/api/doctrine/status', (_req, res) =>
  res.json({ ready: doctrine.ready, report: doctrine.report }),
)

// Module 3: pre-generated tactics cards (derived from the corpus — local
// only, same licensing posture as the doctrine index).
const TACTICS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../data/tactics')

app.get('/api/tactics/:type', (req, res) => {
  const t = String(req.params.type).replace(/[^a-z_]/g, '')
  const p = resolve(TACTICS_DIR, `${t}.json`)
  if (!existsSync(p)) {
    return res.status(404).json({ error: 'no tactics card generated for this type yet' })
  }
  try {
    res.json(JSON.parse(readFileSync(p, 'utf8')))
  } catch (err) {
    console.error('[tactics] card read failed:', err)
    res.status(500).json({ error: 'card unreadable' })
  }
})

app.get('/api/doctrine/ask', (req, res) => {
  const q = String(req.query.q ?? '').trim()
  const topic = req.query.topic ? String(req.query.topic) : undefined
  if (!q) return res.status(400).json({ error: 'q required' })
  if (!doctrine.ready) {
    return res.json({ ready: false, found: false, results: [] })
  }
  const results = doctrine.search(q, 6, topic)
  // Honesty floor: the corpus only "answers" when the best page is BOTH
  // strong AND covers most of the question's terms — one rare word matching
  // somewhere must not masquerade as an answer.
  const found =
    results.length > 0 && results[0].score >= MIN_RELEVANT_SCORE && results[0].coverage >= 0.5
  res.json({ ready: true, found, results: found ? results : [] })
})

app.post('/api/chat', (req, res) => {
  const { text, room } = req.body as { text?: string; room?: string }
  const trimmed = (text ?? '').trim()
  if (!trimmed) return res.status(400).json({ error: 'text required' })
  if (trimmed.length > 500) return res.status(400).json({ error: 'message too long (500 max)' })
  // Interagency comm architecture: the console speaks as OEM Watch Command
  // into the broadcast room or any agency room (FDNY/NYPD/EMS/PAPD/OEM).
  const targetRoom =
    room && (CHAT_ROOMS as readonly string[]).includes(room) ? room : 'All Chat Rooms'
  const msgId = Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)
  const sender = { uid: 'KEYSTONE-COP', callsign: 'OEM WATCH CMD' }
  const xml = buildGeoChatXml(trimmed, sender, msgId, targetRoom)
  const sent = publishCot(xml)
  if (!sent) return res.status(503).json({ error: 'TAK link down — message not sent' })
  const msg: ChatMsg = {
    id: `GeoChat.${sender.uid}.${targetRoom}.${msgId}`,
    from: sender.callsign,
    room: targetRoom,
    text: trimmed,
    ts: new Date().toISOString(),
    self: true,
  }
  recordChat(msg)
  res.status(201).json(msg)
})

// Compact unit-track sampling for REPLAY: at most one timeline sample per unit
// per 8 s (plus every status change) keeps incident.json small but animatable.
const lastTrackSample = new Map<string, { t: number; status?: string }>()

// Unit updates COALESCE into one WS frame per 200 ms window: a 30-unit
// incident otherwise sends ~15 messages/s, each costing every dashboard a
// full state write + React render pass. Batching cuts that to <=5/s with the
// same on-screen freshness (positions interpolate client-side anyway).
const pendingUnits = new Map<string, ReturnType<typeof registry.all>[number]>()
setInterval(() => {
  if (!pendingUnits.size) return
  // Drop anything removed from the registry since it was queued — belt to the
  // remove-handler purge (covers bulk purges that bypass the remove event).
  const live = [...pendingUnits.values()].filter((u) => registry.get(u.uid))
  pendingUnits.clear()
  if (live.length) broadcast({ type: 'units.batch', units: live })
}, 200).unref()

registry.on('unit', (unit) => {
  pendingUnits.set(unit.uid, unit)
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
registry.on('remove', (uid) => {
  // Purge the coalescer buffer FIRST: a queued update flushed after this
  // remove would resurrect the unit on every dashboard as a permanent ghost
  // (the registry no longer knows it, so no further remove ever arrives).
  pendingUnits.delete(uid)
  lastTrackSample.delete(uid)
  simChatter.forget(uid)
  broadcast({ type: 'unit.remove', uid })
})

// Simulated arrival chatter: sim/drill units post a GeoChat line into their
// agency's room when they arrive on scene (published as real CoT via TAK,
// so it round-trips back through the same pipeline as human messages).
const simChatter = new SimUnitChatter(
  (xml) => publishCot(xml),
  (msg) => recordChat(msg),
)
registry.on('unit', (unit) => simChatter.onUnit(unit))

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
    // Tag sim events with the incident they belong to — clients must never
    // apply a stale dispatch (fire floor, floor count) to a newer incident.
    const tagged =
      payload && typeof payload === 'object'
        ? { ...(payload as Record<string, unknown>), incidentId: getState().incident?.id }
        : payload
    const ev = appendTimeline(kind, tagged)
    broadcast({ type: 'timeline', event: ev })
  },
)

app.post('/api/dispatch', async (req, res) => {
  const state = getState()
  if (!state.incident) return res.status(400).json({ error: 'no active incident to dispatch to' })
  if (!tak.connected) return res.status(503).json({ error: 'TAK link down — cannot publish CoT' })
  simChatter.reset() // a fresh assignment announces its arrivals anew
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
          // Check issuedStaging LIVE — `taken` was snapshotted before the
          // await, so two concurrent dashboards could otherwise get the
          // same company.
          if (!taken.has(callsign) && !issuedStaging.has(callsign)) {
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
  while (taken.has(`E-${n}`) || issuedStaging.has(`E-${n}`)) n++
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
  try {
    if (level !== '10-75') {
      const result = await simulator.escalate(level as 'all-hands' | '2nd' | '3rd')
      added = result.added
    }
  } catch (err) {
    // The alarm LEVEL is already applied/broadcast — report the escalation
    // shortfall instead of dying (Express 4 + Node's fail-fast rejections).
    console.error('[alarm] escalation failed:', err)
    return res.json({ level, added: [], warning: 'escalation units unavailable' })
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
  // Build the CoT FIRST: if the shape is malformed in a way validation
  // missed, we must find out BEFORE persisting/broadcasting it — a poisoned
  // shape in the store would crash every future snapshot consumer.
  let cot: string
  try {
    cot = shapeToCot(shape)
  } catch (err) {
    console.error('[shapes] rejected unencodable shape:', err)
    return res.status(400).json({ error: 'shape could not be encoded' })
  }
  upsertShape(shape)
  broadcast({ type: 'shape', shape })
  publishCot(cot)
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

// ---------------------------------------------------------------------------
// SIMULATED citywide dispatch feed (FDNY / NYPD / PAPD dispatch centers):
// the "other boxes" running around the city, broken down by FDNY division
// and battalion for the INCIDENTS dropdown. Rotating, labeled SIMULATED.
// ---------------------------------------------------------------------------
const dispatchFeed = new DispatchFeed()
dispatchFeed.on('update', (incidents) => broadcast({ type: 'dispatch.feed', incidents }))
dispatchFeed.start()

app.get('/api/dispatch/feed', (_req, res) => res.json({ incidents: dispatchFeed.all() }))

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

// Street View panorama metadata (free endpoint): finds the nearest pano to
// the incident so the client can aim the embed at the building's front.
// Keyless installs get NO_KEY and the client shows the honest fallback.
app.get('/api/streetview/meta', async (req, res) => {
  const key = env('GOOGLE_MAPS_API_KEY', '')
  if (!key) return res.json({ status: 'NO_KEY' })
  const lat = Number(req.query.lat)
  const lon = Number(req.query.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'lat and lon required' })
  }
  try {
    const url =
      `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lon}` +
      `&source=outdoor&key=${encodeURIComponent(key)}`
    const upstream = await fetch(url)
    const body = (await upstream.json()) as {
      status?: string
      pano_id?: string
      date?: string
      location?: { lat?: number; lng?: number }
    }
    res.json({
      status: body.status ?? 'UNKNOWN',
      panoId: body.pano_id,
      date: body.date,
      lat: body.location?.lat,
      lon: body.location?.lng,
    })
  } catch (err) {
    console.error('[streetview] metadata failed:', err)
    res.status(502).json({ status: 'ERROR' })
  }
})

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
  // A new incident supersedes the old picture — stop any convergence in
  // progress, including a running scenario drill, and purge the old sim
  // units immediately (stale-sweep would leave ghosts for ~2.5 minutes).
  scenario.stop()
  simulator.stop()
  for (const u of registry.all()) if (u.uid.startsWith('WT-SIM-')) registry.remove(u.uid)
  issuedStaging.clear()
  stagingFlip = 0
  simChatter.reset() // fresh incident — units announce their next arrival
  const state = createIncident(incident)
  console.log(`[incident] created ${incident.id} — ${incident.type} @ ${incident.address}`)
  broadcast({ type: 'incident', incident: state.incident })
  res.status(201).json(state)
})

// Cancel everything: drill, demo dispatch, shapes, incident. The registry is
// emptied too — live ATAK clients re-announce within seconds, so the picture
// rebuilds from genuinely live traffic only.
app.delete('/api/incident', (_req, res) => {
  scenario.stop()
  simulator.stop()
  issuedStaging.clear()
  stagingFlip = 0
  simChatter.reset()
  for (const u of registry.all()) registry.remove(u.uid)
  const state = clearIncident()
  broadcast({ type: 'incident', incident: null })
  broadcast({ type: 'exposure', labels: [] })
  broadcast({ type: 'alert', alert: { kind: 'clear' } })
  console.log('[incident] cleared — board reset')
  res.json(state)
})

app.patch('/api/incident', (req, res) => {
  const state = getState()
  if (!state.incident) return res.status(404).json({ error: 'no active incident' })
  // Whitelist: type chips, alarm ladder, and LIVE ADDRESS CORRECTION (the
  // dispatch address is often wrong; the corrected one may relocate the
  // incident). Coordinates are validated to the NYC envelope — corrupt
  // lat/lon would poison dispatch + CoT.
  const b = req.body as Partial<Incident>
  const patch: Partial<Incident> = {}
  if (typeof b.type === 'string') patch.type = b.type
  if (typeof b.alarmLevel === 'string') patch.alarmLevel = b.alarmLevel
  if (typeof b.address === 'string' && b.address.trim()) patch.address = b.address.trim().slice(0, 160)
  if (typeof b.lat === 'number' && typeof b.lon === 'number') {
    if (b.lat > 40.4 && b.lat < 41.1 && b.lon > -74.4 && b.lon < -73.5) {
      patch.lat = b.lat
      patch.lon = b.lon
      patch.bin = typeof b.bin === 'string' ? b.bin : undefined
      patch.bbl = typeof b.bbl === 'string' ? b.bbl : undefined
      patch.borough = typeof b.borough === 'string' ? b.borough : undefined
    } else {
      return res.status(400).json({ error: 'coordinates outside the NYC envelope' })
    }
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'only type/alarmLevel/address are patchable' })
  const updated = updateIncident(patch)
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
    simChatter.reset() // drill units announce their arrivals too
    const state = createIncident(incident)
    console.log(`[scenario] incident ${incident.id} — ${incident.address}`)
    broadcast({ type: 'incident', incident: state.incident })
  },
  upsertShape,
  removeShape,
  removeUnit: (uid, opts) => registry.remove(uid, opts?.tombstone !== false),
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
  try {
    await scenario.seekChapter(id)
  } catch (err) {
    // Express 4 never forwards async rejections — one throw inside a seek
    // would otherwise take the whole process down (Node fail-fast default).
    console.error('[scenario] chapter seek failed:', err)
    return res.status(500).json({ error: 'seek failed' })
  }
  res.json(scenario.status())
})

// Progress-bar scrubbing: seek to an arbitrary scenario second.
app.post('/api/scenario/seek', (req, res) => {
  const { t } = req.body as { t?: number }
  if (typeof t !== 'number' || !Number.isFinite(t)) return res.status(400).json({ error: 't (seconds) required' })
  scenario.seekTo(t)
  res.json(scenario.status())
})

app.post('/api/scenario/stop', (_req, res) => {
  scenario.stop()
  res.json(scenario.status())
})

// Node's default kills the process on any unhandled rejection — for a
// long-running demo server, log LOUDLY and keep serving instead.
process.on('unhandledRejection', (reason) => {
  console.error('[server] UNHANDLED REJECTION (kept alive):', reason)
})

httpServer.listen(PORT, () => {
  console.log(`[keystone-server] listening on :${PORT} (http + ws /ws)`)
})
