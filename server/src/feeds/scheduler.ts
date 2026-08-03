import { env } from '../env.js'
import type { FeedContext, FeedFetchOpts } from './types.js'

// ---------------------------------------------------------------------------
// Central request scheduler: EVERY outbound feed request flows through here.
// Provides the three disciplines the prompt demands platform-wide:
//   - per-feed rate budgets (e.g. 511NY's hard 10 calls / 60 s)
//   - response caching (identical URLs within TTL cost zero calls)
//   - uniform timeouts so a hung upstream can't wedge a polling loop
// Exponential backoff lives in the registry (it owns the polling cadence).
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 15_000
const CACHE_MAX_ENTRIES = 200

interface CacheEntry {
  at: number
  body: Buffer
}

const cache = new Map<string, CacheEntry>()

/** Sliding-window call log per budget key. */
const budgetLog = new Map<string, number[]>()
const budgetLimits = new Map<string, { calls: number; perMs: number }>()

export class BudgetExhausted extends Error {
  constructor(key: string) {
    super(`rate budget exhausted for '${key}'`)
    this.name = 'BudgetExhausted'
  }
}

export function declareBudget(key: string, calls: number, perMs: number): void {
  budgetLimits.set(key, { calls, perMs })
}

/** True when a call may proceed; records the call. Throws when over budget. */
function drawFromBudget(key: string | undefined): void {
  if (!key) return
  const limit = budgetLimits.get(key)
  if (!limit) return
  const now = Date.now()
  const log = (budgetLog.get(key) ?? []).filter((t) => now - t < limit.perMs)
  if (log.length >= limit.calls) {
    budgetLog.set(key, log)
    throw new BudgetExhausted(key)
  }
  log.push(now)
  budgetLog.set(key, log)
}

function cacheGet(url: string, ttlMs: number): Buffer | null {
  if (ttlMs <= 0) return null
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < ttlMs) return hit.body
  return null
}

function cachePut(url: string, body: Buffer): void {
  cache.set(url, { at: Date.now(), body })
  if (cache.size > CACHE_MAX_ENTRIES) {
    // Oldest-first eviction (Map preserves insertion order; re-set on write).
    const first = cache.keys().next().value
    if (first !== undefined) cache.delete(first)
  }
}

async function fetchRaw(url: string, opts: FeedFetchOpts): Promise<Buffer> {
  const cached = cacheGet(url, opts.ttlMs ?? 0)
  if (cached) return cached
  drawFromBudget(opts.budgetKey)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers: opts.headers, signal: ctl.signal })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const body = Buffer.from(await res.arrayBuffer())
    cachePut(url, body)
    return body
  } finally {
    clearTimeout(timer)
  }
}

/** The FeedContext handed to every adapter. */
export const feedContext: FeedContext = {
  async fetchJson(url, opts = {}) {
    return JSON.parse((await fetchRaw(url, opts)).toString('utf8')) as unknown
  },
  async fetchBuffer(url, opts = {}) {
    return fetchRaw(url, opts)
  },
  async fetchText(url, opts = {}) {
    return (await fetchRaw(url, opts)).toString('utf8')
  },
  env(key, fallback = '') {
    return env(key, fallback)
  },
}

/** Test seam: wipe scheduler state between cases. */
export function resetSchedulerForTest(): void {
  cache.clear()
  budgetLog.clear()
  budgetLimits.clear()
}
