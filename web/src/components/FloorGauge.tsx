import { useEffect, useRef, useState } from 'react'
import { useAppSlice } from '../state/store'

// ---------------------------------------------------------------------------
// HEIGHT GAUGE — while the ISOLATE lock looks at a facade (N/E/S/W), a slim
// vertical bar on the right edge reads HOW FAR OFF THE GROUND the view sits:
// 5 FT at the bottom, the full building at the top. Tap or drag anywhere on
// the track and the camera flies to that height, eye level, squared to the
// facade — the floor highlight (and member count) follow whatever storey
// that height lands on. Hidden for TOP (plan view) and when the lock is off.
// ---------------------------------------------------------------------------

type ViewLockApi = typeof import('../cesium/viewLock')

const SIDES = new Set(['north', 'east', 'south', 'west'])

const FT = 3.28084

/** Height under the pointer — the track maps bottom→minM, top→maxM. */
function heightAt(e: React.PointerEvent<HTMLDivElement>, minM: number, maxM: number): number {
  const r = e.currentTarget.getBoundingClientRect()
  const frac = 1 - (e.clientY - r.top) / r.height
  return minM + Math.max(0, Math.min(1, frac)) * (maxM - minM)
}

export function FloorGauge() {
  const { viewLock, viewLockFloor, viewLockHeightM, units } = useAppSlice((s) => ({
    viewLock: s.viewLock,
    viewLockFloor: s.viewLockFloor,
    viewLockHeightM: s.viewLockHeightM,
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

  const { minM, maxM, storeyM, floors, fireFloor } = vl.viewLockGaugeInfo()
  const span = Math.max(0.1, maxM - minM)
  const pct = (m: number) => Math.max(0, Math.min(100, ((m - minM) / span) * 100))
  const hM = Math.max(minM, Math.min(maxM, viewLockHeightM))
  const mbr = Object.values(units).filter(
    (u) => (u.category === 'ff' || u.category === 'officer') && (u.floor ?? 0) === viewLockFloor,
  ).length
  // Graduations at floor boundaries (storey ladder); thin out on towers.
  const step = floors > 36 ? 5 : 1
  const ticks: number[] = []
  for (let f = step; f < floors; f += step) ticks.push(f * storeyM)

  return (
    <aside className="floor-gauge" aria-label="Eye height above the ground — 5 feet up to the full building">
      <div className="fg-cap">
        <b>{Math.round(maxM * FT)} FT</b>
        <i>ROOF</i>
      </div>
      <div
        className="fg-track"
        title="How far off the ground the view sits — 5 FT minimum up to the full building. Tap or drag and the camera flies to that height, eye level with the facade (↑↓ still steps whole floors)."
        onPointerDown={(e) => {
          scrubbing.current = true
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            // capture is an assist, not a requirement — scrub still works
          }
          vl.setViewLockHeightM(heightAt(e, minM, maxM))
        }}
        onPointerMove={(e) => {
          // buttons check: if the press ended off-element without capture,
          // a hover must not keep flying the camera around.
          if (scrubbing.current && e.buttons !== 0) vl.setViewLockHeightM(heightAt(e, minM, maxM))
        }}
        onPointerUp={() => {
          scrubbing.current = false
        }}
        onPointerCancel={() => {
          scrubbing.current = false
        }}
      >
        {ticks.map((m) => (
          <span key={m} className={`fg-tick${step > 1 ? ' major' : ''}`} style={{ bottom: `${pct(m)}%` }} />
        ))}
        {fireFloor !== null && fireFloor >= 1 && fireFloor <= floors && (
          <span className="fg-fire" style={{ bottom: `${pct((fireFloor - 0.5) * storeyM)}%` }} />
        )}
        <span className="fg-now" style={{ bottom: `${pct(hM)}%` }}>
          <b>{Math.round(hM * FT)} FT</b>
          <i>
            FL {viewLockFloor}
            {mbr > 0 ? ` · ${mbr}MBR` : ''}
          </i>
        </span>
      </div>
      <div className="fg-cap">
        <b>5 FT</b>
        <i>GRADE</i>
      </div>
    </aside>
  )
}
