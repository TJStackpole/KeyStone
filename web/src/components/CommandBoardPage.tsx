import { alarmLabel } from '../lib/alarms'
import { fmtElapsed } from '../lib/time'
import { useEffect, useMemo, useState } from 'react'
import { setDashboardPage } from '../lib/layouts'
import { setAppState, useAppSlice } from '../state/store'
import { edgeClassFor, isApparatus } from '../lib/crews'
import type { Unit } from '../types'
import './CommandBoardPage.css'

// ---------------------------------------------------------------------------
// ELECTRONIC COMMAND BOARD — dashboard page 1. Plain DOM on purpose: zero
// Cesium imports, glove-sized targets, keeps working if the 3D view dies.
// Tap a tile to advance it pool → COMMAND → … → REHAB → back to pool.
// ---------------------------------------------------------------------------

/** Operational positions, in tap-advance order. The strings ARE the position
 *  ids stored in boardAssignments (uid -> position). */
const POSITIONS: readonly string[] = ['COMMAND', 'ATTACK', 'SEARCH', 'VENT', 'WATER', 'FAST/RIC', 'STAGING', 'REHAB']



function callsignKey(cs: string): string {
  const m = cs.match(/^([A-Za-z]+)[- ]?(\d+)/)
  return m ? `${m[1].toUpperCase()}-${m[2].padStart(4, '0')}` : cs.toUpperCase()
}

/** Every assignment change goes through here: store + localStorage together. */
function saveAssignments(next: Record<string, string>): void {
  setAppState({ boardAssignments: next })
  try {
    localStorage.setItem('ks-board', JSON.stringify(next))
  } catch {
    // storage blocked — board still works this session
  }
}

function assign(assignments: Record<string, string>, uid: string, pos: string | null): void {
  const next = { ...assignments }
  if (pos === null) delete next[uid]
  else next[uid] = pos
  saveAssignments(next)
}

function advance(assignments: Record<string, string>, uid: string): void {
  const cur = assignments[uid]
  const idx = cur === undefined ? -1 : POSITIONS.indexOf(cur)
  // Past REHAB (or an unknown stale id at the end) → back to the pool.
  assign(assignments, uid, idx >= POSITIONS.length - 1 ? null : POSITIONS[idx + 1])
}

function readDraggedUid(e: React.DragEvent): string {
  return e.dataTransfer.getData('text/plain')
}

function UnitTile({ unit, assignments }: { unit: Unit; assignments: Record<string, string> }) {
  const assigned = assignments[unit.uid] !== undefined
  const cls = [
    'cb-tile',
    edgeClassFor(unit.category),
    unit.agency !== 'FDNY' ? 'dim' : '',
  ].join(' ')
  return (
    <div
      className={cls}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/plain', unit.uid)}
      onClick={() => advance(assignments, unit.uid)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') advance(assignments, unit.uid)
      }}
      title={assigned ? 'Tap: next position (wraps back to the pool after REHAB) · ✕: straight back to the pool' : 'Tap: assign to COMMAND'}
    >
      <span className="cb-callsign">{unit.callsign}</span>
      <span className="cb-status">{unit.status ?? '—'}</span>
      {assigned && (
        <button
          className="cb-clear"
          aria-label={`Unassign ${unit.callsign}`}
          onClick={(e) => {
            e.stopPropagation()
            assign(assignments, unit.uid, null)
          }}
        >
          ✕
        </button>
      )}
    </div>
  )
}

export function CommandBoardPage() {
  const { page, incident, units, assignments, timeline } = useAppSlice((s) => ({
    page: s.dashboardPage,
    incident: s.incident,
    units: s.units,
    assignments: s.boardAssignments,
    timeline: s.timeline,
  }))

  // T+ zero: the incident.created timeline event, else the incident record.
  const startMs = useMemo(() => {
    const iso = timeline.find((e) => e.kind === 'incident.created')?.t ?? incident?.createdAt
    const ms = iso ? Date.parse(iso) : NaN
    return Number.isFinite(ms) ? ms : null
  }, [timeline, incident])

  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (page !== 1 || startMs === null) return
    setNowMs(Date.now())
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [page, startMs])

  if (page !== 1) return null

  const all = Object.values(units)
  const pool = all
    .filter((u) => isApparatus(u) && assignments[u.uid] === undefined)
    .sort((a, b) => {
      const fa = a.agency === 'FDNY' ? 0 : 1
      const fb = b.agency === 'FDNY' ? 0 : 1
      return fa - fb || callsignKey(a.callsign).localeCompare(callsignKey(b.callsign))
    })

  const byPos = new Map<string, Unit[]>()
  for (const u of all) {
    const pos = assignments[u.uid]
    if (pos === undefined) continue
    byPos.set(pos, [...(byPos.get(pos) ?? []), u])
  }
  for (const list of byPos.values()) list.sort((a, b) => callsignKey(a.callsign).localeCompare(callsignKey(b.callsign)))

  return (
    <div className="cmdboard-page">
      <header className="cb-header">
        <button className="cb-map-btn" onClick={() => setDashboardPage(0)}>
          ◀ MAP
        </button>
        <div className="cb-title">
          <span className="cb-eyebrow">ELECTRONIC COMMAND BOARD</span>
          <span className="cb-address">{incident ? incident.address : 'NO ACTIVE INCIDENT — board still works standalone'}</span>
        </div>
        {incident?.type && <span className="cb-chip">{incident.type}</span>}
        {incident?.alarmLevel && <span className="cb-chip amber">{alarmLabel(incident.alarmLevel)}</span>}
        <div className="cb-clock" aria-label="Elapsed since incident created">
          <span className="cb-clock-label">T+</span>
          <span className="cb-clock-val">{startMs === null ? '--:--' : fmtElapsed(nowMs - startMs)}</span>
        </div>
      </header>

      <section
        className="cb-pool"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const uid = readDraggedUid(e)
          if (uid) assign(assignments, uid, null)
        }}
      >
        <span className="cb-pool-label">UNASSIGNED</span>
        <div className="cb-pool-tiles">
          {pool.length === 0 && <span className="cb-empty">No unassigned apparatus</span>}
          {pool.map((u) => (
            <UnitTile key={u.uid} unit={u} assignments={assignments} />
          ))}
        </div>
      </section>

      <section className="cb-grid">
        {POSITIONS.map((pos) => (
          <div
            key={pos}
            className={`cb-col pos-${pos.toLowerCase().replace(/[^a-z]+/g, '-')}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const uid = readDraggedUid(e)
              if (uid) assign(assignments, uid, pos)
            }}
          >
            <div className="cb-col-head">{pos}</div>
            <div className="cb-col-tiles">
              {(byPos.get(pos) ?? []).map((u) => (
                <UnitTile key={u.uid} unit={u} assignments={assignments} />
              ))}
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}
