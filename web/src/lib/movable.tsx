import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { getAppState, setAppState, useAppSlice } from '../state/store'

// ---------------------------------------------------------------------------
// Movable panels: every info box can be dragged anywhere on screen by its
// background (buttons/inputs/selects still click normally — a drag only
// starts from non-interactive surface, after a 5 px movement threshold).
// Offsets are TRANSFORM-only, so default CSS positioning stays the single
// source of truth: RESET LAYOUT simply clears the offsets and every panel
// snaps back to exactly where it was. Layout persists per browser.
//
// During a drag the transform is written straight to the DOM (zero React
// re-renders per pointermove); the final offset commits to the store +
// localStorage on release.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'ks-panel-offsets'
const MIN_KEY = 'ks-panel-min'

export type PanelOffsets = Record<string, { x: number; y: number }>

function persist(offsets: PanelOffsets): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(offsets))
  } catch {
    // storage full/blocked — layout still works for this session
  }
}

export function setPanelOffset(id: string, off: { x: number; y: number }): void {
  setAppState((s) => {
    const next = { ...s.panelOffsets, [id]: off }
    persist(next)
    return { panelOffsets: next }
  })
}

function persistMin(min: Record<string, boolean>): void {
  try {
    localStorage.setItem(MIN_KEY, JSON.stringify(min))
  } catch {
    // storage full/blocked — minimize still works for this session
  }
}

/** Double-click a panel's background: collapse to its smallest (header-only)
 *  state. Double-click again restores. Persisted like drag offsets. */
export function togglePanelMinimized(id: string): void {
  setAppState((s) => {
    const next = { ...s.panelMinimized }
    if (next[id]) delete next[id]
    else next[id] = true
    persistMin(next)
    return { panelMinimized: next }
  })
}

/** Explicit set — the voice layer's "minimize/restore <panel>" lands here. */
export function setPanelMinimized(id: string, minimized: boolean): void {
  setAppState((s) => {
    const next = { ...s.panelMinimized }
    if (minimized) next[id] = true
    else delete next[id]
    persistMin(next)
    return { panelMinimized: next }
  })
}

/** "Minimize everything" / "restore everything" — one store write. */
export function setAllPanelsMinimized(minimized: boolean): void {
  const next: Record<string, boolean> = {}
  if (minimized) for (const id of Object.keys(PANEL_IDS)) next[id] = true
  persistMin(next)
  setAppState({ panelMinimized: next })
}

/** Every minimizable surface on the map platform, with its spoken aliases —
 *  drives "minimize <panel>", "minimize everything", and the help panel. */
export const PANEL_IDS: Record<string, string[]> = {
  'incident-card': ['incident', 'incident card'],
  roster: ['units', 'roster', 'unit list'],
  intel: ['intel', 'site intel', 'building info'],
  comms: ['comms', 'radio'],
  'utility-dock': ['dock', 'video', 'utility dock', 'video dock'],
  'draw-toolbar': ['tools', 'draw tools', 'toolbar'],
  'scenario-bar': ['scenario bar', 'scenarios'],
  'feed-health': ['feeds', 'feed health', 'live feeds'],
  streetview: ['street panel', 'street view panel'],
  takchat: ['chat', 'tak chat'],
  manuals: ['manuals'],
  tactics: ['tactics'],
  'response-packet': ['packet', 'response packet'],
  wind: ['wind', 'wind advisory'],
  practice: ['checklist', 'practice'],
  aar: ['debrief', 'aar'],
  'ground-height': ['height scale', 'ground height'],
  ptt: ['ptt', 'voice button', 'mic button'],
}

/** The RESET LAYOUT button: every box returns to its default position and
 *  size, and glove-mode zoom switches off — ONE button un-messes the screen
 *  no matter what combination got someone lost. */
export function resetPanelLayout(): void {
  persist({})
  persistMin({})
  try {
    localStorage.setItem('ks-glove', '0')
  } catch {
    // storage blocked — the state reset below still applies this session
  }
  setAppState({ panelOffsets: {}, panelMinimized: {}, gloveMode: false, layoutPreset: null })
}

/** Don't let a panel be dragged fully offscreen — keep a grabbable margin. */
const KEEP_VISIBLE_PX = 48

/**
 * Wire a panel root: `const mv = useMovable('comms')` then spread
 * `style={mv.style} onPointerDown={mv.onPointerDown} data-movable`.
 * Roots that already have a style merge it: `style={{ ...own, ...mv.style }}`.
 */
export function useMovable(id: string): {
  style: CSSProperties
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onDoubleClick: (e: ReactMouseEvent<HTMLElement>) => void
  title: string | undefined
  'data-movable': string
  'data-moved': string | undefined
  'data-minimized': string | undefined
} {
  const { off, minimized } = useAppSlice((s) => ({ off: s.panelOffsets[id], minimized: !!s.panelMinimized[id] }))

  const onDoubleClick = (e: ReactMouseEvent<HTMLElement>) => {
    const target = e.target as HTMLElement
    // Interactive content keeps its normal behavior (matches drag exclusion).
    if (!minimized && target.closest('button, input, select, textarea, a, iframe, [contenteditable], .no-drag')) return
    e.preventDefault()
    togglePanelMinimized(id)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    // Interactive content keeps its normal behavior — dragging starts only
    // from panel background/labels.
    if (target.closest('button, input, select, textarea, a, iframe, [contenteditable], .no-drag')) return
    const el = e.currentTarget as HTMLElement
    const startX = e.clientX
    const startY = e.clientY
    const base = getAppState().panelOffsets[id] ?? { x: 0, y: 0 }
    const rect = el.getBoundingClientRect()
    let dragging = false
    let last = base

    const clamp = (x: number, y: number) => {
      const left = rect.left - base.x + x
      const top = rect.top - base.y + y
      const minLeft = KEEP_VISIBLE_PX - rect.width
      const maxLeft = window.innerWidth - KEEP_VISIBLE_PX
      const minTop = 0 // never above the viewport — the grab surface is the top
      const maxTop = window.innerHeight - KEEP_VISIBLE_PX
      return {
        x: x + Math.min(Math.max(left, minLeft), maxLeft) - left,
        y: y + Math.min(Math.max(top, minTop), maxTop) - top,
      }
    }

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (!dragging) {
        if (Math.hypot(dx, dy) < 5) return // clicks stay clicks
        dragging = true
        document.body.classList.add('panel-dragging')
      }
      ev.preventDefault()
      last = clamp(base.x + dx, base.y + dy)
      // CSS `translate` (not `transform`): it composes with stylesheet
      // transforms, so translateX(-50%)-centered panels keep their centering.
      el.style.translate = `${last.x}px ${last.y}px` // no re-render per move
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('panel-dragging')
      if (dragging) setPanelOffset(id, last)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const moved = !!off && (off.x !== 0 || off.y !== 0)
  return {
    style: moved ? { translate: `${off.x}px ${off.y}px` } : {},
    onPointerDown,
    onDoubleClick,
    title: minimized ? 'Double-click to restore this panel' : undefined,
    'data-movable': id,
    // CSS hooks (e.g. the Watch Command GeoChat shift) exempt user-placed
    // panels — a base-position jump under a stored offset strands the box.
    'data-moved': moved ? 'true' : undefined,
    'data-minimized': minimized ? 'true' : undefined,
  }
}
