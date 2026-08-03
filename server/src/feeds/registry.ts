import { env } from '../env.js'
import { BudgetExhausted, declareBudget, feedContext } from './scheduler.js'
import type { FeedAdapter, FeedData, FeedHealth, FeedStatus } from './types.js'

// ---------------------------------------------------------------------------
// Feed registry: owns every adapter's polling loop, health record, latest
// payload, and mock override. Degradation is strictly per-feed — an adapter
// that throws only marks ITS health down and backs off exponentially; the
// rest of the platform never notices.
//
// Mock mode (scenario engine): setFeedMock(id, payload) suspends the live
// loop and serves/broadcasts the injected payload flagged mock:true — demos
// run with zero live keys and the SIMULATED labeling stays honest.
// ---------------------------------------------------------------------------

const MAX_BACKOFF_MS = 15 * 60_000
/** Data older than 3 refresh intervals reads as 'stale' in health. */
const STALE_FACTOR = 3

interface Entry {
  adapter: FeedAdapter
  data: FeedData | null
  mock: FeedData | null
  lastSuccess: number | null
  lastError: string | null
  latencyMs: number | null
  consecutiveFails: number
  timer: NodeJS.Timeout | null
  lastBroadcastStatus: FeedStatus | null
  polling: boolean
}

const entries = new Map<string, Entry>()

type Broadcast = (msg: unknown) => void
let broadcastFn: Broadcast = () => {}

export function registerFeed(adapter: FeedAdapter): void {
  if (entries.has(adapter.id)) throw new Error(`duplicate feed id '${adapter.id}'`)
  if (adapter.budget) declareBudget(adapter.budget.key, adapter.budget.calls, adapter.budget.perMs)
  entries.set(adapter.id, {
    adapter,
    data: null,
    mock: null,
    lastSuccess: null,
    lastError: null,
    latencyMs: null,
    consecutiveFails: 0,
    timer: null,
    lastBroadcastStatus: null,
    polling: false,
  })
}

function missingEnv(adapter: FeedAdapter): string[] {
  return (adapter.requiredEnv ?? []).filter((k) => env(k, '') === '')
}

function statusOf(e: Entry): FeedStatus {
  if (e.mock) return 'mock'
  if (missingEnv(e.adapter).length) return 'unconfigured'
  if (e.lastSuccess === null) return e.consecutiveFails > 0 ? 'down' : 'stale'
  const age = Date.now() - e.lastSuccess
  if (e.consecutiveFails >= 2) return 'down'
  if (age > e.adapter.refreshIntervalMs * STALE_FACTOR) return 'stale'
  return 'ok'
}

export function feedHealth(id: string): FeedHealth | null {
  const e = entries.get(id)
  if (!e) return null
  const a = e.adapter
  const served = e.mock ?? e.data
  return {
    id: a.id,
    name: a.name,
    status: statusOf(e),
    lastSuccess: e.lastSuccess,
    ageMs: served ? Date.now() - served.at : null,
    latencyMs: e.latencyMs,
    lastError: e.lastError,
    consecutiveFails: e.consecutiveFails,
    refreshIntervalMs: a.refreshIntervalMs,
    attribution: a.attribution,
    profiles: a.profiles,
    capabilityId: a.capabilityId,
    unofficial: !!a.unofficial,
    missingEnv: missingEnv(a),
    signupUrl: a.signupUrl ?? null,
  }
}

export function allFeedHealth(): FeedHealth[] {
  return [...entries.keys()].map((id) => feedHealth(id)!)
}

/** Latest payload being served for a feed (mock wins over live). */
export function feedData(id: string): FeedData | null {
  const e = entries.get(id)
  return e ? (e.mock ?? e.data) : null
}

function announce(e: Entry): void {
  const status = statusOf(e)
  if (status !== e.lastBroadcastStatus) {
    e.lastBroadcastStatus = status
    broadcastFn({ type: 'feed.health', health: feedHealth(e.adapter.id) })
  }
}

function pushData(e: Entry): void {
  const served = e.mock ?? e.data
  if (!served) return
  if (e.adapter.push === false && !e.mock) return // big lists: HTTP pull only
  broadcastFn({ type: 'feed.data', data: served })
}

async function pollOnce(e: Entry): Promise<void> {
  if (e.mock || e.polling) return
  if (missingEnv(e.adapter).length) {
    announce(e)
    return
  }
  e.polling = true
  const t0 = Date.now()
  try {
    const payload = await e.adapter.poll(feedContext)
    e.latencyMs = Date.now() - t0
    e.lastSuccess = Date.now()
    e.lastError = null
    e.consecutiveFails = 0
    e.data = {
      id: e.adapter.id,
      at: e.lastSuccess,
      payload,
      mock: false,
      attribution: e.adapter.attribution,
    }
    pushData(e)
  } catch (err) {
    e.consecutiveFails++
    e.lastError = err instanceof Error ? err.message : String(err)
    if (!(err instanceof BudgetExhausted)) {
      console.error(`[feeds] ${e.adapter.id} poll failed (${e.consecutiveFails}x):`, e.lastError)
    }
  } finally {
    e.polling = false
    announce(e)
    scheduleNext(e)
  }
}

function scheduleNext(e: Entry): void {
  if (e.timer) clearTimeout(e.timer)
  // Exponential backoff on failure; budget exhaustion just waits one refresh.
  const base = e.adapter.refreshIntervalMs
  const delay = e.consecutiveFails > 0 ? Math.min(base * 2 ** e.consecutiveFails, MAX_BACKOFF_MS) : base
  e.timer = setTimeout(() => void pollOnce(e), delay)
  e.timer.unref?.()
}

/** Start every registered adapter's loop. First polls are staggered so boot
 *  doesn't burst-fire a dozen upstream requests in one tick. */
export function startFeeds(broadcast: Broadcast): void {
  broadcastFn = broadcast
  let stagger = 0
  for (const e of entries.values()) {
    const t = setTimeout(() => void pollOnce(e), stagger)
    t.unref?.()
    e.timer = t
    stagger += 400
  }
}

/**
 * Scenario-engine seam: inject (or clear, with null) a mock payload. While a
 * mock is set the live loop is suspended and the served/broadcast data is
 * flagged mock:true.
 */
export function setFeedMock(id: string, payload: unknown | null): boolean {
  const e = entries.get(id)
  if (!e) return false
  e.mock =
    payload === null
      ? null
      : { id, at: Date.now(), payload, mock: true, attribution: `${e.adapter.attribution} (SIMULATED)` }
  if (e.mock) {
    pushData(e)
  } else {
    // Back to live: poll soon so the layer refills with real data.
    if (e.timer) clearTimeout(e.timer)
    const t = setTimeout(() => void pollOnce(e), 250)
    t.unref?.()
    e.timer = t
    if (e.data) pushData(e)
  }
  announce(e)
  return true
}

/** All mocks off (scenario teardown). */
export function clearAllFeedMocks(): void {
  for (const id of entries.keys()) setFeedMock(id, null)
}

/** Snapshot slice for connecting dashboards: latest data of every
 *  push-enabled feed. Pull-only feeds (big lists like the camera inventory)
 *  stay off the ws — clients fetch them over REST on demand. */
export function pushableFeedData(): FeedData[] {
  const out: FeedData[] = []
  for (const e of entries.values()) {
    const served = e.mock ?? e.data
    if (served && (e.adapter.push !== false || e.mock)) out.push(served)
  }
  return out
}

/** Test seam. */
export function resetFeedsForTest(): void {
  for (const e of entries.values()) if (e.timer) clearTimeout(e.timer)
  entries.clear()
  broadcastFn = () => {}
}
