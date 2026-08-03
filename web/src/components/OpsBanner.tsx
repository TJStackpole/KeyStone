import { useEffect, useState } from 'react'
import { useAppSlice } from '../state/store'

// ---------------------------------------------------------------------------
// OPS CLOCK banners: a brief full-width ribbon when a duration mark lands
// ("20 MINUTES ON THE BOX") or the PAR cycle lapses. Deliberately the
// mayday's shape at LOWER severity — amber, no red frame; red is reserved
// for life safety.
// ---------------------------------------------------------------------------

const SHOW_MS = 7000

export function OpsBanner() {
  const { timeline } = useAppSlice((s) => ({ timeline: s.timeline }))
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  let latest: { kind: string; at: number; payload: Record<string, unknown> } | null = null
  for (let i = timeline.length - 1; i >= 0; i--) {
    const ev = timeline[i]
    if (ev.kind === 'ops.duration-mark' || ev.kind === 'ops.par-due') {
      latest = { kind: ev.kind, at: Date.parse(ev.t), payload: (ev.payload ?? {}) as Record<string, unknown> }
      break
    }
  }
  if (!latest || Date.now() - latest.at > SHOW_MS) return null

  const text =
    latest.kind === 'ops.duration-mark'
      ? `${String(latest.payload.minutes)} MINUTES ON THE BOX`
      : `PAR OVERDUE — ${String(latest.payload.sinceMin)} MIN SINCE LAST PAR (cycle ${String(latest.payload.intervalMin)} min)`

  return (
    <div className={`ops-banner${latest.kind === 'ops.par-due' ? ' due' : ''}`} role="status">
      {text}
    </div>
  )
}
