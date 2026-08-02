import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
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

export type PanelOffsets = Record<string, { x: number; y: number }>

export function loadPanelOffsets(): PanelOffsets {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as PanelOffsets
    const out: PanelOffsets = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) out[k] = { x: v.x, y: v.y }
    }
    return out
  } catch {
    return {}
  }
}

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

/** The RESET LAYOUT button: every box returns to its default position. */
export function resetPanelLayout(): void {
  persist({})
  setAppState({ panelOffsets: {} })
}

export function anyPanelMoved(): boolean {
  return Object.keys(getAppState().panelOffsets).length > 0
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
  'data-movable': string
} {
  const { off } = useAppSlice((s) => ({ off: s.panelOffsets[id] }))

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    // Interactive content keeps its normal behavior — dragging starts only
    // from panel background/labels.
    if (target.closest('button, input, select, textarea, a, [contenteditable], .no-drag')) return
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
      el.style.transform = `translate(${last.x}px, ${last.y}px)` // no re-render per move
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

  return {
    style: off && (off.x || off.y) ? { transform: `translate(${off.x}px, ${off.y}px)` } : {},
    onPointerDown,
    'data-movable': id,
  }
}
