import { useMemo, useState } from 'react'
import { dispatchAssignment, flyToUnit, toggleGpsTracking, toggleMemberCrew, toggleUnitCategory } from '../actions'
import { useAppState } from '../state/store'
import { airMinutesLeft, crewOf, type Agency, type Unit, type UnitCategory } from '../types'

const AGENCY_ORDER: Agency[] = ['FDNY', 'EMS', 'NYPD', 'PAPD', 'OEM', 'TAK']

const CATEGORY_LABEL: Record<UnitCategory, string> = {
  engine: 'Engines',
  ladder: 'Ladders',
  battalion: 'Command',
  rescue: 'Rescue / Squad',
  ems: 'EMS',
  nypd: 'Patrol',
  esu: 'ESU',
  papd: 'PAPD',
  oem: 'OEM',
  drone: 'Drones',
  ff: 'Members',
  officer: 'Officers',
  medic: 'Medics',
  unknown: 'TAK Clients',
}

const CATEGORY_COLOR: Record<UnitCategory, string> = {
  engine: '#dc2626',
  ladder: '#dc2626',
  battalion: '#dc2626',
  rescue: '#7f1d1d',
  ems: '#1d4ed8',
  nypd: '#2563eb',
  esu: '#2563eb',
  papd: '#16a34a',
  oem: '#ea580c',
  drone: '#22d3ee',
  ff: '#ef4444',
  officer: '#3b82f6',
  medic: '#60a5fa',
  unknown: '#475569',
}

const STATUS_CLASS: Record<string, string> = {
  Enroute: 'enroute',
  'On Scene': 'onscene',
  Staged: 'staged',
  Operating: 'operating',
}

function callsignSortKey(cs: string): [string, number] {
  const m = cs.match(/^([A-Za-z]+)[- ]?(\d+)/)
  return m ? [m[1].toUpperCase(), Number(m[2])] : [cs.toUpperCase(), 0]
}

export function RosterPanel() {
  const { units, incident, takConnected, dispatching, gpsTracking } = useAppState()
  const [collapsed, setCollapsed] = useState(false)

  const grouped = useMemo(() => {
    const byAgency = new Map<Agency, Map<UnitCategory, Unit[]>>()
    for (const u of Object.values(units)) {
      if (!byAgency.has(u.agency)) byAgency.set(u.agency, new Map())
      const byCat = byAgency.get(u.agency)!
      if (!byCat.has(u.category)) byCat.set(u.category, [])
      byCat.get(u.category)!.push(u)
    }
    for (const byCat of byAgency.values()) {
      for (const list of byCat.values()) {
        list.sort((a, b) => {
          const [ap, an] = callsignSortKey(a.callsign)
          const [bp, bn] = callsignSortKey(b.callsign)
          return ap === bp ? an - bn : ap.localeCompare(bp)
        })
      }
    }
    return byAgency
  }, [units])

  const total = Object.keys(units).length

  return (
    <section className="roster-panel glass">
      <div className="roster-head">
        <button className="head-toggle" onClick={() => setCollapsed((c) => !c)} title={collapsed ? 'Expand' : 'Minimize'}>
          <span className="card-title">Units</span>
          <span className="roster-count">{total}</span>
          <span className={`chev${collapsed ? ' closed' : ''}`}>▾</span>
        </button>
        <button
          className={`gps-toggle${gpsTracking ? ' on' : ''}`}
          onClick={toggleGpsTracking}
          title="GPS unit tracking on the map. Policy: vehicles for all agencies; member GPS only for firefighters inside the building. Off = no unit dots."
        >
          ⦿ GPS {gpsTracking ? 'ON' : 'OFF'}
        </button>
        {incident && (
          <button
            className="dispatch-btn"
            disabled={dispatching || takConnected !== true}
            onClick={() => void dispatchAssignment()}
            title={takConnected !== true ? 'TAK link down' : 'Simulated first-alarm assignment'}
          >
            {dispatching ? 'DISPATCHING…' : 'DISPATCH ASSIGNMENT'}
          </button>
        )}
      </div>

      {!collapsed && total === 0 && (
        <div className="roster-empty">
          NO UNITS ON THE PICTURE
          {incident ? ' — DISPATCH THE ASSIGNMENT' : ' — STAND UP AN INCIDENT FIRST'}
        </div>
      )}

      {/* Collapsed = UNMOUNTED, not display:none — reconciling ~40 grouped
          rows on every units.batch while invisible was pure waste. */}
      {!collapsed && (
      <div className="roster-body">
        {AGENCY_ORDER.filter((a) => grouped.has(a)).map((agency) => {
          const byCat = grouped.get(agency)!
          const agencyUnits = [...byCat.values()].flat()
          const onScene = agencyUnits.filter((u) => u.status && u.status !== 'Enroute').length
          return (
            <div key={agency} className="roster-agency">
              <div className="agency-head">
                <b>{agency}</b>
                <span className="agency-counts">
                  {onScene}/{agencyUnits.length} ON SCENE
                </span>
              </div>
              {[...byCat.entries()].map(([cat, list]) => (
                <RosterGroup key={cat} category={cat} list={list} />
              ))}
            </div>
          )
        })}
      </div>
      )}
    </section>
  )
}

// Personnel categories render grouped BY CREW (E-6/1 under E-6) with a
// per-crew map toggle, so one company's members can be hidden at a time.
const CREW_GROUPED = new Set<UnitCategory>(['ff', 'officer', 'medic'])

/** SCBA chip for a member row: estimated air minutes, colored by pressure. */
function AirChip({ u }: { u: Unit }) {
  if (!u.bio || u.bio.airPsi < 0) return null
  const min = airMinutesLeft(u.bio)
  if (min === null) return null
  const tone = u.bio.airPsi <= 1100 ? 'low' : u.bio.airPsi <= 1800 ? 'warn' : 'ok'
  return (
    <span className={`air-chip ${tone}`} title={`SCBA ${Math.round(u.bio.airPsi)} psi · ~${Math.round(min)} min at this member's burn rate (SIMULATED)`}>
      ⏱ {Math.round(min)}m
    </span>
  )
}

function MemberRow({ u }: { u: Unit }) {
  return (
    <button className="unit-row member" onClick={() => flyToUnit(u.uid)}>
      <span className="unit-callsign">{u.callsign}</span>
      {(u.floor ?? 0) >= 1 && <span className="unit-alt">FL {u.floor}</span>}
      <AirChip u={u} />
      <span className={`status-chip ${u.status === 'Rehab' ? 'staged' : (STATUS_CLASS[u.status ?? ''] ?? 'unknown')}`}>
        {u.status ?? '—'}
      </span>
    </button>
  )
}

function CrewBlock({ crew, members }: { crew: string; members: Unit[] }) {
  const { memberCrewToggles } = useAppState()
  const visible = memberCrewToggles[crew] !== false
  const interior = members.filter((m) => (m.floor ?? 0) >= 1).length
  return (
    <div className="crew-block">
      <button
        className={`crew-head${visible ? '' : ' off'}`}
        onClick={() => toggleMemberCrew(crew)}
        title={visible ? `Hide ${crew}'s members on the globe` : `Show ${crew}'s members on the globe`}
      >
        <span className="crew-name">{crew} CREW</span>
        <span className="crew-counts">
          {interior > 0 ? `${interior} INT · ` : ''}
          {members.length}
        </span>
        <span className="eye">{visible ? '◉' : '◌'}</span>
      </button>
      {members.map((u) => (
        <MemberRow key={u.uid} u={u} />
      ))}
    </div>
  )
}

function RosterGroup({ category, list }: { category: UnitCategory; list: Unit[] }) {
  const { unitToggles } = useAppState()
  const visible = unitToggles[category]
  const crews = useMemo(() => {
    if (!CREW_GROUPED.has(category)) return null
    const map = new Map<string, Unit[]>()
    for (const u of list) {
      const crew = crewOf(u.callsign)
      if (!map.has(crew)) map.set(crew, [])
      map.get(crew)!.push(u)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
  }, [category, list])
  return (
    <div className="roster-group">
      <button
        className={`group-head${visible ? '' : ' off'}`}
        onClick={() => toggleUnitCategory(category)}
        title={visible ? 'Hide on globe' : 'Show on globe'}
      >
        <span className="cat-dot" style={{ background: CATEGORY_COLOR[category] }} />
        {CATEGORY_LABEL[category]}
        <span className="eye">{visible ? '◉' : '◌'}</span>
      </button>
      {crews
        ? crews.map(([crew, members]) => <CrewBlock key={crew} crew={crew} members={members} />)
        : list.map((u) => (
            <button key={u.uid} className="unit-row" onClick={() => flyToUnit(u.uid)}>
              <span className="unit-callsign">{u.callsign}</span>
              {u.category === 'drone' && u.hae > 5 && <span className="unit-alt">{Math.round(u.hae)} m</span>}
              <span className={`status-chip ${STATUS_CLASS[u.status ?? ''] ?? 'unknown'}`}>
                {u.status ?? '—'}
              </span>
            </button>
          ))}
    </div>
  )
}
