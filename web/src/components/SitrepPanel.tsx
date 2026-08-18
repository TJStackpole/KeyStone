import { useEffect, useMemo, useState } from 'react'
import { alarmLabel } from '../lib/alarms'
import { isApparatus, isAtBox } from '../lib/crews'
import { useAppSlice } from '../state/store'
import type { Agency } from '../types'

// ---------------------------------------------------------------------------
// SITREP (walk-up situation summary): everything someone approaching the
// dashboard needs, composed live from the incident record, timeline
// milestones, the unit picture, ICS overlay, and priority radio traffic.
// ---------------------------------------------------------------------------

function hhmm(iso?: string): string {
  return iso ? new Date(iso).toTimeString().slice(0, 5) : '—'
}

export function SitrepContent() {
  const { incident, units, timeline, transcripts, shapes } = useAppSlice((s) => ({ incident: s.incident, units: s.units, timeline: s.timeline, transcripts: s.transcripts, shapes: s.shapes }))
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000)
    return () => clearInterval(t)
  }, [])

  const milestones = useMemo(() => {
    const out: { t: string; text: string }[] = []
    let firstArrival: string | null = null
    for (const ev of timeline) {
      const p = (ev.payload ?? {}) as Record<string, unknown>
      if (ev.kind === 'incident.created') out.push({ t: ev.t, text: `Incident stood up — ${String(p.type ?? '')}` })
      else if (ev.kind === 'sim.dispatched')
        out.push({ t: ev.t, text: `First alarm dispatched (${(p.callsigns as string[])?.length ?? '?'} units)` })
      else if (ev.kind === 'sim.arrived' && !firstArrival) {
        firstArrival = ev.t
        out.push({ t: ev.t, text: `First unit on scene — ${String(p.callsign ?? '')}` })
      } else if (ev.kind === 'sim.escalated')
        out.push({
          t: ev.t,
          text: `${alarmLabel(String(p.level))} transmitted (+${(p.added as string[])?.length ?? 0} units)`,
        })
      else if (ev.kind === 'incident.updated' && p.type) out.push({ t: ev.t, text: `Incident type: ${String(p.type)}` })
    }
    const firstZone = timeline.find(
      (ev) => ev.kind === 'shape.upserted' && ((ev.payload ?? {}) as { kind?: string }).kind === 'zone',
    )
    if (firstZone) out.push({ t: firstZone.t, text: 'Perimeter established' })
    return out.sort((a, b) => Date.parse(a.t) - Date.parse(b.t)).slice(-8)
  }, [timeline])

  const picture = useMemo(() => {
    const byAgency = new Map<Agency, { onScene: number; total: number }>()
    let operating = 0
    let dronesAloft = 0
    for (const u of Object.values(units)) {
      if (u.category === 'drone' && u.hae > 20) dronesAloft++
      // Rigs only, on BOTH sides of the ratio — crew members and drones in
      // the denominator would read as units unaccounted for.
      if (!isApparatus(u)) continue
      const rec = byAgency.get(u.agency) ?? { onScene: 0, total: 0 }
      rec.total++
      if (isAtBox(u.status)) rec.onScene++
      byAgency.set(u.agency, rec)
      if (u.status === 'Operating') operating++
    }
    const zones = Object.values(shapes).filter((s) => s.kind === 'zone').length
    const posts = Object.values(shapes).filter((s) => s.kind === 'post').length
    return { byAgency: [...byAgency.entries()], operating, dronesAloft, zones, posts }
  }, [units, shapes])

  const priorityTraffic = useMemo(
    () =>
      transcripts.fdny
        .filter((l) => l.keywords.some((k) => k.kind === 'code' || k.kind === 'urgent'))
        .slice(-3),
    [transcripts.fdny],
  )

  if (!incident) return <div className="roster-empty">NO ACTIVE INCIDENT — STAND ONE UP FIRST</div>

  const elapsedMin = Math.floor((Date.now() - Date.parse(incident.createdAt)) / 60000)

  return (
    <div className="dock-scroll">
      <div className="sitrep-updated">LIVE · AUTO-UPDATING</div>
      <div className="sitrep-body">
        <p className="sitrep-lead">
          <b>{incident.type}</b> at <b>{incident.address}</b> — {incident.alarmLevel ? alarmLabel(incident.alarmLevel) : 'no alarm transmitted yet'},
          {' '}operating {elapsedMin} min{incident.bin ? ` · BIN ${incident.bin}` : ''}.
        </p>

        <div className="sitrep-section">CURRENT PICTURE</div>
        <ul className="sitrep-list">
          {picture.byAgency.map(([agency, c]) => (
            <li key={agency}>
              {agency}: <b>{c.onScene}</b> of {c.total} on scene
            </li>
          ))}
          {picture.operating > 0 && <li>{picture.operating} units operating</li>}
          {picture.dronesAloft > 0 && <li>{picture.dronesAloft} UAS aloft over the scene</li>}
          {(picture.zones > 0 || picture.posts > 0) && (
            <li>
              ICS overlay: {picture.zones} zone{picture.zones === 1 ? '' : 's'}, {picture.posts} post
              {picture.posts === 1 ? '' : 's'}
            </li>
          )}
        </ul>

        <div className="sitrep-section">KEY TIMES</div>
        <ul className="sitrep-list mono">
          {milestones.map((m, i) => (
            <li key={i}>
              <span className="sitrep-t">{hhmm(m.t)}</span> {m.text}
            </li>
          ))}
          {milestones.length === 0 && <li>No milestones recorded yet.</li>}
        </ul>

        {priorityTraffic.length > 0 && (
          <>
            <div className="sitrep-section">PRIORITY TRAFFIC</div>
            <ul className="sitrep-list">
              {priorityTraffic.map((l, i) => (
                <li key={i}>
                  <span className="sitrep-t">{hhmm(l.ts)}</span> “{l.text}”
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
