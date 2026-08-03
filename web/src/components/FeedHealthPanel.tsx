import { useEffect, useState } from 'react'
import { useMovable } from '../lib/movable'
import { hasCapability, useProfile } from '../profiles/manifest'
import { setAppState, useAppSlice } from '../state/store'
import type { FeedHealthWire, FeedStatus } from '../types'

// ---------------------------------------------------------------------------
// Prompt 13 — feed health board. One row per registered feed: status light,
// data age (ALWAYS shown — stale data never reads as current), latency,
// attribution. Unofficial endpoints carry a standing warning; unconfigured
// feeds show which key is missing and where to sign up; mocked feeds are
// labeled SIMULATED. Profile-filtered by each feed's capability id.
// ---------------------------------------------------------------------------

const STATUS_ORDER: Record<FeedStatus, number> = { down: 0, stale: 1, unconfigured: 2, mock: 3, ok: 4 }
const STATUS_LABEL: Record<FeedStatus, string> = {
  ok: 'LIVE',
  stale: 'STALE',
  down: 'DOWN',
  unconfigured: 'NO KEY',
  mock: 'SIMULATED',
}

export function fmtAge(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return 'now'
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`
}

export function FeedHealthPanel() {
  const mvFeeds = useMovable('feed-health')
  const profile = useProfile()
  const { feedHealth, open } = useAppSlice((s) => ({ feedHealth: s.feedHealth, open: s.feedPanelOpen }))
  // Ages advance every second even when no ws traffic arrives — an age that
  // stops counting is exactly the lie this panel exists to prevent.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [open])

  if (!open) return null
  const feeds = Object.values(feedHealth)
    .filter((f) => hasCapability(profile, f.capabilityId))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name))
  const unofficial = feeds.filter((f) => f.unofficial)

  return (
    <aside {...mvFeeds} className="feed-panel glass">
      <div className="feed-panel-head">
        <b>LIVE FEEDS</b>
        <span className="feed-count">{feeds.filter((f) => f.status === 'ok').length}/{feeds.length} LIVE</span>
        <button className="no-drag feed-close" onClick={() => setAppState({ feedPanelOpen: false })} title="Close">
          ✕
        </button>
      </div>
      {unofficial.length > 0 && (
        <div className="feed-warn" title="These endpoints are undocumented — isolated behind their adapters; expect breakage">
          ⚠ UNOFFICIAL ENDPOINT{unofficial.length > 1 ? 'S' : ''}: {unofficial.map((f) => f.name).join(', ')}
        </div>
      )}
      <div className="feed-rows">
        {feeds.length === 0 && <div className="feed-empty">No feeds registered for this workspace.</div>}
        {feeds.map((f) => (
          <FeedRow key={f.id} f={f} />
        ))}
      </div>
    </aside>
  )
}

function FeedRow({ f }: { f: FeedHealthWire }) {
  // ageMs was computed server-side at send time — advance it locally so the
  // label keeps counting between pushes.
  const sentAgo = f.lastSuccess !== null ? Date.now() - f.lastSuccess : null
  const age = f.status === 'mock' ? f.ageMs : (sentAgo ?? f.ageMs)
  return (
    <div className={`feed-row ${f.status}`}>
      <span className={`feed-dot ${f.status}`} />
      <span className="feed-name" title={`${f.attribution} · refresh every ${Math.round(f.refreshIntervalMs / 1000)}s`}>
        {f.name}
      </span>
      <span className="feed-status">{STATUS_LABEL[f.status]}</span>
      <span className="feed-age" title="Age of the data currently on screen from this feed">
        {fmtAge(age)}
      </span>
      {f.status === 'ok' && f.latencyMs !== null && <span className="feed-lat">{f.latencyMs}ms</span>}
      {f.status === 'down' && f.lastError && (
        <div className="feed-detail" title={f.lastError}>
          {f.lastError.slice(0, 60)} · retrying with backoff
        </div>
      )}
      {f.status === 'unconfigured' && (
        <div className="feed-detail">
          needs {f.missingEnv.join(', ')} in .env
          {f.signupUrl && (
            <>
              {' · '}
              <a className="no-drag" href={f.signupUrl} target="_blank" rel="noreferrer">
                get a free key
              </a>
            </>
          )}
        </div>
      )}
    </div>
  )
}
