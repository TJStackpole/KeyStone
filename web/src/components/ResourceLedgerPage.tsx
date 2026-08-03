import { useEffect, useState } from 'react'
import './ResourceLedgerPage.css'
import { setDashboardPage } from '../lib/layouts'
import { edgeClassFor, isApparatus } from '../lib/crews'
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
  if (s === 'operating') return 'OPERATING'
  if (s === 'staged') return 'STAGED'
  if (s === 'enroute') return 'ENROUTE'
  if (s !== '') return 'ON SCENE'
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
  const [preview, setPreview] = useState<Preview | null>(null)
  // unitCount in the deps: an escalation raises the alarm level ~2s before
  // the reinforcements actually spawn — refetching again when they land
  // keeps already-dispatched companies out of the "next alarm" row.
  const unitCount = Object.keys(units).length
  useEffect(() => {
    if (page !== 4 || !incident) return
    let dead = false
    fetch('/api/alarm/preview')
      .then((r) => (r.ok ? r.json() : null))
      .then((p: Preview | null) => {
        if (!dead) setPreview(p)
      })
      .catch(() => {})
    return () => {
      dead = true
    }
  }, [page, incident, alarmLevel, unitCount])
  if (page !== 4) return null

  const apparatus = Object.values(units).filter(isApparatus)
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
  const emptyQuarters = firehouses
    .map((f) => {
      const companies = houseCompanies(f.name)
      const out = companies.filter((c) => committed.has(c))
      return { house: f, companies, out }
    })
    .filter((h) => h.out.length > 0)
  const coverCandidates = firehouses.filter((f) => houseCompanies(f.name).every((c) => !committed.has(c)))

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
        {preview?.nextLevel ? (
          <div className="rl-preview-row">
            <b>{preview.nextLevel.toUpperCase()} ALARM ADDS: {summary(preview.adds)}</b>
            <span className="rl-callsigns">{preview.adds.map((a) => a.callsign).join(' · ')}</span>
            {preview.simActive === false && <span className="rl-warn">dispatch sim idle — preview only</span>}
            <button
              className="rl-escalate"
              onClick={() => {
                // Same unified server path the strip and log use: /api/alarm
                // escalates AND writes the ic.benchmark row in one request.
                void fetch('/api/alarm', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ level: preview.nextLevel }),
                }).catch(() => {})
              }}
            >
              ESCALATE TO {preview.nextLevel.toUpperCase()}
            </button>
          </div>
        ) : (
          <div className="rl-empty">{incident ? 'Top of the ladder — no further alarm level.' : 'Preview needs a live box.'}</div>
        )}
      </section>

      <section className="rl-coverage">
        <div className="rl-zone-label">
          COVERAGE — EMPTY QUARTERS <span className="rl-sim-tag">SIMULATED · relocation suggestions are a heuristic, real orders come from dispatch (VALIDATE—SME)</span>
        </div>
        {emptyQuarters.length === 0 && <div className="rl-empty">No committed quarters on this box yet.</div>}
        {emptyQuarters.slice(0, 8).map((h, i) => (
          <div key={h.house.name} className="rl-house">
            <span className="rl-house-name">{h.house.name}</span>
            <span className="rl-house-out">{h.out.join(', ')} COMMITTED</span>
            {coverCandidates[i] && (
              <span className="rl-house-suggest">SUGGEST: {houseCompanies(coverCandidates[i].name)[0] ?? coverCandidates[i].name} RELOCATES TO COVER</span>
            )}
          </div>
        ))}
      </section>
    </div>
  )
}
