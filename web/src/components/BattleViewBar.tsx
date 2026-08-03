import { useEffect } from 'react'
import { battleFireFloor, jumpViewLockFloor, setViewLockMode, setViewLockSuspended, stepViewLockFloor, viewLockFloors } from '../cesium/viewLock'
import { useMovable } from '../lib/movable'
import { useAppSlice } from '../state/store'

// ---------------------------------------------------------------------------
// FDNY battle-view rail — the ONLY camera controls during an active
// incident. Big targets, one keystroke each, zero free-camera chaos:
//   TOP          straight-down command view (T)
//   N / E / S / W facade views (N/E/S/W keys)
//   ▲ / ▼        floor stepping in a facade view (arrow keys)
// The rail renders only while the lock is engaged, so it never adds chrome
// outside an incident.
// ---------------------------------------------------------------------------

const SIDES = [
  { id: 'north' as const, label: 'N', key: 'n' },
  { id: 'east' as const, label: 'E', key: 'e' },
  { id: 'south' as const, label: 'S', key: 's' },
  { id: 'west' as const, label: 'W', key: 'w' },
]

export function BattleViewBar() {
  const mvBattle = useMovable('battle-view')
  // floors/fireFloor are computed via viewLockFloors()/battleFireFloor(),
  // which read store fields directly — every input is mirrored here so the
  // readout re-renders the moment one changes (not on the next units tick).
  const { viewLock, viewLockFloor, units, suspended } = useAppSlice((s) => ({
    suspended: s.viewLockSuspended,
    viewLock: s.viewLock,
    viewLockFloor: s.viewLockFloor,
    units: s.units,
    plutoFloors: s.intel.pluto?.numFloors ?? null,
    isolateFloors: s.isolateFloors,
    isolateScale: s.isolateScale,
    isolateView: s.isolateView,
    targetHeightM: s.targetHeightM,
    timelineLen: s.timeline.length,
  }))

  // One-keystroke view control — chaos-proof. Never steals typing.
  useEffect(() => {
    if (viewLock === 'off') return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 't') setViewLockMode('top')
      else if (k === 'n') setViewLockMode('north')
      else if (k === 'e') setViewLockMode('east')
      else if (k === 's') setViewLockMode('south')
      else if (k === 'w') setViewLockMode('west')
      else if (e.key === 'ArrowUp') {
        e.preventDefault()
        stepViewLockFloor(1)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        stepViewLockFloor(-1)
      } else return
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewLock])

  if (viewLock === 'off') return null
  const sideMode = viewLock !== 'top'
  const planMode = viewLock === 'top'
  const floors = viewLockFloors()
  const fireFloor = battleFireFloor()
  const onFloor = sideMode
    ? Object.values(units).filter(
        (u) => (u.category === 'ff' || u.category === 'officer') && (u.floor ?? 0) === viewLockFloor,
      ).length
    : 0

  return (
    <aside {...mvBattle} className="battle-view glass">
      <button
        className={`bv-lock${suspended ? ' free' : ''}`}
        onClick={() => setViewLockSuspended(!suspended)}
        title={
          suspended
            ? 'Camera is FREE — click to lock back into the disciplined view'
            : 'Camera is LOCKED to disciplined views — click to move around freely (the rail stays)'
        }
      >
        {suspended ? '🔓 FREE' : '🔒 LOCKED'}
      </button>
      <button
        className={`bv-btn${viewLock === 'top' ? ' on' : ''}`}
        onClick={() => setViewLockMode('top')}
        title="Straight-down command view, north up — zoom to scale (T)"
      >
        TOP
      </button>
      <div className="bv-sides">
        {SIDES.map((s) => (
          <button
            key={s.id}
            className={`bv-btn side${viewLock === s.id ? ' on' : ''}`}
            onClick={() => setViewLockMode(s.id)}
            title={`Head-on view of the structure's ${s.id.toUpperCase()}-facing side — ↑↓ highlights floors (${s.key.toUpperCase()})`}
          >
            {s.label}
          </button>
        ))}
      </div>
      {(sideMode || planMode) && (
        <div className="bv-floor">
          <button
            className="bv-btn"
            disabled={viewLockFloor >= floors}
            onClick={() => stepViewLockFloor(1)}
            title="Track floor up — highlights it on the structure (↑)"
          >
            ▲
          </button>
          <div className="bv-floor-readout" title={`${onFloor} tracked member${onFloor === 1 ? '' : 's'} on this floor`}>
            <b>{planMode ? 'PLAN ' : ''}FL {viewLockFloor}</b>
            <i>
              {onFloor > 0 ? `${onFloor} MBR` : '—'} · {floors} FL
            </i>
          </div>
          <button
            className="bv-btn"
            disabled={viewLockFloor <= 1}
            onClick={() => stepViewLockFloor(-1)}
            title="Track floor down — highlights it on the structure (↓)"
          >
            ▼
          </button>
          {fireFloor !== null && fireFloor !== viewLockFloor && (
            <button
              className="bv-btn bv-fire"
              onClick={() => jumpViewLockFloor(fireFloor)}
              title={`Jump back to the fire floor (FL ${fireFloor})`}
            >
              ◎ FIRE FL {fireFloor}
            </button>
          )}
        </div>
      )}
      <div className="bv-hints" title="Keyboard: T top · N/E/S/W sides · ↑↓ floors · scroll zooms">
        T·N·E·S·W&ensp;↑↓ FL
      </div>
    </aside>
  )
}
