import { notify } from '../components/NoticeChip'
import { getAppState, setAppState } from '../state/store'

// ---------------------------------------------------------------------------
// Role layout presets: one press (or an edge swipe on a tablet) arranges the
// whole board for a role by minimizing the boxes that role doesn't watch.
// Presets only touch the minimize map — drag offsets reset so every box is
// back at its trained position. KeyStone runs on iPads and ATAK phones as
// well as command-post laptops; a finger swipe from the screen's left/right
// edge cycles these like dashboard pages.
// ---------------------------------------------------------------------------

export interface LayoutPreset {
  key: string
  label: string
  hint: string
  /** Panel ids collapsed to header-only in this layout. */
  minimized: string[]
}

export const LAYOUT_PRESETS: LayoutPreset[] = [
  { key: 'ic', label: 'IC', hint: 'Incident Commander — everything open', minimized: [] },
  {
    key: 'ops',
    label: 'OPS',
    hint: 'Operations — roster + structure views forward; comms/manuals tucked',
    minimized: ['comms', 'takchat', 'manuals', 'tactics', 'wind', 'feed-health', 'streetview', 'aar'],
  },
  {
    key: 'planning',
    label: 'PLAN',
    hint: 'Planning — intel and comms forward; tactical rails tucked',
    minimized: ['roster', 'battle-view', 'draw-toolbar', 'takchat', 'streetview'],
  },
  {
    key: 'wall',
    label: 'WALL',
    hint: 'Wall display — map + incident header only, everything else tucked',
    minimized: [
      'roster', 'comms', 'takchat', 'manuals', 'tactics', 'wind', 'feed-health', 'streetview',
      'aar', 'draw-toolbar', 'utility-dock', 'agency-req', 'policy-editor',
    ],
  },
]

export function applyLayoutPreset(key: string): void {
  const preset = LAYOUT_PRESETS.find((p) => p.key === key)
  if (!preset) return
  const minimized = Object.fromEntries(preset.minimized.map((id) => [id, true]))
  try {
    localStorage.setItem('ks-panel-min', JSON.stringify(minimized))
    localStorage.setItem('ks-panel-offsets', '{}')
  } catch {
    // storage blocked — layout still applies this session
  }
  setAppState({ panelMinimized: minimized, panelOffsets: {}, layoutPreset: key })
  notify(`LAYOUT · ${preset.label} — ${preset.hint}`)
}

const DASHBOARD_NAMES = ['TACTICAL MAP', 'COMMAND BOARD', 'RIDING LISTS'] as const

export function setDashboardPage(page: 0 | 1 | 2): void {
  if (getAppState().dashboardPage === page) return
  setAppState({ dashboardPage: page })
  notify(`DASHBOARD · ${DASHBOARD_NAMES[page]}`)
}

export function cycleDashboardPage(dir: 1 | -1): void {
  const next = ((getAppState().dashboardPage + dir + 3) % 3) as 0 | 1 | 2
  setDashboardPage(next)
}

export function cycleLayoutPreset(dir: 1 | -1): void {
  const current = getAppState().layoutPreset
  const idx = LAYOUT_PRESETS.findIndex((p) => p.key === current)
  const next = LAYOUT_PRESETS[(idx + dir + LAYOUT_PRESETS.length) % LAYOUT_PRESETS.length]
  applyLayoutPreset(next.key)
}

/**
 * Tablet/phone: a fast horizontal swipe STARTING at the screen's left or
 * right edge cycles layouts like dashboard pages. Edge-start keeps it out of
 * the map's own pan/zoom gestures. Returns a detach fn.
 */
export function attachLayoutSwipe(): () => void {
  const EDGE_PX = 28
  const MIN_DX = 64
  const MAX_DY = 60
  const MAX_MS = 650
  let start: { x: number; y: number; t: number } | null = null

  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) {
      start = null
      return
    }
    const t = e.touches[0]
    const nearEdge = t.clientX <= EDGE_PX || t.clientX >= window.innerWidth - EDGE_PX
    start = nearEdge ? { x: t.clientX, y: t.clientY, t: Date.now() } : null
  }
  const onEnd = (e: TouchEvent) => {
    if (!start) return
    const t = e.changedTouches[0]
    const dx = t.clientX - start.x
    const dy = Math.abs(t.clientY - start.y)
    const dt = Date.now() - start.t
    start = null
    if (Math.abs(dx) < MIN_DX || dy > MAX_DY || dt > MAX_MS) return
    // Swipe from the left edge rightward = next page; from the right edge
    // leftward = previous — matches page-flip intuition on both hands.
    // FDNY gets the three command DASHBOARDS (map / board / riding lists);
    // other profiles keep cycling layout presets.
    if (getAppState().profile === 'fdny') cycleDashboardPage(dx > 0 ? 1 : -1)
    else cycleLayoutPreset(dx > 0 ? 1 : -1)
  }
  window.addEventListener('touchstart', onStart, { passive: true })
  window.addEventListener('touchend', onEnd, { passive: true })
  return () => {
    window.removeEventListener('touchstart', onStart)
    window.removeEventListener('touchend', onEnd)
  }
}
