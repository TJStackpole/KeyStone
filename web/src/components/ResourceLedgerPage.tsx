import { useEffect, useState } from 'react'
import './ResourceLedgerPage.css'
import { transmitAlarm } from '../actions'
import { alarmLabel } from '../lib/alarms'
import { edgeClassFor, isApparatus } from '../lib/crews'
import { setDashboardPage } from '../lib/layouts'
import { useAppSlice } from '../state/store'
import type { Unit } from '../types'

// ---------------------------------------------------------------------------
// RESOURCE LEDGER — dashboard page 4. Who is where (status board), what the
// next alarm brings (previewed by the SAME logic that would dispatch it),
// and which quarters sit empty. Plain DOM, zero Cesium imports — tap-to-fly
// reaches the 3D view through a dynamic import at click time and degrades
// silently if the map is dead. The coverage strip is SIMULATED end to end:
// real relocation orders come from dispatch, ours are a heuristic
// (VALIDATE—SME).
// ---------------------------------------------------------------------------

const BUCKETS = ['ASSIGNED', 'ENROUTE', 'STAGED', 'ON SCENE', 'OPERATING', 'REHAB'] as const
type Bucket = (typeof BUCKETS)[number]

function bucketOf(u: Unit): Bucket {
  const s = (u.status ?? '').toLowerCase()
  if (s.includes('rehab')) return 'REHAB'
  if (s === 'operating' || s === 'mayday') return 'OPERATING'
  if (s === 'staged') return 'STAGED'
  if (s === 'enroute' || s === 'en route' || s === 'dispatched' || s === 'responding') return 'ENROUTE'
  // Scenario/EUD vocabulary that means "this rig is at the box":
  if (s === 'on scene' || s === 'onscene' || s === 'arrived' || s === 'command' || s === 'released') return 'ON SCENE'
  // Anything else (a real ATAK EUD can send any word) files as ASSIGNED,
  // never as ON SCENE — accountability must not overstate who's arrived.
  return 'ASSIGNED'
}

interface Preview {
  nextLevel: string | null
  adds: { callsign: string; category: string }[]
  simActive?: boolean
}

/** Company numbers a firehouse name carries: "Engine 10/Ladder 10" -> E-10, L-10. */
function houseCompanies(name: string): string[] {
  const out: string[] = []
  const re = /(Engine|Ladder|Squad|Rescue|Battalion)\s+(\d+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(name))) {
    const prefix = { engine: 'E', ladder: 'L', squad: 'SQ', rescue: 'R', battalion: 'BC' }[m[1].toLowerCase()] ?? m[1][0]
    out.push(`${prefix}-${Number(m[2])}`)
  }
  return out
}

export function ResourceLedgerPage() {
  const { page, incident, units, firehouses, alarmLevel } = useAppSlice((s) => ({
    page: s.dashboardPage,
    incident: s.incident,
    units: s.units,
    firehouses: s.intel.firehouses,
    alarmLevel: s.incident?.alarmLevel ?? null,
  }))
  // Tri-state: undefined = loading, null = fetch failed, object = answer.
  // Collapsing failure into "no next level" would render "Top of the
  // ladder" on a box sitting at 10-75.
  const [preview, setPreview] = useState<Preview | null | undefined>(undefined)
  const apparatus = Object.values(units).filter(isApparatus)
  // Apparatus count (not raw unit count — crew members spawn constantly) in
  // the deps: an escalation raises the alarm level ~2s before the rigs
  // actually spawn, and the refetch when they land keeps already-dispatched
  // companies out of the "next alarm" row.
  const apparatusCount = apparatus.length
  useEffect(() => {
    if (page !== 4 || !incident) {
      setPreview(undefined) // a dead box must not keep a live ESCALATE row
      return
    }
    let dead = false
    fetch('/api/alarm/preview')
      .then((r) => (r.ok ? r.json() : null))
      .then((p: Preview | null) => {
        if (!dead) setPreview(p)
      })
      .catch(() => {
        if (!dead) setPreview(null)
      })
    return () => {
      dead = true
    }
  }, [page, incident, alarmLevel, apparatusCount])
  if (page !== 4) return null
  const byBucket = new Map<Bucket, Unit[]>(BUCKETS.map((b) => [b, []]))
  for (const u of apparatus) byBucket.get(bucketOf(u))!.push(u)

  const flyTo = (u: Unit) => {
    // Dynamic import keeps this page Cesium-free; a dead 3D view fails the
    // import or returns no scene and the tap degrades to nothing, silently.
    void import('../cesium/scene')
      .then((m) => {
        const scene = m.getScene()
        if (!scene) return
        setDashboardPage(0)
        void import('cesium').then((C) => {
          scene.viewer.camera.flyTo({
            destination: C.Cartesian3.fromDegrees(u.lon, u.lat, 500),
            duration: 1.0,
          })
        })
      })
      .catch(() => {})
  }

  const committed = new Set(apparatus.map((u) => u.callsign))
  // EMPTY QUARTERS means empty: every company the house runs is on this box.
  // A house with one of two companies out is thin, not empty — listing it
  // here would overstate the coverage hole.
  const emptyQuarters = firehouses
    .map((f) => {
      const companies = houseCompanies(f.name)
      const out = companies.filter((c) => committed.has(c))
      return { house: f, companies, out }
    })
    .filter((h) => h.companies.length > 0 && h.out.length === h.companies.length)
  // Relocation candidates must actually run companies (marine/HQ facilities
  // parse to zero) and none of them committed here.
  const coverCandidates = firehouses.filter((f) => {
    const companies = houseCompanies(f.name)
    return companies.length > 0 && companies.every((c) => !committed.has(c))
  })
  // Suggest the candidate nearest the EMPTY house (equirectangular approx is
  // plenty at borough scale) — not the one nearest the fire, which would
  // strip coverage right next to the incident.
  const nearestCover = (house: { lat: number; lon: number }) => {
    let best: (typeof coverCandidates)[number] | null = null
    let bestD = Infinity
    for (const c of coverCandidates) {
      const dx = (c.lon - house.lon) * Math.cos((house.lat * Math.PI) / 180)
      const dy = c.lat - house.lat
      const d = dx * dx + dy * dy
      if (d < bestD) {
        bestD = d
        best = c
      }
    }
    return best
  }

  const summary = (adds: Preview['adds']) => {
    const n = (cat: string) => adds.filter((a) => a.category === cat).length
    const parts = [
      [n('engine'), 'ENG'],
      [n('ladder'), 'LAD'],
      [n('battalion'), 'BN'],
    ].filter(([c]) => (c as number) > 0)
    return parts.map(([c, l]) => `${c} ${l}`).join(' · ') || 'no additional companies available'
  }

  return (
    <div className="ledger-page">
      <header className="rl-head">
        <button className="rl-back" onClick={() => setDashboardPage(0)}>
          ◀ MAP
        </button>
        <div>
          <h1>RESOURCE LEDGER</h1>
          <div className="rl-sub">{incident ? incident.address : 'NO ACTIVE INCIDENT — the board still reads standing resources'}</div>
        </div>
      </header>

      <section className="rl-board">
        {BUCKETS.map((b) => {
          const list = byBucket.get(b)!
          return (
            <div key={b} className="rl-col">
              <h3>
                {b} <em>{list.length}</em>
              </h3>
              {list.map((u) => (
                <button key={u.uid} className={`rl-chip ${edgeClassFor(u.category)}`} onClick={() => flyTo(u)} title="Tap to see on the map (when the 3D view is alive)">
                  {u.callsign}
                </button>
              ))}
            </div>
          )
        })}
      </section>

      <section className="rl-preview">
        <div className="rl-zone-label">NEXT ALARM — previewed by the same logic that would dispatch it</div>
        {incident && preview?.nextLevel ? (
          <div className="rl-preview-row">
            <b>{alarmLabel(preview.nextLevel)} ADDS: {summary(preview.adds)}</b>
            <span className="rl-callsigns">{preview.adds.map((a) => a.callsign).join(' · ')}</span>
            {preview.simActive === false && <span className="rl-warn">dispatch sim idle — preview only</span>}
            <button
              className="rl-escalate"
              onClick={() => void transmitAlarm(preview.nextLevel as Parameters<typeof transmitAlarm>[0])}
              title={`Transmit ${alarmLabel(preview.nextLevel)} — dispatches the escalation AND records the benchmark`}
            >
              ESCALATE TO {alarmLabel(preview.nextLevel)}
            </button>
          </div>
        ) : (
          <div className="rl-empty">
            {!incident
              ? 'NO ACTIVE INCIDENT — the preview needs a live box.'
              : preview === undefined
                ? 'Fetching the next-alarm preview…'
                : preview === null
                  ? 'PREVIEW UNAVAILABLE — check the link; escalation itself still works from the strip or the LOG.'
                  : 'Top of the ladder — no further alarm level.'}
          </div>
        )}
      </section>

      <section className="rl-coverage">
        <div className="rl-zone-label">
          COVERAGE — EMPTY QUARTERS <span className="rl-sim-tag">SIMULATED · relocation suggestions are a heuristic, real orders come from dispatch (VALIDATE—SME)</span>
        </div>
        {emptyQuarters.length === 0 && <div className="rl-empty">No emptied quarters on this box yet.</div>}
        {emptyQuarters.slice(0, 8).map((h) => {
          const cover = nearestCover(h.house)
          return (
            <div key={h.house.name} className="rl-house">
              <span className="rl-house-name">{h.house.name}</span>
              <span className="rl-house-out">{h.out.join(', ')} COMMITTED</span>
              {cover && <span className="rl-house-suggest">SUGGEST: {houseCompanies(cover.name)[0]} RELOCATES TO COVER</span>}
            </div>
          )
        })}
      </section>
    </div>
  )
}
