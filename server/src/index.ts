import express from 'express'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { SimComms, WhisperLink, type CommsChannel, type TranscriptLine } from './comms.js'
import { DispatchFeed, type FeedIncident } from './dispatchFeed.js'
import { env } from './env.js'
import {
  appendRequestUpdate,
  openRequest,
  REQUEST_THRESHOLDS_MS,
  requestMetrics,
  requests,
  requestsWire,
  transitionRequest,
  type InteragencyRequest,
  type RequestPriority,
  type RequestState,
} from './requests.js'
import { OpsClock } from './opsClock.js'
import { POLICY_SCHEMA, setVisibilityPolicy, visibilityPolicy } from './policy.js'
import { allFeedHealth, clearAllFeedMocks, feedData, pushableFeedData, registerFeed, setFeedMock, startFeeds } from './feeds/registry.js'
import dotCameras from './feeds/adapters/dotCameras.js'
import mtaSubway from './feeds/adapters/mtaSubway.js'
import noaaWater from './feeds/adapters/noaaWater.js'
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
import { nextAlarmLevel } from './sim/assignment.js'
import { DRILL_UID_PREFIX, isForeignSimUid, SIM_UID_PREFIX } from './sim/ns.js'
import { FirstAlarmSimulator } from './sim/simulator.js'
import { POST_LABEL } from './tak/shapes.js'
import { buildGeoChatXml, extractGeoChat, type ChatMsg } from './tak/chat.js'
import { CHAT_ROOMS, SimUnitChatter } from './simChat.js'
import { doctrine, MIN_RELEVANT_SCORE } from './doctrine.js'
import { TakClient } from './tak/client.js'
import { isUnitEvent } from './tak/cot.js'
import { shapeDeleteCot, shapeToCot } from './tak/shapes.js'
import type { IcsShape, Incident } from './types.js'
import { UnitRegistry, type Unit } from './units.js'

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
const pingBacklog = new WeakMap<WebSocket, number>()
setInterval(() => {
  for (const client of wss.clients) {
    if (socketAlive.get(client) === false) {
      // No pong — but ws queues pings behind buffered data, so a SLOW client
      // that is still draining is alive, not half-open. Only terminate when
      // the backlog has not shrunk since the ping was queued.
      const atPing = pingBacklog.get(client) ?? 0
      if (client.bufferedAmount >= atPing) {
        client.terminate()
        continue
      }
    }
    socketAlive.set(client, false)
    pingBacklog.set(client, client.bufferedAmount)
    client.ping()
  }
}, 30_000).unref()

// Prompt 13 — feed ingestion layer: register every adapter, then start the
// staggered polling loops. Each feed degrades alone; keys are all optional.
for (const adapter of [mtaSubway, dotCameras, noaaWater]) registerFeed(adapter)
startFeeds(broadcast)

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
      // Prompt 11 — NYCEM coordination layer state.
      portfolio: portfolio(),
      // Wire slice: active + recent terminal — the full accountability set
      // stays server-side for metrics/AAR (it accretes by design).
      requests: requestsWire(),
      requestThresholds: REQUEST_THRESHOLDS_MS,
      // Prompt 13 — live-data layer: health for every registered feed plus
      // the latest payload of each push-enabled feed (big pull-only lists
      // like the camera inventory are fetched over REST on demand).
      feeds: { health: allFeedHealth(), data: pushableFeedData() },
      // Prompt 12 — cross-agency visibility policy (hot-reloads via PUT).
      visibilityPolicy: visibilityPolicy(),
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
    // A parallel dev stack's sim arrival chatter belongs to ITS incident —
    // drop it along with that stack's units (see sim/ns.ts).
    if (msg && !isForeignSimUid(msg.senderUid ?? '')) recordChat(msg)
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

// Prompt 13 — feed layer: health board + per-feed latest payload (pull path
// for big lists; the ws pushes the small ones).
app.get('/api/feeds/health', (_req, res) => res.json({ feeds: allFeedHealth() }))
app.get('/api/feeds/:id', (req, res) => {
  const data = feedData(req.params.id)
  if (!data) return res.status(404).json({ error: 'no data for feed (unknown id, or nothing fetched yet)' })
  res.json(data)
})

// ---------------------- Module 1: Ask the Manuals ---------------------------
// Extractive search over the locally-indexed FD Books corpus. Only short
// query-relevant snippets with full citations ever leave this process.
// Doctrine loads lazily on first use (doctrine.ensureLoaded below) — the
// index rebuild does not belong on the boot path of every dev restart.

app.get('/api/doctrine/status', (_req, res) =>
  (doctrine.ensureLoaded(), res.json({ ready: doctrine.ready, loading: doctrine.loading, report: doctrine.report })),
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
  doctrine.ensureLoaded()
  if (!doctrine.ready) {
    // loading=true → the index exists and is warming (lazy first use);
    // loading=false → genuinely missing on disk. The client must not tell
    // stakeholders to rebuild a corpus that is 300 ms from ready.
    return res.json({ ready: false, loading: doctrine.loading, found: false, results: [] })
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

// Change gate: CoT is a heartbeat protocol — every publisher re-announces
// before its stale time whether or not anything changed, and at a working
// fire most of the roster is parked On Scene. Without a gate every heartbeat
// re-broadcasts the full unchanged Unit to every dashboard (~15-20 KB/batch
// steady-state) and wakes every subscribed component for a no-op. Forward a
// unit only when an observable field changed, plus a keepalive well inside
// the 120 s stale + 30 s grace window so staleAt keeps refreshing downstream.
const UNIT_KEEPALIVE_MS = 20_000
const lastForwarded = new Map<string, { sig: string; t: number }>()

/**
 * Observable-field signature. Comparing whole Unit objects can never match —
 * upsertFromCot stamps fresh updatedAt/staleAt/cotTime on every heartbeat.
 * Positions quantize to ~1 m so a real EUD's GPS breathing while parked
 * doesn't defeat the gate (sim rigs repeat exact coordinates anyway); any
 * real reposition clears the quantum in one tick.
 */
function unitSig(u: Unit): string {
  return [
    u.callsign,
    u.category,
    u.cotType,
    u.status ?? '',
    u.floor ?? '',
    u.lat.toFixed(5),
    u.lon.toFixed(5),
    u.hae.toFixed(1),
    u.course?.toFixed(0) ?? '',
    u.speed?.toFixed(1) ?? '',
    u.bio ? JSON.stringify(u.bio) : '',
  ].join('|')
}

registry.on('unit', (unit) => {
  const sig = unitSig(unit)
  const fwd = lastForwarded.get(unit.uid)
  const nowMs = Date.now()
  if (!fwd || fwd.sig !== sig || nowMs - fwd.t >= UNIT_KEEPALIVE_MS) {
    lastForwarded.set(unit.uid, { sig, t: nowMs })
    pendingUnits.set(unit.uid, unit)
  }
  // Replay track sampling stays fed by EVERY event (it self-limits below) —
  // gating it would tie recorded history to the WS fan-out policy.
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
  // And the gate's memory — a respawn under the same uid must forward fresh.
  lastForwarded.delete(uid)
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
    const body = (req.body ?? {}) as { floors?: number; demo?: boolean }
    const result = await simulator.dispatch(state.incident.lat, state.incident.lon, {
      floors: typeof body.floors === 'number' ? body.floors : undefined,
      demo: body.demo === true,
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

// What the NEXT alarm level would bring — same plan + reinforcement logic
// as a real escalation, zero dispatch. Feeds the RESOURCES ledger.
app.get('/api/alarm/preview', async (_req, res) => {
  const state = getState()
  if (!state.incident) return res.status(400).json({ error: 'no active incident' })
  const next = nextAlarmLevel(state.incident.alarmLevel)
  if (!next) return res.json({ nextLevel: null, adds: [] })
  if (next === '10-75') return res.json({ nextLevel: next, adds: [], simActive: simulator.active }) // level change only
  const adds = await simulator.previewEscalation(next)
  res.json({ nextLevel: next, adds, simActive: simulator.active })
})

/** The FDNY code the IC actually pressed — the record must not read wire ids. */
const ALARM_CODE: Record<string, string> = {
  '10-75': '10-75',
  'all-hands': 'ALL HANDS',
  '2nd': '2ND ALARM',
  '3rd': '3RD ALARM',
  '4th': '4TH ALARM',
  '5th': '5TH ALARM',
}

app.post('/api/alarm', async (req, res) => {
  const { level } = req.body as { level?: string }
  if (!level || !['10-75', 'all-hands', '2nd', '3rd', '4th', '5th'].includes(level)) {
    return res.status(400).json({ error: 'level must be 10-75 | all-hands | 2nd | 3rd | 4th | 5th' })
  }
  const state = getState()
  if (!state.incident) return res.status(400).json({ error: 'no active incident' })
  // Alarms only climb. Without this, a double-tap dispatches a SECOND full
  // reinforcement set (escalate() rebuilds against current units), and a
  // stray 10-75 press at 3rd alarm silently downgrades the box.
  const ladder = ['10-75', 'all-hands', '2nd', '3rd', '4th', '5th']
  const cur = state.incident.alarmLevel ? ladder.indexOf(state.incident.alarmLevel) : -1
  if (ladder.indexOf(level) <= cur) {
    return res.status(409).json({ level, added: [], error: 'already at or above this alarm level' })
  }
  const updated = updateIncident({ alarmLevel: level as Incident['alarmLevel'] })
  broadcast({ type: 'incident', incident: updated.incident })
  // Escalation and its log entry are ONE path: every alarm caller (command
  // strip, decision log) both dispatches and records — never one without
  // the other.
  const benchEv = appendTimeline('ic.benchmark', { code: ALARM_CODE[level] ?? level.toUpperCase() })
  broadcast({ type: 'timeline', event: benchEv })
  ticker('alarm', `Alarm level ${ALARM_CODE[level] ?? level.toUpperCase()} — ${updated.incident?.address ?? ''}`, {
    incidentId: updated.incident?.id,
    severity: ALARM_SEVERITY[level] ?? 2,
  })
  broadcastPortfolio()
  let added: string[] = []
  try {
    if (level !== '10-75') {
      const result = await simulator.escalate(level as 'all-hands' | '2nd' | '3rd' | '4th' | '5th')
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
  // The label fallback in shapeToCot no longer throws on unknown post kinds
  // — validate here so a poisoned shape can't persist.
  if (shape.kind === 'post' && !(shape.post in POST_LABEL)) {
    return res.status(400).json({ error: `unknown post kind '${String(shape.post)}'` })
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
dispatchFeed.on('update', (incidents: FeedIncident[]) => {
  broadcast({ type: 'dispatch.feed', incidents })
  // Ticker: new boxes and closed boxes from the simulated dispatch centers.
  // The FIRST update after boot is the feed's seeded inventory, not news —
  // announcing it re-tickers every existing box on every server restart.
  const ids = new Set(incidents.map((i) => i.id))
  if (feedSeeded) {
    for (const i of incidents) {
      if (!knownFeedIds.has(i.id)) {
        ticker('new-incident', `${i.source} dispatch: ${i.type} — ${i.address}, ${i.borough}`, {
          incidentId: i.id,
          agency: i.source,
          borough: i.borough,
          severity: 1,
          sim: true,
        })
      }
    }
    for (const id of knownFeedIds) {
      if (!ids.has(id)) ticker('incident-closed', `Box closed: ${id}`, { incidentId: id, sim: true })
    }
  }
  feedSeeded = true
  knownFeedIds.clear()
  for (const id of ids) knownFeedIds.add(id)
  broadcastPortfolio()
})
const knownFeedIds = new Set<string>()
let feedSeeded = false
// NOTE: dispatchFeed.start() is deferred until after the scenario engine is
// constructed — the update listener walks portfolio(), which reads it.

app.get('/api/dispatch/feed', (_req, res) => res.json({ incidents: dispatchFeed.all() }))

// ---------------------------------------------------------------------------
// Prompt 11 — NYCEM coordination layer: the pieces that sit ABOVE incidents.
// KeyStone is a neutral read-and-coordinate layer; CIMS labels (Primary /
// Supporting / Coordinating Agency) are used exactly and never inferred as
// command authority.
// ---------------------------------------------------------------------------

/** The citywide ticker left with the NYCEM coordination bundle — call
 *  sites keep their shape (the timeline is the surviving record). */
function ticker(_kind: string, _text: string, _extra: Record<string, unknown> = {}): void {
  void _kind
}

/** CIMS Primary Agency for the tactical board's incident types. */
const PRIMARY_BY_TYPE: Record<string, string> = {
  'Structural Fire': 'FDNY',
  Hazmat: 'FDNY',
  Collapse: 'FDNY',
  'Mass Casualty': 'EMS',
}
const ALARM_SEVERITY: Record<string, number> = { '10-75': 2, 'all-hands': 3, '2nd': 4, '3rd': 5, '4th': 5, '5th': 5 }

export interface PortfolioIncident {
  id: string
  address: string
  borough: string
  lat: number
  lon: number
  type: string
  severity: number
  primaryAgency: string
  supportingAgencies: string[]
  /** "Tracked in KeyStone" rollup — never authoritative citywide availability. */
  unitsByAgency: Record<string, number>
  startedAt: string
  source: 'board' | 'scenario' | 'feed'
  alarmLevel?: string
  openRequests: number
  /** True for the incident currently on the tactical board. */
  focused: boolean
}

function openRequestCount(incidentId: string): number {
  return requests().filter(
    (r) => r.incidentId === incidentId && r.state !== 'complete' && r.state !== 'declined',
  ).length
}

/** The Watch Command portfolio: every active incident KeyStone knows about,
 *  from every source, as ONE shared list — no duplicate state. */
function portfolio(): PortfolioIncident[] {
  const out: PortfolioIncident[] = []
  const state = getState()
  if (state.incident) {
    const inc = state.incident
    const unitsByAgency: Record<string, number> = {}
    for (const u of registry.all()) {
      if (['ff', 'officer', 'medic'].includes(u.category)) continue // members ride their rigs
      unitsByAgency[u.agency] = (unitsByAgency[u.agency] ?? 0) + 1
    }
    out.push({
      id: inc.id,
      address: inc.address,
      borough: inc.borough ?? 'New York',
      lat: inc.lat,
      lon: inc.lon,
      type: inc.type,
      severity: ALARM_SEVERITY[inc.alarmLevel ?? '10-75'] ?? 2,
      primaryAgency: PRIMARY_BY_TYPE[inc.type] ?? 'FDNY',
      supportingAgencies: Object.keys(unitsByAgency).filter((a) => a !== (PRIMARY_BY_TYPE[inc.type] ?? 'FDNY')),
      unitsByAgency,
      startedAt: inc.createdAt,
      source: 'board',
      alarmLevel: inc.alarmLevel ?? '10-75',
      openRequests: openRequestCount(inc.id),
      focused: true,
    })
  }
  for (const s of scenario.secondaryIncidents()) {
    out.push({
      id: s.id,
      address: s.address,
      borough: s.borough,
      lat: s.lat,
      lon: s.lon,
      type: s.type,
      severity: s.severity,
      primaryAgency: s.primaryAgency,
      supportingAgencies: s.supportingAgencies ?? [],
      unitsByAgency: s.unitsByAgency ?? {},
      startedAt: s.startedAt,
      source: 'scenario',
      openRequests: openRequestCount(s.id),
      focused: false,
    })
  }
  for (const f of dispatchFeed.all()) {
    out.push({
      id: f.id,
      address: f.address,
      borough: f.borough,
      lat: f.lat,
      lon: f.lon,
      type: f.type,
      severity: f.units >= 6 ? 2 : 1,
      primaryAgency: f.source,
      supportingAgencies: [],
      unitsByAgency: { [f.source]: f.units },
      startedAt: f.startedAt,
      source: 'feed',
      openRequests: openRequestCount(f.id),
      focused: false,
    })
  }
  return out
}

function broadcastPortfolio(): void {
  broadcast({ type: 'portfolio', incidents: portfolio() })
}

// ------------------------------ EOC level ------------------------------------

// --------------------------- Plan activations --------------------------------

// ---------------------------- Trigger rules (M5) ------------------------------

// ------------------------ Interagency requests (M2) ---------------------------

/** Request lifecycle side-effects shared by REST + scenario scripting. */
function afterRequestChange(req2: InteragencyRequest, verb: string, by: string): void {
  appendTimeline('request.' + verb, {
    id: req2.id,
    state: req2.state,
    priority: req2.priority,
    pair: `${req2.requestingAgency}→${req2.assignedAgency}`,
    by,
  })
  ticker(
    'request',
    `Request ${verb.toUpperCase()}: ${req2.description} (${req2.requestingAgency}→${req2.assignedAgency}, ${req2.priority})`,
    { incidentId: req2.incidentId ?? undefined, agency: req2.assignedAgency, severity: req2.priority === 'immediate' ? 4 : req2.priority === 'urgent' ? 3 : 1 },
  )
  broadcast({ type: 'requests', requests: requestsWire() })
  broadcastPortfolio() // open-request counts ride the portfolio cards
}

app.get('/api/requests', (_req, res) => res.json({ requests: requests(), thresholds: REQUEST_THRESHOLDS_MS }))

/** Trim an untrusted string field; null unless it's a real non-empty string. */
function cleanStr(v: unknown, max = 120): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().slice(0, max)
  return s || null
}

app.post('/api/requests', (req, res) => {
  const b = req.body as Partial<InteragencyRequest>
  // Type-checked, not just truthiness: a non-string agency ({} passes `!b.x`)
  // would persist to nycem-state.json and crash every tracker render.
  const requestingAgency = cleanStr(b.requestingAgency, 40)
  const assignedAgency = cleanStr(b.assignedAgency, 40)
  const description = cleanStr(b.description, 300)
  const createdBy = cleanStr(b.createdBy)
  if (!requestingAgency || !assignedAgency || !description || !createdBy) {
    return res.status(400).json({ error: 'requestingAgency, assignedAgency, description, createdBy required (strings)' })
  }
  const priority = (['routine', 'urgent', 'immediate'] as const).includes(b.priority as RequestPriority)
    ? (b.priority as RequestPriority)
    : 'routine'
  const created = openRequest({
    incidentId: cleanStr(b.incidentId),
    requestingAgency,
    assignedAgency,
    description,
    priority,
    createdBy,
  })
  afterRequestChange(created, 'opened', created.createdBy)
  res.status(201).json(created)
})

app.post('/api/requests/:id/transition', (req, res) => {
  const { state, by, reason } = req.body as { state?: RequestState; by?: string; reason?: string }
  if (!state || !by?.trim()) return res.status(400).json({ error: 'state and by required' })
  const result = transitionRequest(req.params.id, state, by.trim(), reason)
  if ('error' in result) return res.status(400).json(result)
  afterRequestChange(result, state, by.trim())
  res.json(result)
})

app.post('/api/requests/:id/update', (req, res) => {
  const { by, text } = req.body as { by?: string; text?: string }
  if (!by?.trim() || !text?.trim()) return res.status(400).json({ error: 'by and text required' })
  const result = appendRequestUpdate(req.params.id, by.trim(), text.trim().slice(0, 500))
  if (!result) return res.status(404).json({ error: 'no such request' })
  broadcast({ type: 'requests', requests: requestsWire() })
  res.json(result)
})

app.get('/api/requests/metrics', (req, res) => {
  const { from, to } = req.query as { from?: string; to?: string }
  res.json({ metrics: requestMetrics(from, to) })
})

// ------------------- Visibility policy (Prompt 12, admin) -------------------

app.get('/api/policy', (_req, res) => res.json({ policy: visibilityPolicy(), schema: POLICY_SCHEMA }))

app.put('/api/policy', (req, res) => {
  const next = setVisibilityPolicy((req.body as { policy?: unknown }).policy)
  if (!next) return res.status(400).json({ error: 'unknown policy field or value', schema: POLICY_SCHEMA })
  appendTimeline('policy.changed', { policy: next })
  ticker('plan', `Visibility policy updated — ${Object.entries(next).map(([k, v]) => `${k}=${v}`).join(', ')}`)
  // Hot reload: every connected dashboard re-renders against the new policy
  // immediately — the "tighten it live in a meeting" path.
  broadcast({ type: 'policy', policy: next })
  res.json({ policy: next })
})

const simComms = new SimComms()
simComms.on('line', (channel: CommsChannel, line: TranscriptLine) => {
  broadcast({ type: 'transcript', channel, line })
})
simComms.start()

// ---------------------------------------------------------------------------
// Incident API
// ---------------------------------------------------------------------------
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'keystone-server' }))

app.get('/api/incident', (req, res) => {
  const state = getState()
  // Default response mirrors the ws snapshot trim: the unit.track flood can
  // reach the 12k cap (~2.4 MB) on a long incident — dashboards reloading
  // only need the incident + milestones. Replay passes ?full=1 for tracks.
  if (req.query.full === '1') return res.json(state)
  res.json({
    ...state,
    timeline: state.timeline.filter((e) => e.kind !== 'unit.track').slice(-400),
  })
})

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
  ticker('new-incident', `${incident.type} — ${incident.address}`, {
    incidentId: incident.id,
    agency: PRIMARY_BY_TYPE[incident.type] ?? 'FDNY',
    borough: incident.borough,
    severity: 2,
  })
  broadcastPortfolio()
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
  const prevIncident = getState().incident
  const state = clearIncident()
  broadcast({ type: 'incident', incident: null })
  broadcast({ type: 'exposure', labels: [] })
  broadcast({ type: 'alert', alert: { kind: 'clear' } })
  if (prevIncident) {
    ticker('incident-closed', `Incident closed — ${prevIncident.address}`, { incidentId: prevIncident.id })
  }
  broadcastPortfolio()
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
  const prev = state.incident
  const updated = updateIncident(patch)
  broadcast({ type: 'incident', incident: updated.incident })
  // Live RELOCATION with the sim running: the assignment was routed to the
  // OLD coordinates and would keep converging there forever. Re-dispatch at
  // the corrected site (dispatch() stops the old run via its generation
  // token, same as POST /api/dispatch).
  if (
    patch.lat !== undefined &&
    (patch.lat !== prev.lat || patch.lon !== prev.lon) &&
    simulator.active &&
    updated.incident
  ) {
    simChatter.reset()
    void simulator
      .dispatch(updated.incident.lat, updated.incident.lon)
      .catch((err) => console.error('[sim] re-dispatch after relocation failed:', err))
  }
  res.json(updated)
})

// ---------------------------------------------------------------------------
// OPS CLOCK (server-authoritative elapsed-time + PAR discipline): duration
// marks + PAR-due nags derive from the persisted timeline every tick, so
// restarts never double-emit and END clears everything with the incident.
// ---------------------------------------------------------------------------
const opsClock = new OpsClock({
  getIncident: () => getState().incident,
  getTimeline: () => getState().timeline,
  emit: (kind, payload) => {
    const ev = appendTimeline(kind, payload)
    broadcast({ type: 'timeline', event: ev })
  },
})
opsClock.start()

app.get('/api/ops/par-interval', (_req, res) => {
  // Anchors derive from the FULL server timeline — the client's window is
  // truncated (~600 events) and a long box can push the last mark/PAR out
  // of it, which would false-alarm the strip chips.
  const inc = getState().incident
  let lastMark = 0
  let lastParAt = inc ? Date.parse(inc.createdAt) : 0
  for (const ev of getState().timeline) {
    if (ev.kind === 'ops.duration-mark') {
      const m = Number((ev.payload as { minutes?: number } | undefined)?.minutes)
      if (Number.isFinite(m) && m > lastMark) lastMark = m
    } else if (ev.kind === 'ic.par-complete') {
      const t = Date.parse(ev.t)
      if (Number.isFinite(t) && t > lastParAt) lastParAt = t
    }
  }
  res.json({ minutes: opsClock.getParIntervalMin(), lastMark, lastParAt })
})

app.post('/api/ops/par-interval', (req, res) => {
  const { minutes } = req.body as { minutes?: number }
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) {
    return res.status(400).json({ error: 'minutes required' })
  }
  res.json({ minutes: opsClock.setParIntervalMin(minutes) })
})

app.post('/api/timeline', (req, res) => {
  const { kind, payload } = req.body as { kind?: string; payload?: unknown }
  if (!kind) return res.status(400).json({ error: 'kind required' })
  if (kind.startsWith('ops.')) return res.status(403).json({ error: 'ops.* kinds are emitted by the server clock only' })
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
    // Citywide ticker mirrors the major cross-incident moments.
    if (kind === 'alert.mayday') {
      ticker('mayday', `MAYDAY — ${String((payload as { callsign?: string }).callsign ?? 'unknown unit')}`, {
        incidentId: getState().incident?.id,
        severity: 5,
        sim: true, // only the drill engine routes through this dep
      })
    } else if (String(payload?.event ?? kind).toLowerCase().includes('mci')) {
      ticker('mci', `MCI declared — ${getState().incident?.address ?? ''}`, {
        incidentId: getState().incident?.id,
        severity: 4,
        sim: true,
      })
    }
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
  setAlarm: (level, replay) => {
    const updated = updateIncident({ alarmLevel: level })
    broadcast({ type: 'incident', incident: updated.incident })
    // Rewind replays restore the board's alarm level but must not re-announce
    // it — each scrub would otherwise add another "Alarm level 2ND" ticker row.
    if (!replay) {
      // Drill alarms belong on the ICS-214 too: without this row a drill's
      // DECISION LOG carries zero alarm benchmarks, and the disabled-when-
      // reached ladder means the IC can never backfill them.
      const benchEv = appendTimeline('ic.benchmark', { code: ALARM_CODE[level ?? ''] ?? String(level).toUpperCase() })
      broadcast({ type: 'timeline', event: benchEv })
      ticker('alarm', `Alarm level ${ALARM_CODE[level ?? ''] ?? String(level).toUpperCase()} (drill) — ${updated.incident?.address ?? ''}`, {
        incidentId: updated.incident?.id,
        severity: ALARM_SEVERITY[level ?? '10-75'] ?? 2,
        sim: true,
      })
    }
    broadcastPortfolio()
  },
  // Prompt 11 hooks — the coordination layer rides the scenario:
  portfolioChanged: () => broadcastPortfolio(),
  openRequest: (r, incidentId) => {
    const resolved = incidentId === '__PRIMARY__' ? (getState().incident?.id ?? null) : incidentId
    const created = openRequest({
      incidentId: resolved,
      requestingAgency: r.requestingAgency,
      assignedAgency: r.assignedAgency,
      description: r.description,
      priority: r.priority,
      createdBy: r.createdBy,
    })
    afterRequestChange(created, 'opened', r.createdBy)
    return created.id
  },
  transitionRequest: (id, state, by, reason) => {
    const result = transitionRequest(id, state as RequestState, by, reason)
    if (!('error' in result)) afterRequestChange(result, state, by)
  },
  setFeedMock: (feedId, payload) => {
    setFeedMock(feedId, payload)
  },
  clearFeedMocks: () => clearAllFeedMocks(),
})

// Safe now: the feed's synchronous first update reads scenario via portfolio().
dispatchFeed.start()

app.get('/api/scenario', (_req, res) => res.json(scenario.status()))

app.post('/api/scenario/load', async (req, res) => {
  const { name, exercise } = req.body as { name?: string; exercise?: boolean }
  if (!name) return res.status(400).json({ error: 'name required' })
  try {
    await scenario.load(name)
    // AFTER the load succeeds: a previous run's SIMULATED products would
    // block this run's scripted trigger from re-firing — but a failed load
    // (typo'd name) keeps the OLD scenario running, and clearing first
    // would strip its live products and pending banner from every station.
    // Exercise mode (M8): live human interactions record alongside the
    // script; /api/exercises/finish builds the HSEEP AAR from the window.
    scenario.setExercise(!!exercise)
    if (exercise) {
      appendTimeline('exercise.started', { scenario: name })
      ticker('plan', `EXERCISE started — ${name} (participants live, script driving)`)
    }
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
  console.log(
    `[keystone-server] listening on :${PORT} (http + ws /ws) — sim uid namespaces ${SIM_UID_PREFIX}* ${DRILL_UID_PREFIX}*`,
  )
})
