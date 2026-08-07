import { toggleIsolateMode, undoShapeAction } from '../actions'
import { getAppState } from '../state/store'
import { openBrief } from './brief'

// ---------------------------------------------------------------------------
// Voice verbs: the search-bar mic already listens — before a transcript is
// treated as an address, it gets one pass through this tiny command grammar.
// Hands are busy on a fireground; one spoken word beats a precise tap.
// Deliberately NO destructive verbs (no "clear all", no "end incident").
// ---------------------------------------------------------------------------

const FLOOR_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
}

/**
 * Try the transcript as a command. Returns a short confirmation label when
 * one executed, null when the words should fall through to address search.
 */
export function tryVoiceCommand(raw: string): string | null {
  const t = raw.toLowerCase().trim()
  const s = getAppState()
  const locked = s.viewLock !== 'off'

  if (/^(isolate|isolate the building|isolate it)$/.test(t)) {
    if (s.incident && !s.isolateMode) {
      toggleIsolateMode()
      return 'ISOLATE ON'
    }
    return null
  }
  if (/^(exit isolate|leave isolate|isolate off)$/.test(t)) {
    if (s.isolateMode) {
      toggleIsolateMode()
      return 'ISOLATE OFF'
    }
    return null
  }
  const side = /^(north|south|east|west)( (side|face))?$/.exec(t)
  if (side && locked) {
    void import('../cesium/viewLock').then((m) => m.setViewLockMode(side[1] as 'north' | 'south' | 'east' | 'west'))
    return `${side[1].toUpperCase()} FACE`
  }
  if (/^top( view| down)?$/.test(t) && locked) {
    void import('../cesium/viewLock').then((m) => m.setViewLockMode('top'))
    return 'TOP VIEW'
  }
  const floor = /^(?:floor|level) (\d{1,3}|[a-z]+)$/.exec(t)
  if (floor && locked) {
    const n = /^\d+$/.test(floor[1]) ? Number(floor[1]) : FLOOR_WORDS[floor[1]]
    if (n && Number.isFinite(n)) {
      void import('../cesium/viewLock').then((m) => m.jumpViewLockFloor(n))
      return `FLOOR ${n}`
    }
  }
  if (/^undo( that| last)?$/.test(t)) {
    if (s.undoDepth > 0) {
      void undoShapeAction()
      return 'UNDO'
    }
    return null
  }
  if (/^(brief|situation brief|give me the brief)$/.test(t)) {
    // openBrief always reaches the operator now — a blocked pop-up falls
    // back to the direct system print dialog (see lib/printDoc.ts).
    return openBrief() ? 'BRIEF OPENED' : null
  }
  return null
}
