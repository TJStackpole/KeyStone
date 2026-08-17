import { useEffect } from 'react'
import { flyToFeature, placeExposureLabels, windName } from '../actions'
import { isApparatus, isAtBox, isEnroute } from '../lib/crews'
import { useMovable } from '../lib/movable'
import { waterAssignments } from '../lib/vitals'
import { useAppSlice } from '../state/store'
import { notify } from './NoticeChip'
import './SizeUpCard.css'

// ---------------------------------------------------------------------------
// SIZE-UP — the one card a chief reads on arrival, built from live NYC data
// the platform already fetches: construction (PLUTO), stories, occupancy,
// the three nearest hydrants WITH distances and one-tap engine assignment,
// live NWS wind, exposure status, and alarm level. COAL WAS WEALTH, one
// glance, zero digging through panels.
// ---------------------------------------------------------------------------

/** DOF building-class letter -> what the first-due officer calls it. */
const BLDG_CLASS: Record<string, string> = {
  A: 'One-family dwelling',
  B: 'Two-family dwelling',
  C: 'Walk-up apartments',
  D: 'Elevator apartments',
  E: 'Warehouse',
  F: 'Factory / industrial',
  G: 'Garage',
  H: 'Hotel',
  I: 'Hospital / health',
  J: 'Theatre',
  K: 'Store / retail',
  L: 'Loft',
  M: 'House of worship',
  N: 'Institutional',
  O: 'Office',
  P: 'Public assembly',
  Q: 'Recreation',
  R: 'Condominium',
  S: 'Mixed residence + store',
  T: 'Transportation',
  U: 'Utility',
  V: 'Vacant lot',
  W: 'School',
  Y: 'Government',
  Z: 'Miscellaneous',
}

const ftFromM = (m: number) => Math.round((m * 3.28084) / 10) * 10
const mphFromKt = (kt: number) => Math.round(kt * 1.15078)

export function SizeUpCard() {
  const mvSizeup = useMovable('sizeup-card')
  const { incident, pluto, plutoStatus, hydrants, wind, shapes, units, alarmLevel, timeline } = useAppSlice((s) => ({
    incident: s.incident,
    pluto: s.intel.pluto,
    plutoStatus: s.layers.pluto,
    hydrants: s.intel.hydrants,
    wind: s.wind,
    shapes: s.shapes,
    units: s.units,
    alarmLevel: s.incident?.alarmLevel ?? null,
    timeline: s.timeline,
  }))
  // The intel panel sits below this card only while the card is actually up
  // (SizeUpCard.css keys its offset on this class).
  useEffect(() => {
    if (!incident) return
    document.body.classList.add('has-sizeup')
    return () => document.body.classList.remove('has-sizeup')
  }, [incident])
  if (!incident) return null

  const exposures = Object.values(shapes).filter(
    (sh) => sh.kind === 'post' && (sh as { post?: string }).post === 'exposure',
  )
  // Rigs only — crew members (E-6/1) would double-count every arrival.
  const roster = Object.values(units).filter(isApparatus)
  const engines = roster.filter((u) => u.category === 'engine').map((u) => u.callsign)
  const onScene = roster.filter((u) => isAtBox(u.status)).length
  const enroute = roster.filter((u) => isEnroute(u.status)).length
  const near = [...hydrants].sort((a, b) => a.distanceM - b.distanceM).slice(0, 3)
  const classLabel = pluto?.bldgClass ? BLDG_CLASS[pluto.bldgClass[0]?.toUpperCase() ?? ''] : undefined
  const windMph = wind ? mphFromKt(wind.speedKt) : 0

  // Assignments come from the incident record itself — every dashboard shows
  // the same water picture, it survives reloads, and it resets with the box.
  const assigned = waterAssignments(timeline)

  const assignHydrant = (hydrantId: string, unit: string) => {
    if (!unit) return
    void fetch('/api/timeline', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'water.assign', payload: { hydrant: hydrantId, unit, by: 'IC' } }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status))
        notify(`${unit} → HYDRANT ${hydrantId}`)
      })
      .catch(() => notify('WATER ASSIGNMENT DID NOT REACH THE LOG'))
  }

  return (
    <aside {...mvSizeup} className="sizeup-card glass">
      <div className="suc-head">
        <b>SIZE-UP</b>
        <span className="suc-alarm">{(alarmLevel ?? 'FIRST ALARM').toUpperCase()}</span>
      </div>

      <div className="suc-grid">
        <div className="suc-row">
          <span className="suc-k">BUILDING</span>
          <span className="suc-v">
            {pluto?.numFloors ? `${pluto.numFloors} STORIES` : 'STORIES —'}
            {pluto?.yearBuilt ? ` · BUILT ${pluto.yearBuilt}` : ''}
            {pluto?.yearBuilt && pluto.yearBuilt < 1938 ? ' · PRE-CODE' : ''}
          </span>
        </div>
        <div className="suc-row">
          <span className="suc-k">OCCUPANCY</span>
          <span className="suc-v">
            {classLabel ??
              pluto?.landUse ??
              (plutoStatus === 'idle' || plutoStatus === 'loading' ? 'QUERYING NYC DATA…' : 'NO PLUTO RECORD')}
            {pluto?.bldgClass ? ` (${pluto.bldgClass})` : ''}
          </span>
        </div>
        <div className="suc-row">
          <span className="suc-k">WIND</span>
          <span className="suc-v">
            {wind && windMph >= 3
              ? `${windMph} MPH FROM ${windName(wind.fromDeg)}${wind.gustKt ? ` · G${mphFromKt(wind.gustKt)}` : ''}`
              : wind
                ? 'CALM'
                : 'CALM / AWAITING NWS'}
          </span>
        </div>
        <div className="suc-row">
          <span className="suc-k">EXPOSURES</span>
          {exposures.length >= 4 ? (
            <span className="suc-v ok">SET — EXP 1 STREET SIDE, 2-3-4 CLOCKWISE</span>
          ) : (
            <button
              className="suc-btn"
              onClick={() => void placeExposureLabels()}
              title="One press labels the four sides — Exposure 1 on the street side, 2-3-4 clockwise (FDNY convention)"
            >
              TAP TO ASSIGN
            </button>
          )}
        </div>
        <div className="suc-row">
          <span className="suc-k">UNITS</span>
          <span className="suc-v">
            {onScene} ON SCENE · {enroute} ENROUTE
          </span>
        </div>
      </div>

      <div className="suc-water-label">WATER — NEAREST HYDRANTS</div>
      {near.length === 0 && <div className="suc-empty">Hydrant layer loading (NYC Open Data)…</div>}
      {near.map((h) => (
        <div key={h.id} className="suc-hydrant">
          <button className="suc-hyd-loc" onClick={() => flyToFeature(h.lat, h.lon)} title="Show this hydrant on the map">
            ⌖ {ftFromM(h.distanceM)} FT
          </button>
          <span className="suc-hyd-id">H-{h.id.slice(-4).toUpperCase()}</span>
          {assigned[h.id] ? (
            <span className="suc-hyd-assigned">
              {assigned[h.id]} ✓
              <button
                className="suc-hyd-clear"
                title={`Release ${assigned[h.id]} from this hydrant (stays on the log as history)`}
                onClick={() =>
                  void fetch('/api/timeline', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ kind: 'water.clear', payload: { hydrant: h.id, by: 'IC' } }),
                  }).catch(() => notify('RELEASE DID NOT REACH THE LOG'))
                }
              >
                ✕
              </button>
            </span>
          ) : (
            <select
              className="suc-hyd-assign"
              value=""
              disabled={engines.length === 0}
              onChange={(e) => assignHydrant(h.id, e.target.value)}
              title="Assign an engine to this hydrant — lands on the incident log"
            >
              <option value="">{engines.length ? 'ASSIGN…' : 'NO ENGINES'}</option>
              {engines.map((cs) => (
                <option key={cs} value={cs}>
                  {cs}
                </option>
              ))}
            </select>
          )}
        </div>
      ))}
    </aside>
  )
}
