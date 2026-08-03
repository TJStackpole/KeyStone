import { useEffect, useState } from 'react'
import { openBrief } from '../lib/brief'
import { useMovable } from '../lib/movable'
import { setAppState, useAppSlice } from '../state/store'
import { fmtAge } from './FeedHealthPanel'

// ---------------------------------------------------------------------------
// RESPONSE PACKET — what a chief/captain/LT gets the moment they press their
// box on the CAD dispatch feed: everything dispatch knows, everything the
// open-data building record adds, and the fire so far — one panel, plain
// language, live-updating while they respond. Street View and the full
// SITREP open alongside automatically. The CAD feed is SIMULATED (FireCAD
// integration point); every dispatch-sourced row says so.
// ---------------------------------------------------------------------------

export function ResponsePacket() {
  const mvPacket = useMovable('response-packet')
  const { open, cad, incident, intel, timeline, units } = useAppSlice((s) => ({
    open: s.responsePacketOpen,
    cad: s.cadIncident,
    incident: s.incident,
    intel: s.intel,
    timeline: s.timeline,
    units: s.units,
  }))
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => setTick((n) => n + 1), 5000)
    return () => clearInterval(t)
  }, [open])
  if (!open || !incident) return null

  // The fire so far — same milestone grammar as the SITREP, kept terse.
  const milestones: { t: string; text: string }[] = []
  let sawArrival = false
  for (const ev of timeline) {
    const p = (ev.payload ?? {}) as Record<string, unknown>
    if (ev.kind === 'incident.created') milestones.push({ t: ev.t, text: `Box transmitted — ${String(p.type ?? incident.type ?? '')}` })
    else if (ev.kind === 'sim.dispatched') milestones.push({ t: ev.t, text: `Assignment dispatched (${(p.callsigns as string[])?.length ?? '?'} units)` })
    else if (ev.kind === 'sim.arrived' && !sawArrival) {
      sawArrival = true
      milestones.push({ t: ev.t, text: `First unit on scene — ${String(p.callsign ?? '')}` })
    } else if (ev.kind === 'sim.escalated') milestones.push({ t: ev.t, text: `Alarm upgraded (+${(p.added as string[])?.length ?? 0} units)` })
  }
  const recent = milestones.slice(-5)

  const unitList = Object.values(units)
  const onScene = unitList.filter((u) => u.status && u.status !== 'Enroute').length
  const pluto = intel.pluto
  const hydrants = intel.hydrants.slice(0, 3)

  return (
    <aside {...mvPacket} className="packet glass">
      <div className="packet-head">
        <b>RESPONSE PACKET</b>
        {cad && <span className="packet-sim">CAD · SIMULATED</span>}
        <button className="no-drag feed-close" onClick={() => setAppState({ responsePacketOpen: false })} title="Close">
          ✕
        </button>
      </div>

      <div className="packet-sec">
        <div className="packet-title">DISPATCH</div>
        <div className="packet-line big">{incident.address}</div>
        <div className="packet-line">
          {cad ? `${cad.type} · Battalion ${cad.battalion} · Division ${cad.division}` : (incident.type ?? 'Incident')}
          {incident.alarmLevel ? ` · ${incident.alarmLevel} ALARM` : ''}
        </div>
        {cad && (
          <div className="packet-line dim">
            Dispatched {fmtAge(Date.now() - Date.parse(cad.startedAt))} ago · {cad.units} units assigned · source {cad.source} dispatch
          </div>
        )}
        <div className="packet-line dim">
          On the picture now: {onScene} on scene of {unitList.length}
        </div>
      </div>

      <div className="packet-sec">
        <div className="packet-title">THE BUILDING</div>
        {pluto ? (
          <div className="packet-line">
            {pluto.numFloors ? `${pluto.numFloors} floors` : 'Floors unknown'}
            {pluto.landUse ? ` · ${pluto.landUse}` : ''}
            {pluto.yearBuilt ? ` · built ${pluto.yearBuilt}` : ''}
            {pluto.bldgClass ? ` · class ${pluto.bldgClass}` : ''}
          </div>
        ) : (
          <div className="packet-line dim">Building record loading — details fill in as open data answers</div>
        )}
        {hydrants.length > 0 && (
          <div className="packet-line dim">
            Hydrants: {hydrants.map((h) => `${Math.round(h.distanceM)} m`).join(' · ')} (nearest three)
          </div>
        )}
      </div>

      <div className="packet-sec">
        <div className="packet-title">THE FIRE SO FAR</div>
        {recent.length === 0 && <div className="packet-line dim">Nothing on the record yet — you are early</div>}
        {recent.map((m, i) => (
          <div key={i} className="packet-line">
            <span className="packet-when">{fmtAge(Date.now() - Date.parse(m.t))}</span> {m.text}
          </div>
        ))}
      </div>

      <div className="packet-actions no-drag">
        <button onClick={() => setAppState((s) => ({ streetViewOpen: !s.streetViewOpen }))} title="Photographic view of the building from the street">
          STREET VIEW
        </button>
        <button onClick={() => setAppState({ utilityTab: 'sitrep' })} title="The full live situation report panel">
          FULL SITREP
        </button>
        <button onClick={openBrief} title="Print-ready one-page brief of everything here">
          PRINT
        </button>
      </div>
    </aside>
  )
}
