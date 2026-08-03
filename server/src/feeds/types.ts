// ---------------------------------------------------------------------------
// Prompt 13 — feed ingestion layer. ONE adapter contract for every external
// source. Rules the whole layer enforces (not each adapter):
//   - a feed failing degrades THAT layer only, never the platform
//   - stale data always carries its age; nothing renders as current
//   - API keys live server-side; a missing key parks the adapter as
//     'unconfigured' (keyless-by-default: the platform runs without any)
//   - every derived UI element gets the adapter's attribution + timestamp
// ---------------------------------------------------------------------------

export type FeedProfiles = 'both' | ('fdny' | 'nycem')[]

export type FeedStatus = 'ok' | 'stale' | 'down' | 'unconfigured' | 'mock'

export interface FeedHealth {
  id: string
  name: string
  status: FeedStatus
  /** ms since epoch of last successful poll; null = never succeeded */
  lastSuccess: number | null
  /** Age of the data being served right now, ms (null = no data). */
  ageMs: number | null
  latencyMs: number | null
  lastError: string | null
  consecutiveFails: number
  refreshIntervalMs: number
  attribution: string
  profiles: FeedProfiles
  capabilityId: string
  /** Undocumented/unofficial endpoint — health panel shows a warning. */
  unofficial: boolean
  /** Which env keys are missing (why status === 'unconfigured'). */
  missingEnv: string[]
  signupUrl: string | null
}

export interface FeedFetchOpts {
  /** Serve from cache when younger than this (default 0 = always fetch). */
  ttlMs?: number
  headers?: Record<string, string>
  /** Rate-budget bucket this call draws from (adapter.budget.key). */
  budgetKey?: string
  timeoutMs?: number
}

/** What an adapter gets to talk to the outside world — ALL requests go
 *  through the central scheduler so budgets/caching/backoff are uniform. */
export interface FeedContext {
  fetchJson(url: string, opts?: FeedFetchOpts): Promise<unknown>
  fetchBuffer(url: string, opts?: FeedFetchOpts): Promise<Buffer>
  fetchText(url: string, opts?: FeedFetchOpts): Promise<string>
  env(key: string, fallback?: string): string
}

export interface FeedAdapter<T = unknown> {
  /** Capability manifest id, e.g. 'feeds.mta-subway'. */
  capabilityId: string
  /** Registry/health id (short slug). */
  id: string
  name: string
  profiles: FeedProfiles
  /** Rendered on every UI element derived from this feed. */
  attribution: string
  refreshIntervalMs: number
  /** Undocumented endpoint — expect breakage, warn in the health panel. */
  unofficial?: boolean
  /** Env keys that must be set before this adapter polls. */
  requiredEnv?: string[]
  signupUrl?: string
  /** Rate budget shared by every request this adapter makes. */
  budget?: { key: string; calls: number; perMs: number }
  /** false → payload served over HTTP only, not pushed on the ws (big lists). */
  push?: boolean
  /** Fetch one round and normalize to KeyStone's schema. Throw on failure. */
  poll(ctx: FeedContext): Promise<T>
}

export interface FeedData<T = unknown> {
  id: string
  at: number
  payload: T
  mock: boolean
  attribution: string
}
