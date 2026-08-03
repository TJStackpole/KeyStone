import { setDashboardPage } from '../lib/layouts'
import { useCapability } from '../profiles/manifest'
import { useAppSlice } from '../state/store'

// ---------------------------------------------------------------------------
// The five FDNY command dashboards: tactical map, command board, riding
// list, decision log, resource ledger. Edge-swipe flips between them on a
// tablet; these tabs are the mouse/keyboard path. Pages 1-4 are plain-DOM
// fallbacks — the way a chief has always commanded, still there if the 3D
// view ever dies.
// ---------------------------------------------------------------------------

const PAGES: { id: 0 | 1 | 2 | 3 | 4; label: string; hint: string }[] = [
  { id: 0, label: 'MAP', hint: 'The 3D tactical picture' },
  { id: 1, label: 'BOARD', hint: 'Command board — tap units through ATTACK / SEARCH / VENT positions, the way the IC runs it' },
  { id: 2, label: 'RIDING LIST', hint: 'Riding lists + PAR — the paper board, digital. Works even if the map dies' },
  { id: 3, label: 'LOG', hint: 'Decision log — one-tap benchmarks and notes, ICS-214 style, printable' },
  { id: 4, label: 'RESOURCES', hint: 'Resource ledger — who is where, what the next alarm brings, which quarters sit empty' },
]

export function DashboardTabs() {
  const isFdny = useCapability('tactical.view-lock')
  const { page } = useAppSlice((s) => ({ page: s.dashboardPage }))
  if (!isFdny) return null
  return (
    <nav className="dash-tabs glass" aria-label="Manual dashboards — Map, Board, Riding List, Log, or Resources. Swipe from the screen edge or tap">
      <span className="dash-tabs-label" title="The fallback set — every page here works even if the 3D map dies">
        MANUAL
      </span>
      {PAGES.map((p) => (
        <button
          key={p.id}
          className={`dash-tab${page === p.id ? ' on' : ''}`}
          onClick={() => setDashboardPage(p.id)}
          title={p.hint}
        >
          {p.label}
        </button>
      ))}
    </nav>
  )
}
