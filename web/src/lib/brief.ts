import { alarmLabel } from './alarms'
import { escapeHtml as esc, openPrintable } from './printDoc'
import { getAppState } from '../state/store'
import type { FeedDataWire } from '../types'

// ---------------------------------------------------------------------------
// PUSH-TO-BRIEF: one press turns the current picture into a clean, plain-
// language one-pager in a new tab — for the phone call to City Hall, the
// shift-change handoff, or printing at the door. Everything is written for
// a reader who has never seen KeyStone; simulated sources say so. Pop-up
// blocked? printDoc falls back to the system print dialog directly.
// ---------------------------------------------------------------------------

function line(label: string, value: string): string {
  return `<tr><td class="l">${esc(label)}</td><td>${esc(value)}</td></tr>`
}

export function openBrief(): boolean {
  const s = getAppState()
  const now = new Date()
  const rows: string[] = []

  if (s.incident) {
    rows.push(line('Incident', `${s.incident.type ?? 'Incident'} — ${s.incident.address}`))
    if (s.incident.alarmLevel) rows.push(line('Alarm level', alarmLabel(s.incident.alarmLevel)))
  } else {
    rows.push(line('Incident', 'No active tactical incident'))
  }

  const units = Object.values(s.units)
  if (units.length) {
    const byAgency = new Map<string, { on: number; total: number }>()
    for (const u of units) {
      const rec = byAgency.get(u.agency) ?? { on: 0, total: 0 }
      rec.total++
      if (u.status && u.status !== 'Enroute') rec.on++
      byAgency.set(u.agency, rec)
    }
    rows.push(
      line(
        'Units',
        [...byAgency.entries()].map(([a, r]) => `${a.toUpperCase()}: ${r.on} on scene of ${r.total}`).join(' · '),
      ),
    )
  }

  const water = s.feedData['noaa-water'] as FeedDataWire | undefined
  if (water) {
    const stations = (water.payload as { stations?: { name: string; waterLevelFt: number; trend: string }[] })
      ?.stations
    if (stations?.length) {
      rows.push(
        line(
          `Harbor water (${water.attribution}, ${Math.round((Date.now() - water.at) / 60000)} min ago)`,
          stations.map((st) => `${st.name}: ${st.waterLevelFt.toFixed(1)} ft ${st.trend}`).join(' · '),
        ),
      )
    }
  }

  const openReqs = s.interagencyRequests.filter((r) => r.state !== 'complete' && r.state !== 'declined')
  for (const r of openReqs.slice(0, 6)) {
    rows.push(line(`Request → ${r.assignedAgency} (${r.state})`, r.description))
  }

  openPrintable({
    title: `KeyStone Brief — ${now.toLocaleString()}`,
    heading: `SITUATION BRIEF — KeyStone ${s.profile === 'nycem' ? 'NYCEM' : 'FDNY'}`,
    sub: `Generated ${now.toLocaleString()} · read top to bottom, everything current as of generation`,
    bodyHtml: `<table>${rows.join('')}</table>`,
    drill: !!s.scenario?.loaded,
  })
  // Either path produced the brief (window or direct print dialog) — callers
  // that check the return only care whether the CONTENT reached the operator.
  return true
}
