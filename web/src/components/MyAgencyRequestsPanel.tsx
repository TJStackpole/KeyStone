import { useEffect, useReducer, useState } from 'react'
import { requestTransition } from '../actions'
import { useCapability } from '../profiles/manifest'
import { useAppSlice } from '../state/store'
import type { RequestState } from '../types'
import { requestElapsed } from '../lib/requests'

// ---------------------------------------------------------------------------
// Prompt 12 — FDNY's "My Agency Requests". FDNY is a PARTY to interagency
// requests even though the citywide board is NYCEM's: total removal would
// force FDNY users to phone NYCEM, recreating the exact problem the tracker
// solves. Requests where FDNY is requester or assignee, with state actions.
//
// Lives ON THE DECISION LOG PAGE (dashboard 3) — it stopped floating over
// the map; interagency taskings belong next to the incident record.
// ---------------------------------------------------------------------------

const OWN_AGENCY = 'FDNY' // profile → agency mapping becomes real with sign-in

const NEXT: Record<RequestState, RequestState[]> = {
  opened: ['acknowledged', 'declined'],
  acknowledged: ['assigned', 'declined'],
  assigned: ['in_progress', 'declined'],
  in_progress: ['complete', 'declined'],
  complete: [],
  declined: [],
}

/** The requests block on the DECISION LOG page: rows + SLA breach flash +
 *  state actions for tickets assigned to us. Header lives on the page. */
export function AgencyRequestsBlock() {
  const enabled = useCapability('requests.agency-panel')
  const { interagencyRequests, requestThresholds } = useAppSlice((s) => ({
    interagencyRequests: s.interagencyRequests,
    requestThresholds: s.requestThresholds,
  }))
  const [declining, setDeclining] = useState<{ id: string; reason: string } | null>(null)
  // Same 5s breach tick as the citywide board — the flash must not wait for
  // an incidental re-render.
  const [, tick] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    if (!enabled) return
    const t = setInterval(tick, 5000)
    return () => clearInterval(t)
  }, [enabled])

  if (!enabled) return null
  const mine = interagencyRequests.filter(
    (r) => r.requestingAgency === OWN_AGENCY || r.assignedAgency === OWN_AGENCY,
  )
  const active = mine.filter((r) => r.state !== 'complete' && r.state !== 'declined')
  const operator = localStorage.getItem('ks-operator') ?? 'unnamed operator'
  const breaches = active.filter((r) => requestElapsed(r, requestThresholds).breach).length

  return (
    <section className="dl-requests">
      <div className="dl-zone-label">
        MY AGENCY REQUESTS — interagency taskings where FDNY is a party
        {active.length > 0 && <b className="dl-req-count">{active.length} ACTIVE</b>}
        {breaches > 0 && <b className="dl-req-breach">{breaches} PAST SLA</b>}
      </div>
      {mine.length === 0 && <div className="dl-empty">No requests involving FDNY — draft one by voice: “request a bus from EMS”.</div>}
      <div className="agency-req-list">
        {[...active, ...mine.filter((r) => !active.includes(r)).slice(-3)].map((r) => {
          const { breach } = requestElapsed(r, requestThresholds)
          const role = r.assignedAgency === OWN_AGENCY ? 'ASSIGNED TO US' : 'WE REQUESTED'
          return (
            <div key={r.id} className={`agency-req-row${breach ? ' breach' : ''}`}>
              <div className="agency-req-meta">
                <span className={`wc-req-pri ${r.priority}`}>{r.priority.toUpperCase()}</span>
                <span className="agency-req-role">{role}</span>
                <span className="agency-req-pair">
                  {r.requestingAgency}→{r.assignedAgency}
                </span>
                <em>{r.state.replace('_', ' ').toUpperCase()}</em>
              </div>
              <div className="agency-req-desc">{r.description}</div>
              {declining?.id === r.id ? (
                <div className="wc-req-declineform">
                  <input
                    autoFocus
                    placeholder="Decline reason (required)"
                    value={declining.reason}
                    onChange={(e) => setDeclining({ id: r.id, reason: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setDeclining(null)
                      if (e.key === 'Enter' && declining.reason.trim()) {
                        void requestTransition(r.id, 'declined', operator, declining.reason.trim())
                        setDeclining(null)
                      }
                    }}
                  />
                  <button
                    disabled={!declining.reason.trim()}
                    onClick={() => {
                      void requestTransition(r.id, 'declined', operator, declining.reason.trim())
                      setDeclining(null)
                    }}
                  >
                    CONFIRM
                  </button>
                  <button onClick={() => setDeclining(null)}>✕</button>
                </div>
              ) : (
                // State actions belong to the ASSIGNED agency — the
                // requester watches progress, they don't work the ticket.
                r.assignedAgency === OWN_AGENCY && (
                  <div className="wc-req-actions">
                    {NEXT[r.state].map((s) => (
                      <button
                        key={s}
                        onClick={() => {
                          if (s === 'declined') setDeclining({ id: r.id, reason: '' })
                          else void requestTransition(r.id, s, operator)
                        }}
                      >
                        {s.replace('_', ' ').toUpperCase()}
                      </button>
                    ))}
                  </div>
                )
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
