import { useMemo } from 'react'
import { focusFeedIncident } from '../actions'
import type { FeedIncident } from '../types'
import { alarmLabel } from '../lib/alarms'
import { buildDispatchScript, playDispatch, stopDispatch } from '../lib/dispatchAudio'
import { setDashboardPage } from '../lib/layouts'
import { useAppSlice } from '../state/store'
import './DispatchPage.css'

// ---------------------------------------------------------------------------
// DISPATCH COMMS — dashboard page 5, next to LOG. The SIMULATED dispatch
// console for the active box: the FDNY dispatch and EMS dispatch
// announcements, generated from the live incident (address, alarm, the real
// responding apparatus) and playable as audio through the browser's own
// speech synthesis. Select any building, respond to it, and this page reads
// its dispatch. Plain DOM like every manual page.
// ---------------------------------------------------------------------------

function feedElapsed(startedAt: string): string {
  const min = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 60_000))
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60}m`
}

export function DispatchPage() {
  const { page, incident, units, playing, dispatchFeed, focusedFeedId } = useAppSlice((s) => ({
    page: s.dashboardPage,
    incident: s.incident,
    units: s.units,
    playing: s.dispatchPlaying,
    dispatchFeed: s.dispatchFeed,
    focusedFeedId: s.focusedFeedId,
  }))
  // Rebuilds when the box or the responding units change — the audio always
  // reads the CURRENT assignment.
  const script = useMemo(() => buildDispatchScript(), [incident, units])
  void units
  // Division -> Battalion -> boxes (moved here from the old top-bar menu).
  const divisions = useMemo(() => {
    if (page !== 5) return []
    const byDivision = new Map<number, Map<number, FeedIncident[]>>()
    for (const fi of dispatchFeed) {
      if (!byDivision.has(fi.division)) byDivision.set(fi.division, new Map())
      const byBn = byDivision.get(fi.division)!
      if (!byBn.has(fi.battalion)) byBn.set(fi.battalion, [])
      byBn.get(fi.battalion)!.push(fi)
    }
    return [...byDivision.entries()].sort((a, b) => a[0] - b[0])
  }, [page, dispatchFeed])
  if (page !== 5) return null

  const card = (kind: 'fdny' | 'ems', title: string, text: string | undefined) => (
    <section className={`dp-card ${kind}`}>
      <header className="dp-card-head">
        <b>{title}</b>
        <span className="dp-sim">SIMULATED</span>
        <button
          className={`dp-play${playing === kind ? ' on' : ''}`}
          disabled={!script}
          onClick={() => (playing === kind ? stopDispatch() : playDispatch(kind))}
          title={playing === kind ? 'Stop playback' : `Play the ${title.toLowerCase()} for this box (browser speech synthesis — no keys)`}
        >
          {playing === kind ? '■ STOP' : '▶ PLAY'}
        </button>
      </header>
      <p className="dp-script">{text ?? '—'}</p>
    </section>
  )

  return (
    <div className="dispatch-page">
      <header className="dp-header">
        <button className="dp-map-btn" onClick={() => setDashboardPage(0)}>
          ◀ MAP
        </button>
        <div className="dp-title">
          <span className="dp-eyebrow">DISPATCH COMMS · SIMULATED FIRECAD/EMD AUDIO</span>
          <span className="dp-address">{incident ? incident.address : 'NO ACTIVE INCIDENT — select a building or press a box in INCIDENTS'}</span>
        </div>
        {incident?.type && <span className="dp-chip">{incident.type}</span>}
        {incident?.alarmLevel && <span className="dp-chip amber">{alarmLabel(incident.alarmLevel)}</span>}
        {script && <span className="dp-chip mono">BOX {script.box}</span>}
        {playing === 'both' && (
          <button className="dp-play on" onClick={stopDispatch}>
            ■ STOP
          </button>
        )}
        {playing !== 'both' && (
          <button className="dp-play" disabled={!script} onClick={() => playDispatch('both')} title="Play the FDNY dispatch, then the EMS dispatch, back to back">
            ▶ PLAY FULL DISPATCH
          </button>
        )}
      </header>
      <div className="dp-note">
        Announcements are generated from the live box — address, alarm level, and the actual responding apparatus — and
        spoken with the browser's speech synthesis. Every announcement identifies itself as simulated.
      </div>
      <div className="dp-body">
        <section className="dp-feed">
          <div className="incidents-head">SIMULATED CITYWIDE DISPATCH FEED · FDNY / NYPD / PAPD DISPATCH CENTERS — PRESS A BOX TO RESPOND</div>
          {divisions.length === 0 && <div className="incidents-empty">AWAITING DISPATCH FEED…</div>}
          {divisions.map(([division, byBn]) => (
            <div key={division} className="feed-division">
              <div className="feed-division-head">DIVISION {division}</div>
              {[...byBn.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([battalion, list]) => (
                  <div key={battalion} className="feed-battalion">
                    <div className="feed-battalion-head">BATTALION {battalion}</div>
                    {list.map((fi) => (
                      <button
                        key={fi.id}
                        className={`feed-row${focusedFeedId === fi.id ? ' focused' : ''}`}
                        onClick={() => void focusFeedIncident(fi)}
                        title={`Respond to this box — stands it up at ${fi.address} and builds the response packet; the dispatch audio on the right reads its assignment`}
                      >
                        <span className={`feed-src ${fi.source.toLowerCase()}`}>{fi.source}</span>
                        <span className="feed-main">
                          <b>{fi.type}</b>
                          <i>{fi.address} · {fi.borough}</i>
                        </span>
                        <span className="feed-meta">
                          {fi.units} UNIT{fi.units === 1 ? '' : 'S'} · {feedElapsed(fi.startedAt)}
                          <em>{focusedFeedId === fi.id ? 'FOCUSED' : fi.status.toUpperCase()}</em>
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
            </div>
          ))}
        </section>
        <div className="dp-cards">
          {card('fdny', 'FDNY DISPATCH', script?.fdny)}
          {card('ems', 'EMS DISPATCH', script?.ems)}
        </div>
      </div>
    </div>
  )
}
