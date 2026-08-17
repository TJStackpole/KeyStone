import { useEffect, useState } from 'react'
import { setDashboardPage } from '../lib/layouts'
import { maydayOnRecord, parState } from '../lib/vitals'
import { useCapability } from '../profiles/manifest'
import { useAppSlice } from '../state/store'

// ---------------------------------------------------------------------------
// The five FDNY command dashboards: tactical map, command board, riding
// list, decision log, resource ledger. Edge-swipe flips between them on a
// tablet; these tabs are the mouse/keyboard path. Pages 1-4 are plain-DOM
// fallbacks — the way a chief has always commanded, still there if the 3D
// view ever dies. Attention dots pull the eye where discipline is slipping:
// RIDING LIST when the PAR window lapses, LOG when a MAYDAY is on record.
// ---------------------------------------------------------------------------

const PAGES: { id: 0 | 1 | 2 | 3 | 4 | 5; label: string; hint: string }[] = [
  { id: 0, label: 'MAP', hint: 'The 3D tactical picture' },
  { id: 1, label: 'BOARD', hint: 'Command board — tap units through ATTACK / SEARCH / VENT positions, the way the IC runs it' },
  { id: 2, label: 'RIDING LIST', hint: 'Riding lists + PAR — the paper board, digital. Works even if the map dies' },
  { id: 3, label: 'LOG', hint: 'Decision log — one-tap benchmarks and notes, ICS-214 style, printable' },
  { id: 5, label: 'DISPATCH', hint: 'Dispatch comms — the SIMULATED FDNY + EMS dispatch audio for the active box, generated from the live assignment' },
  { id: 4, label: 'RESOURCES', hint: 'Resource ledger — who is where, what the next alarm brings, which quarters sit empty' },
]

export function DashboardTabs() {
  const isFdny = useCapability('tactical.view-lock')
  const { page, incident, timeline, parIntervalMin } = useAppSlice((s) => ({
    page: s.dashboardPage,
    incident: s.incident,
    timeline: s.timeline,
    parIntervalMin: s.parIntervalMin,
  }))
  void parIntervalMin // subscribed so an interval change re-evaluates the dot
  // 30s tick keeps the PAR dot honest without store traffic.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!incident) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [incident])
  if (!isFdny) return null

  const parLapsed = incident !== null && (parState(timeline, incident, now)?.lapsed ?? false)
  const mayday = incident !== null && maydayOnRecord(timeline) !== null
  const dotFor = (id: number): string | null => {
    if (id === 2 && parLapsed) return 'PAR window lapsed — take a PAR on the RIDING LIST'
    if (id === 3 && mayday) return 'MAYDAY on the incident record — see the LOG'
    return null
  }

  return (
    <nav className="dash-tabs glass" aria-label="Manual dashboards — Map, Board, Riding List, Log, or Resources. Swipe from the screen edge or tap">
      <span className="dash-tabs-label" title="The fallback set — every page here works even if the 3D map dies">
        MANUAL
      </span>
      {PAGES.map((p) => {
        const dot = dotFor(p.id)
        return (
          <button
            key={p.id}
            className={`dash-tab${page === p.id ? ' on' : ''}`}
            onClick={() => setDashboardPage(p.id)}
            title={dot ?? p.hint}
          >
            {p.label}
            {dot && <span className="tab-dot" aria-label={dot} />}
          </button>
        )
      })}
    </nav>
  )
}
