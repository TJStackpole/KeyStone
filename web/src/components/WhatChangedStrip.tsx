import { useEffect, useState } from 'react'
import { useMovable } from '../lib/movable'
import { useAppSlice } from '../state/store'
import { fmtAge } from './FeedHealthPanel'

// ---------------------------------------------------------------------------
// WHAT CHANGED — the single attention queue. The platform has many voices
// (timeline, weather, alerts, interagency requests); under stress an
// operator needs ONE place answering "what are the last few things that
// mattered?", newest first, each with its age. Display-only rows — the
// sources' own panels stay the interaction surface.
// ---------------------------------------------------------------------------

interface ChangeRow {
  id: string
  at: number
  tone: 'red' | 'amber' | 'cyan'
  text: string
}

const MAX_ROWS = 5
/** Timeline kinds that are position chatter, not command-relevant change. */
const NOISE_KINDS = new Set(['unit.track', 'unit.update'])

function prettyKind(kind: string): string {
  return kind.replace(/[._]/g, ' ').toUpperCase()
}

function timelineText(kind: string, payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>
  const detail =
    (typeof p.text === 'string' && p.text) ||
    (typeof p.label === 'string' && p.label) ||
    (typeof p.address === 'string' && p.address) ||
    (typeof p.callsign === 'string' && p.callsign) ||
    (typeof p.level === 'string' && `${p.level} ALARM`) ||
    ''
  return detail ? `${prettyKind(kind)} — ${String(detail).slice(0, 60)}` : prettyKind(kind)
}

export function WhatChangedStrip() {
  const mvChanged = useMovable('what-changed')
  const { timeline, weatherAlerts, alert, requests, thresholds, incident, watchCommand, practiceTour } = useAppSlice(
    (s) => ({
      timeline: s.timeline,
      weatherAlerts: s.weatherAlerts,
      alert: s.alert,
      requests: s.interagencyRequests,
      thresholds: s.requestThresholds,
      incident: s.incident,
      watchCommand: s.watchCommand,
      practiceTour: s.practiceTour,
    }),
  )
  // Ages keep counting between store updates.
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 5000)
    return () => clearInterval(t)
  }, [])

  // Watch Command has the CITYWIDE EVENT TICKER — a second queue on the
  // same screen is clutter, and the strip collides with the WC panels.
  // During PRACTICE the tour owns the attention slot for the same reason.
  if (watchCommand || practiceTour) return null

  const now = Date.now()
  const rows: ChangeRow[] = []

  // Live emergency alert always leads.
  if (alert && alert.kind !== 'clear') {
    rows.push({
      id: 'alert',
      at: now,
      tone: 'red',
      text: `${prettyKind(alert.kind)}${alert.callsign ? ` — ${alert.callsign}` : ''}${alert.text ? ` · ${alert.text.slice(0, 50)}` : ''}`,
    })
  }
  for (const r of requests) {
    if (r.state !== 'opened') continue
    const overdueMs = now - Date.parse(r.createdAt) - (thresholds[r.priority] ?? 300_000)
    if (overdueMs > 0) {
      rows.push({
        id: `req:${r.id}`,
        at: Date.parse(r.createdAt),
        tone: 'red',
        text: `REQUEST OVERDUE — ${r.assignedAgency}: ${r.description.slice(0, 44)}`,
      })
    }
  }
  for (const a of weatherAlerts.slice(0, 3)) {
    rows.push({
      id: `wx:${a.id}`,
      at: a.onset ? Date.parse(a.onset) : now,
      tone: 'amber',
      text: `${a.event.toUpperCase()} — ${a.headline.slice(0, 56)}`,
    })
  }
  // Newest event PER KIND — a chatty stream (crew rotations, biometrics)
  // must never fill the whole queue and drown a dispatch or an alarm.
  const seenKinds = new Set<string>()
  for (let i = timeline.length - 1; i >= 0 && rows.length < MAX_ROWS + 8; i--) {
    const ev = timeline[i]
    if (NOISE_KINDS.has(ev.kind) || seenKinds.has(ev.kind)) continue
    seenKinds.add(ev.kind)
    rows.push({ id: `tl:${i}:${ev.kind}`, at: Date.parse(ev.t), tone: 'cyan', text: timelineText(ev.kind, ev.payload) })
  }

  const top = rows
    .filter((r) => Number.isFinite(r.at))
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ROWS)

  // No incident and nothing notable: stay out of the way entirely.
  if (!top.length || (!incident && top.every((r) => r.tone === 'cyan'))) return null

  return (
    <aside {...mvChanged} className="changed-strip glass" aria-label="What changed — latest notable events">
      <div className="changed-head">WHAT CHANGED</div>
      {top.map((r) => (
        <div key={r.id} className={`changed-row ${r.tone}`}>
          <span className="changed-age">{fmtAge(now - r.at)}</span>
          <span className="changed-text" title={r.text}>
            {r.text}
          </span>
        </div>
      ))}
    </aside>
  )
}
