import { useEffect, useRef, useState } from 'react'
import { useAppSlice } from '../state/store'

// ---------------------------------------------------------------------------
// FLOOR GAUGE — while the ISOLATE lock looks at a facade (N/E/S/W), a slim
// vertical bar on the right edge shows the travel range for the view: grade
// to roof, floors ticked, the current camera floor and the fire floor
// marked. Tap anywhere on the track to jump the camera to that floor. Hidden
// for TOP (plan view has no up/down) and whenever the lock is off.
// ---------------------------------------------------------------------------

type ViewLockApi = typeof import('../cesium/viewLock')

const SIDES = new Set(['north', 'east', 'south', 'west'])

/** Floor under the pointer — the track maps bottom→FL 1, top→top floor. */
function floorAt(e: React.PointerEvent<HTMLDivElement>, floors: number): number {
  const r = e.currentTarget.getBoundingClientRect()
  const frac = 1 - (e.clientY - r.top) / r.height
  return Math.min(floors, Math.max(1, Math.ceil(frac * floors)))
}

export function FloorGauge() {
  const { viewLock, viewLockFloor, targetHeightM, units } = useAppSlice((s) => ({
    viewLock: s.viewLock,
    viewLockFloor: s.viewLockFloor,
    targetHeightM: s.targetHeightM,
    units: s.units,
  }))
  const active = SIDES.has(viewLock)
  // Same lazy pattern as the SIZE-UP strip: the camera API loads with first
  // use so this component keeps Cesium out of its static graph.
  const [vl, setVl] = useState<ViewLockApi | null>(null)
  const scrubbing = useRef(false)
  useEffect(() => {
    if (active && !vl) void import('../cesium/viewLock').then(setVl)
  }, [active, vl])
  if (!active || !vl) return null

  const floors = Math.max(1, vl.viewLockFloors())
  const fire = vl.battleFireFloor()
  const roofFt = targetHeightM ? Math.round(targetHeightM * 3.281) : null
  // Center of a floor's band on the track, as a bottom-% offset.
  const pct = (fl: number) => ((fl - 0.5) / floors) * 100
  const mbr = Object.values(units).filter(
    (u) => (u.category === 'ff' || u.category === 'officer') && (u.floor ?? 0) === viewLockFloor,
  ).length
  // Per-floor ticks read fine to ~36 floors; towers get every 5th only.
  const step = floors > 36 ? 5 : 1
  const ticks: number[] = []
  for (let f = step; f < floors; f += step) ticks.push(f)

  return (
    <aside className="floor-gauge" aria-label="Facade view travel range — grade to roof">
      <div className="fg-cap">
        <b>FL {floors}</b>
        <i>{roofFt ? `ROOF ~${roofFt} FT` : 'ROOF'}</i>
      </div>
      <div
        className="fg-track"
        title="Grade to roof — tap a spot (or drag the bar) and the camera flies eye-level with that floor. ↑↓ steps one at a time."
        onPointerDown={(e) => {
          scrubbing.current = true
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            // capture is an assist, not a requirement — scrub still works
          }
          vl.jumpViewLockFloor(floorAt(e, floors))
        }}
        onPointerMove={(e) => {
          if (scrubbing.current) vl.jumpViewLockFloor(floorAt(e, floors))
        }}
        onPointerUp={() => {
          scrubbing.current = false
        }}
        onPointerCancel={() => {
          scrubbing.current = false
        }}
      >
        {ticks.map((f) => (
          <span key={f} className={`fg-tick${step > 1 ? ' major' : ''}`} style={{ bottom: `${(f / floors) * 100}%` }} />
        ))}
        {fire !== null && fire >= 1 && fire <= floors && (
          <span className="fg-fire" style={{ bottom: `${pct(fire)}%` }} />
        )}
        <span className="fg-now" style={{ bottom: `${pct(Math.min(viewLockFloor, floors))}%` }}>
          FL {viewLockFloor}
          {mbr > 0 ? ` · ${mbr}MBR` : ''}
        </span>
      </div>
      <div className="fg-cap">
        <b>FL 1</b>
        <i>GRADE</i>
      </div>
    </aside>
  )
}
