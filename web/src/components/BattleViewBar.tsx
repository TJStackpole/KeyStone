import { useEffect } from 'react'
import { setViewLockMode, stepViewLockFloor, viewLockFloors } from '../cesium/viewLock'
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
  const { viewLock, viewLockFloor, units } = useAppSlice((s) => ({
    viewLock: s.viewLock,
    viewLockFloor: s.viewLockFloor,
    units: s.units,
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
      else if (e.key === 'ArrowUp' && viewLock !== 'top') {
        e.preventDefault()
        stepViewLockFloor(1)
      } else if (e.key === 'ArrowDown' && viewLock !== 'top') {
        e.preventDefault()
        stepViewLockFloor(-1)
      } else return
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewLock])

  if (viewLock === 'off') return null
  const sideMode = viewLock !== 'top'
  const floors = viewLockFloors()
  const onFloor = sideMode
    ? Object.values(units).filter(
        (u) => (u.category === 'ff' || u.category === 'officer') && (u.floor ?? 0) === viewLockFloor,
      ).length
    : 0

  return (
    <aside {...mvBattle} className="battle-view glass">
      <div className="bv-title" title="Camera is locked to disciplined incident views — zoom stays live everywhere">
        VIEW LOCK
      </div>
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
            title={`${s.id.toUpperCase()} side of the building — floor-by-floor battle tracking (${s.key.toUpperCase()})`}
          >
            {s.label}
          </button>
        ))}
      </div>
      {sideMode && (
        <div className="bv-floor">
          <button
            className="bv-btn"
            disabled={viewLockFloor >= floors}
            onClick={() => stepViewLockFloor(1)}
            title="Floor up (↑)"
          >
            ▲
          </button>
          <div className="bv-floor-readout" title={`${onFloor} tracked member${onFloor === 1 ? '' : 's'} on this floor`}>
            <b>FL {viewLockFloor}</b>
            <i>
              {onFloor > 0 ? `${onFloor} MBR` : '—'} · {floors} FL
            </i>
          </div>
          <button
            className="bv-btn"
            disabled={viewLockFloor <= 1}
            onClick={() => stepViewLockFloor(-1)}
            title="Floor down (↓)"
          >
            ▼
          </button>
        </div>
      )}
    </aside>
  )
}
