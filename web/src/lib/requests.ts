import type { InteragencyRequest, RequestPriority } from '../types'

/** Elapsed/breach math for interagency requests — shared by the FDNY
 *  "My Agency Requests" panel (and formerly the NYCEM request board). */
export function requestElapsed(r: InteragencyRequest, thresholds: Record<RequestPriority, number>) {
  // transitions can be [] on a request restored from a hand-edited state
  // file (the server normalizes null -> []) — fall back to createdAt.
  const last = r.transitions[r.transitions.length - 1]
  const inStateMs = Date.now() - Date.parse(last?.at ?? r.createdAt)
  const openMs = Date.now() - Date.parse(r.createdAt)
  const active = r.state !== 'complete' && r.state !== 'declined'
  const acked = r.transitions.some((t) => t.state === 'acknowledged')
  const breach = active && !acked && openMs > thresholds[r.priority]
  return { inStateMs, breach }
}
