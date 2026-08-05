import { hasCapability } from '../profiles/manifest'
import { useAppSlice, type AppState } from '../state/store'

// ---------------------------------------------------------------------------
// The NEXT-STEP spine: at any moment, at most ONE control on screen glows as
// the trained next action. Chiefs under stress follow a lit path, they don't
// browse menus. Every consumer (pulsing chips, the NEXT readout in the top
// bar) derives from this single computation, so the path can never disagree
// with itself.
//
//   FDNY:  search address → ACTIVE INCIDENT → ISOLATE (locks structure
//          views) → draw the PERIMETER → path complete, no pulse.
//   NYCEM: an interagency request sitting past its acknowledgment threshold
//          outranks everything — answer the overdue request.
// ---------------------------------------------------------------------------

export type NextStepId = 'search' | 'active-incident' | 'isolate' | 'perimeter' | 'requests'

export const NEXT_STEP_LABEL: Record<NextStepId, string> = {
  search: 'SEARCH AN ADDRESS',
  'active-incident': 'STAND UP THE INCIDENT',
  isolate: 'ISOLATE THE STRUCTURE',
  perimeter: 'DRAW THE PERIMETER',
  requests: 'ANSWER OVERDUE REQUESTS',
}

export function computeNextStep(s: AppState): NextStepId | null {
  // NYCEM: overdue coordination beats map work.
  if (s.profile === 'nycem') {
    const now = Date.now()
    const overdue = s.interagencyRequests.some(
      (r) => r.state === 'opened' && now - Date.parse(r.createdAt) > (s.requestThresholds[r.priority] ?? 300_000),
    )
    return overdue ? 'requests' : null
  }
  if (s.replay.active) return null
  if (!s.incident) return s.inspected ? 'active-incident' : 'search'
  const hasPerimeter = Object.values(s.shapes).some((sh) => sh.kind === 'zone' && sh.zone === 'perimeter')
  if (s.mapMode === '2d') {
    // 2D-first order: the perimeter is drawn RIGHT HERE on the tactical map;
    // ISOLATE (the 3D building study) is the step after it.
    if (!hasPerimeter) return 'perimeter'
    if (hasCapability(s.profile, 'tactical.view-lock') && !s.isolateMode) return 'isolate'
    return null
  }
  if (hasCapability(s.profile, 'tactical.view-lock') && !s.isolateMode) return 'isolate'
  if (s.isolateMode && !hasPerimeter) return 'perimeter'
  return null
}

/** Subscribe a component to the current step (primitive — cheap re-renders). */
export function useNextStep(): NextStepId | null {
  return useAppSlice((s) => ({ step: computeNextStep(s) })).step
}
