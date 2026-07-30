import { useMemo, useState } from 'react'
import { dispatchAssignment, flyToUnit, toggleUnitCategory } from '../actions'
import { useAppState } from '../state/store'
import type { Agency, Unit, UnitCategory } from '../types'

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
  const { units, incident, takConnected, dispatching } = useAppState()
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

      <div className="roster-body" style={collapsed ? { display: 'none' } : undefined}>
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
    </section>
  )
}

function RosterGroup({ category, list }: { category: UnitCategory; list: Unit[] }) {
  const { unitToggles } = useAppState()
  const visible = unitToggles[category]
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
      {list.map((u) => (
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
