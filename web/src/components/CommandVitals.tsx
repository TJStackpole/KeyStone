import { useEffect, useState } from 'react'
import { alarmLabel } from '../lib/alarms'
import { isApparatus, isAtBox, isEnroute } from '../lib/crews'
import { fmtElapsed, fmtWallClock } from '../lib/time'
import { lastBenchmark, maydayOnRecord, parState, syncParClock, waterAssignments } from '../lib/vitals'
import { useAppSlice } from '../state/store'
import './CommandVitals.css'

// ---------------------------------------------------------------------------
// COMMAND VITALS — the one-line pulse of the incident, pinned to every
// full-screen page so leaving the map never means losing the picture:
// elapsed clock, alarm level, who's at the box, PAR discipline, water,
// the last benchmark, and a MAYDAY flag that cannot be scrolled away from.
// Derives everything from the incident record (timeline + unit registry) —
// no page-local state to disagree with. The PAR window mirrors the OPS
// CLOCK exactly: same operator-set interval, same server anchor, same
// flip-to-red moment.
// ---------------------------------------------------------------------------

export function CommandVitals() {
  const { incident, timeline, units, parIntervalMin, parAnchorSrv } = useAppSlice((s) => ({
    incident: s.incident,
    timeline: s.timeline,
    units: s.units,
    parIntervalMin: s.parIntervalMin,
    parAnchorSrv: s.parAnchorSrv,
  }))
  void parIntervalMin
  void parAnchorSrv // subscribed so a setting change re-renders the strip
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!incident) return
    syncParClock()
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [incident])
  if (!incident) return null

  const startMs = Date.parse(incident.createdAt)
  const apparatus = Object.values(units).filter(isApparatus)
  const atBox = apparatus.filter((u) => isAtBox(u.status)).length
  const enroute = apparatus.filter((u) => isEnroute(u.status)).length

  const mayday = maydayOnRecord(timeline)
  const par = parState(timeline, incident, now)
  const sinceStartMin = Number.isFinite(startMs) ? Math.floor((now - startMs) / 60_000) : 0
  const water = Object.entries(waterAssignments(timeline))
  const bench = lastBenchmark(timeline)

  return (
    <div className="cmd-vitals" role="status" aria-label="Command vitals — elapsed, alarm, units, PAR, water, last benchmark">
      {mayday && (
        <span className="cv-mayday" title="A MAYDAY is on the incident record — this stays on every page until it is cleared on the record">
          ⚠ MAYDAY {fmtWallClock(mayday.t)}
        </span>
      )}
      <span className="cv-item">
        <i>T+</i>
        <b>{Number.isFinite(startMs) ? fmtElapsed(now - startMs) : '--:--'}</b>
      </span>
      {incident.alarmLevel && <span className="cv-item alarm">{alarmLabel(incident.alarmLevel)}</span>}
      <span className="cv-item">
        <i>AT BOX</i>
        <b>{atBox}</b>
        <i>ENROUTE</i>
        <b>{enroute}</b>
      </span>
      {par &&
        (par.lapsed ? (
          <span className="cv-item red" title={par.taken ? 'Time since the last completed PAR has passed the cycle' : 'No PAR has been taken on this box yet'}>
            {par.taken ? `PAR OVERDUE +${fmtElapsed(par.overdueMs)}` : `NO PAR TAKEN — T+${sinceStartMin} MIN`}
          </span>
        ) : (
          <span className="cv-item ok" title={`PAR cycle: every ${par.intervalMin} min — set from the OPS CLOCK chip on the map`}>
            PAR {par.taken ? 'CURRENT' : `DUE T+${par.intervalMin}`}
          </span>
        ))}
      <span className={`cv-item${water.length === 0 && sinceStartMin >= 5 ? ' amber' : ''}`} title={water.map(([h, u]) => `${u} → ${h}`).join(' · ') || 'No engine assigned to a hydrant yet — assign from the SIZE-UP card on the map'}>
        <i>WATER</i>
        <b>{water.length > 0 ? `${water.length} HYD` : 'NONE'}</b>
      </span>
      {bench && (
        <span className="cv-item dim" title="The last benchmark the IC logged">
          <i>LAST</i>
          <b>
            {bench.code} {fmtWallClock(bench.t)}
          </b>
        </span>
      )}
    </div>
  )
}
