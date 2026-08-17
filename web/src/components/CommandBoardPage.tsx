import { alarmLabel } from '../lib/alarms'
import { fmtElapsed } from '../lib/time'
import { useEffect, useMemo, useRef, useState } from 'react'
import { setDashboardPage } from '../lib/layouts'
import { setAppState, useAppSlice } from '../state/store'
import { edgeClassFor, isApparatus } from '../lib/crews'
import { CommandVitals } from './CommandVitals'
import type { Unit } from '../types'
import './CommandBoardPage.css'

// ---------------------------------------------------------------------------
// ELECTRONIC COMMAND BOARD — dashboard page 1, laid out like the paper-and-
// magnet board a chief actually works: the responding roster down the left
// (crossed out as units engage) and the FIRE BUILDING side-profile on the
// right — drag a unit tile anywhere on the diagram (a floor, the fire ground,
// off a flank) and drag it around as the operation moves. The ICS position
// strip below keeps the COMMAND/ATTACK/… assignments that feed PAR, the
// ledger, and the AAR. Plain DOM on purpose: zero Cesium imports, glove-sized
// targets, keeps working if the 3D view dies.
// ---------------------------------------------------------------------------

/** Operational positions, in tap-advance order. The strings ARE the position
 *  ids stored in boardAssignments (uid -> position). */
const POSITIONS: readonly string[] = ['COMMAND', 'ATTACK', 'SEARCH', 'VENT', 'WATER', 'FAST/RIC', 'STAGING', 'REHAB']

type XY = { x: number; y: number }

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

/** Diagram placements (uid -> normalized {x,y}) — store + localStorage. */
function savePlacements(next: Record<string, XY>): void {
  setAppState({ boardPlacements: next })
  try {
    localStorage.setItem('ks-board-xy', JSON.stringify(next))
  } catch {
    // storage blocked — placements still work this session
  }
}

function placeUnit(placements: Record<string, XY>, uid: string, xy: XY | null): void {
  const next = { ...placements }
  if (xy === null) delete next[uid]
  else next[uid] = xy
  savePlacements(next)
}

function readDraggedUid(e: React.DragEvent): string {
  return e.dataTransfer.getData('text/plain')
}

function UnitTile({ unit, assignments, struck }: { unit: Unit; assignments: Record<string, string>; struck?: boolean }) {
  const assigned = assignments[unit.uid] !== undefined
  const cls = ['cb-tile', edgeClassFor(unit.category), unit.agency !== 'FDNY' ? 'dim' : '', struck ? 'cb-struck' : ''].join(' ')
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
      title={
        assigned
          ? 'Tap: next position (wraps back to the pool after REHAB) · drag onto the building to place · ✕: straight back to the pool'
          : 'Drag onto the building diagram to place · tap: assign to COMMAND'
      }
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

/** The fire building, side profile — roof, floor bands, fire ground line.
 *  Drop a unit tile anywhere on it; chips re-drag freely, exactly like
 *  magnets on the physical board. */
function BuildingDiagram({
  units,
  placements,
  floors,
  fireFloor,
}: {
  units: Record<string, Unit>
  placements: Record<string, XY>
  floors: number
  fireFloor: number | null
}) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const bands = Math.max(1, Math.min(14, floors))
  // Building box in viewBox coords: x 18..82, floors y 13..87, ground 91.5.
  const TOP = 13
  const BOT = 87
  const bandH = (BOT - TOP) / bands
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const uid = readDraggedUid(e)
    const box = boxRef.current
    if (!uid || !box || !units[uid]) return // only real rigs — not stray text drags
    const r = box.getBoundingClientRect()
    const x = Math.min(0.96, Math.max(0.04, (e.clientX - r.left) / r.width))
    const y = Math.min(0.95, Math.max(0.03, (e.clientY - r.top) / r.height))
    placeUnit(placements, uid, { x, y })
  }
  const placed = Object.entries(placements)
    .map(([uid, xy]) => ({ unit: units[uid], xy }))
    .filter((p): p is { unit: Unit; xy: XY } => !!p.unit)
  return (
    <div ref={boxRef} className="cb-diagram" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {/* roof */}
        <polygon points={`18,${TOP} 50,3 82,${TOP}`} className="cb-bldg-line" />
        {/* floor bands, FL 1 at the bottom */}
        {Array.from({ length: bands }, (_, i) => {
          const fl = bands - i
          const y = TOP + i * bandH
          return (
            <rect
              key={fl}
              x="18"
              y={y}
              width="64"
              height={bandH}
              className={`cb-bldg-line${fireFloor === fl ? ' cb-fire-band' : ''}`}
            />
          )
        })}
        {/* fire ground */}
        <line x1="6" y1="91.5" x2="94" y2="91.5" className="cb-ground-line" />
      </svg>
      {/* floor labels (skip crowded towers) */}
      {Array.from({ length: bands }, (_, i) => {
        const fl = bands - i
        if (bands > 9 && fl % 2 === 0 && fl !== fireFloor) return null
        return (
          <span
            key={fl}
            className={`cb-fl-label${fireFloor === fl ? ' fire' : ''}`}
            style={{ top: `${TOP + (i + 0.5) * bandH}%` }}
          >
            {fireFloor === fl ? `◎ FL ${fl}` : `FL ${fl}`}
          </span>
        )
      })}
      <span className="cb-fireground-label">FIRE GROUND</span>
      {placed.length === 0 && <span className="cb-diagram-hint">DRAG UNITS FROM THE ROSTER ONTO THE BUILDING</span>}
      {placed.map(({ unit, xy }) => (
        <div
          key={unit.uid}
          className={`cb-unit-chip ${edgeClassFor(unit.category)}`}
          style={{ left: `${xy.x * 100}%`, top: `${xy.y * 100}%` }}
          draggable
          onDragStart={(e) => e.dataTransfer.setData('text/plain', unit.uid)}
          title={`${unit.callsign} — drag to move · drop on the roster to take it off the board · ✕ removes`}
        >
          {unit.callsign}
          <button
            className="cb-chip-clear"
            aria-label={`Remove ${unit.callsign} from the diagram`}
            onClick={(e) => {
              e.stopPropagation()
              placeUnit(placements, unit.uid, null)
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

const FIRE_COLS: { label: string; match: (u: Unit) => boolean }[] = [
  { label: 'ENGINE', match: (u) => u.category === 'engine' },
  { label: 'LADDER', match: (u) => u.category === 'ladder' },
  { label: 'CHIEF · SP', match: (u) => u.agency === 'FDNY' && !['engine', 'ladder', 'ems'].includes(u.category) },
]

const OTHER_COLS: { label: string; match: (u: Unit) => boolean }[] = [
  { label: 'EMS', match: (u) => u.category === 'ems' },
  { label: 'NYPD', match: (u) => u.agency === 'NYPD' },
  { label: 'OTHER', match: (u) => u.category !== 'ems' && u.agency !== 'NYPD' && u.agency !== 'FDNY' },
]

export function CommandBoardPage() {
  const { page, incident, units, assignments, placements, timeline, pluto, targetHeightM } = useAppSlice((s) => ({
    page: s.dashboardPage,
    incident: s.incident,
    units: s.units,
    assignments: s.boardAssignments,
    placements: s.boardPlacements,
    timeline: s.timeline,
    pluto: s.intel.pluto,
    targetHeightM: s.targetHeightM,
  }))
  const [tab, setTab] = useState<'fire' | 'other'>('fire')

  // T+ zero: the incident.created timeline event, else the incident record.
  const startMs = useMemo(() => {
    const iso = timeline.find((e) => e.kind === 'incident.created')?.t ?? incident?.createdAt
    const ms = iso ? Date.parse(iso) : NaN
    return Number.isFinite(ms) ? ms : null
  }, [timeline, incident])

  // Fire floor: the scripted floor when the sim announced one for THIS box.
  const fireFloor = useMemo(() => {
    for (let i = timeline.length - 1; i >= 0; i--) {
      if (timeline[i].kind !== 'sim.dispatched') continue
      const p = (timeline[i].payload ?? {}) as { fireFloor?: number; incidentId?: string }
      if (p.incidentId && incident && p.incidentId !== incident.id) return null
      if (p.fireFloor) return p.fireFloor
    }
    return null
  }, [timeline, incident])

  const floors = pluto?.numFloors ?? (targetHeightM ? Math.max(1, Math.round(targetHeightM / 3.2)) : 4)

  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (page !== 1 || startMs === null) return
    setNowMs(Date.now())
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [page, startMs])

  if (page !== 1) return null

  const all = Object.values(units).filter(isApparatus)
  const sortCs = (a: Unit, b: Unit) => callsignKey(a.callsign).localeCompare(callsignKey(b.callsign))
  const cols = (tab === 'fire' ? FIRE_COLS : OTHER_COLS).map((c) => ({
    label: c.label,
    list: all.filter(c.match).sort(sortCs),
  }))
  const otherCount = all.filter((u) => OTHER_COLS.some((c) => c.match(u))).length

  const byPos = new Map<string, Unit[]>()
  for (const u of all) {
    const pos = assignments[u.uid]
    if (pos === undefined) continue
    byPos.set(pos, [...(byPos.get(pos) ?? []), u])
  }
  for (const list of byPos.values()) list.sort(sortCs)

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
      <CommandVitals />

      <div className="cb-body">
        <aside
          className="cb-roster"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            // Dropping anything back on the roster = clean slate for that rig:
            // off the diagram AND out of the position strip.
            const uid = readDraggedUid(e)
            if (!uid) return
            assign(assignments, uid, null)
            placeUnit(placements, uid, null)
          }}
        >
          <div className="cb-roster-head">
            <b>
              {incident?.alarmLevel ? alarmLabel(incident.alarmLevel) : 'RESPONSE'} — {incident?.type ?? 'STANDBY'}
            </b>
            <i>{startMs !== null ? new Date(startMs).toLocaleString() : 'no box'} · {all.length} APPARATUS</i>
          </div>
          <div className="cb-roster-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'fire'} className={tab === 'fire' ? 'on' : ''} onClick={() => setTab('fire')}>
              FIRE
            </button>
            <button role="tab" aria-selected={tab === 'other'} className={tab === 'other' ? 'on' : ''} onClick={() => setTab('other')}>
              EMS · OTHER{otherCount > 0 ? ` (${otherCount})` : ''}
            </button>
          </div>
          <div className="cb-roster-cols">
            {cols.map((c) => (
              <div key={c.label} className="cb-roster-col">
                <div className="cb-roster-col-head">{c.label}</div>
                {c.list.length === 0 && <span className="cb-empty">—</span>}
                {c.list.map((u) => (
                  <UnitTile key={u.uid} unit={u} assignments={assignments} struck={placements[u.uid] !== undefined || assignments[u.uid] !== undefined} />
                ))}
              </div>
            ))}
          </div>
          <div className="cb-roster-hint">DRAG ONTO THE BUILDING · DROP BACK HERE TO CLEAR · TAP CYCLES ICS POSITIONS</div>
        </aside>

        <main className="cb-stage">
          <BuildingDiagram units={units} placements={placements} floors={floors} fireFloor={fireFloor} />
          <section className="cb-grid strip">
            {POSITIONS.map((pos) => (
              <div
                key={pos}
                className={`cb-col pos-${pos.toLowerCase().replace(/[^a-z]+/g, '-')}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  const uid = readDraggedUid(e)
                  if (uid && units[uid]) assign(assignments, uid, pos)
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
        </main>
      </div>
    </div>
  )
}
