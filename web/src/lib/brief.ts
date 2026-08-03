import { notify } from '../components/NoticeChip'
import { getAppState } from '../state/store'
import type { FeedDataWire } from '../types'

// ---------------------------------------------------------------------------
// PUSH-TO-BRIEF: one press turns the current picture into a clean, plain-
// language one-pager in a new tab — for the phone call to City Hall, the
// shift-change handoff, or printing at the door. Everything is written for
// a reader who has never seen KeyStone; simulated sources say so.
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function line(label: string, value: string): string {
  return `<tr><td class="l">${esc(label)}</td><td>${esc(value)}</td></tr>`
}

export function openBrief(): boolean {
  const s = getAppState()
  const now = new Date()
  const rows: string[] = []

  if (s.incident) {
    rows.push(line('Incident', `${s.incident.type ?? 'Incident'} — ${s.incident.address}`))
    if (s.incident.alarmLevel) rows.push(line('Alarm level', String(s.incident.alarmLevel)))
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

  for (const a of s.weatherAlerts.slice(0, 4)) {
    rows.push(line(`Weather — ${a.event}`, a.headline))
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

  const drill = s.scenario?.loaded
  const w = window.open('', '_blank', 'width=760,height=900')
  if (!w) {
    notify('POP-UP BLOCKED — allow pop-ups for this site to open the brief', 'red')
    return false
  }
  w.document.write(`<!doctype html><html><head><title>KeyStone Brief — ${esc(now.toLocaleString())}</title>
<style>
  body { font: 14px/1.5 Georgia, 'Times New Roman', serif; color: #111; margin: 40px; }
  h1 { font-size: 19px; letter-spacing: 0.02em; margin: 0 0 2px; }
  .sub { color: #555; font-size: 12px; margin-bottom: 18px; }
  .drill { border: 2px solid #b45309; color: #b45309; font-weight: 700; padding: 6px 10px; margin-bottom: 14px; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 7px 10px; border-bottom: 1px solid #ddd; vertical-align: top; }
  td.l { width: 200px; font-weight: 700; }
  .print { margin-top: 22px; padding: 9px 18px; font-size: 14px; cursor: pointer; }
  @media print { .print { display: none; } }
</style></head><body>
<h1>SITUATION BRIEF — KeyStone ${s.profile === 'nycem' ? 'NYCEM' : 'FDNY'}</h1>
<div class="sub">Generated ${esc(now.toLocaleString())} · read top to bottom, everything current as of generation</div>
${drill ? '<div class="drill">DRILL — EVERYTHING IN THIS BRIEF IS SIMULATED EXERCISE PLAY</div>' : ''}
<table>${rows.join('')}</table>
<button class="print" onclick="window.print()">Print / save as PDF</button>
</body></html>`)
  w.document.close()
  return true
}
