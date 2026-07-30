import { useMemo } from 'react'
import { toggleAgency } from '../actions'
import { setAppState, useAppState } from '../state/store'
import type { Agency, TimelineEvent } from '../types'

const AGENCIES: Agency[] = ['FDNY', 'EMS', 'NYPD', 'PAPD', 'OEM']
const AGENCY_COLOR: Record<string, string> = {
  FDNY: '#dc2626',
  EMS: '#1d4ed8',
  NYPD: '#2563eb',
  PAPD: '#16a34a',
  OEM: '#ea580c',
}

interface Request {
  id: string
  from: string
  to: string
  text: string
  status: 'OPEN' | 'CLOSED'
  resolution?: string
}

function latestPayload(timeline: TimelineEvent[], kind: string): Record<string, unknown> | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].kind === kind) return (timeline[i].payload ?? {}) as Record<string, unknown>
  }
  return null
}

/**
 * NYCEM Watch Command view (Prompt 8A §5): the same incident as the
 * coordination picture — all-agency rollup, interagency requests, incident
 * status board. Derived entirely from the live unit registry + event log.
 */
export function NycemPanel() {
  // Guard component: the heavy derivation lives in the inner panel so the
  // (default-hidden) view costs nothing on the ~5 store writes/s of a live
  // incident. Hooks can't sit below an early return, hence the split.
  const { nycemView } = useAppState()
  if (!nycemView) return null
  return <NycemPanelInner />
}

function NycemPanelInner() {
  const { units, incident, timeline, agencyToggles, scenario } = useAppState()

  const rollup = useMemo(() => {
    const out = new Map<Agency, { total: number; enroute: number; onScene: number; staged: number }>()
    for (const a of AGENCIES) out.set(a, { total: 0, enroute: 0, onScene: 0, staged: 0 })
    for (const u of Object.values(units)) {
      const row = out.get(u.agency)
      if (!row) continue
      row.total++
      if (!u.status || u.status === 'Enroute') row.enroute++
      else if (u.status === 'Staged') row.staged++
      else row.onScene++
    }
    return out
  }, [units])

  const requests = useMemo(() => {
    const map = new Map<string, Request>()
    for (const ev of timeline) {
      const p = (ev.payload ?? {}) as Record<string, unknown>
      if (ev.kind === 'interagency.request' && typeof p.id === 'string') {
        map.set(p.id, {
          id: p.id,
          from: String(p.from ?? '—'),
          to: String(p.to ?? '—'),
          text: String(p.text ?? ''),
          status: 'OPEN',
        })
      }
      if (ev.kind === 'interagency.closed' && typeof p.id === 'string') {
        const r = map.get(p.id)
        if (r) {
          r.status = 'CLOSED'
          r.resolution = p.resolution ? String(p.resolution) : undefined
        }
      }
    }
    return [...map.values()]
  }, [timeline])

  const activations = useMemo(
    () =>
      timeline
        .filter((ev) => ev.kind === 'agency.activated')
        .map((ev) => ev.payload as { agency?: string; note?: string }),
    [timeline],
  )

  const casualties = latestPayload(timeline, 'casualty.count')
  const unified = latestPayload(timeline, 'command.unified')
  const mci = latestPayload(timeline, 'mci.declared')
  const mciClosed = latestPayload(timeline, 'mci.closed')

  return (
    <aside className="nycem-panel glass">
      <div className="panel-head">
        <span className="card-title">NYCEM WATCH COMMAND · COORDINATION VIEW</span>
        {scenario?.drill && <span className="drill-badge small">DRILL</span>}
        <button className="panel-close" onClick={() => setAppState({ nycemView: false })}>
          ✕
        </button>
      </div>
      <div className="dock-scroll">
        <div className="intel-section-title">Incident Status Board</div>
        <div className="nycem-status">
          <div>
            <span>Incident</span>
            <b>{incident?.address ?? '—'}</b>
          </div>
          <div>
            <span>Alarm</span>
            <b>{incident?.alarmLevel?.toUpperCase() ?? '—'}</b>
          </div>
          <div>
            <span>MCI</span>
            <b className={mci && !mciClosed ? 'hot' : ''}>
              {mciClosed ? `CLOSED · ${String(mciClosed.final ?? '')} PTS` : mci ? 'DECLARED' : '—'}
            </b>
          </div>
          <div>
            <span>Unified command</span>
            <b>{unified ? 'ESTABLISHED' : '—'}</b>
          </div>
        </div>
        {unified && Array.isArray(unified.agencies) && (
          <div className="nycem-unified">
            {(unified.agencies as string[]).map((a) => (
              <span key={a} className="chip">
                {a}
              </span>
            ))}
          </div>
        )}
        {casualties && (
          <div className="nycem-casualties">
            <span className="cas red">RED {String(casualties.red ?? 0)}</span>
            <span className="cas yellow">YELLOW {String(casualties.yellow ?? 0)}</span>
            <span className="cas green">GREEN {String(casualties.green ?? 0)}</span>
            <span className="cas">TRANSPORTED {String(casualties.transported ?? 0)}</span>
          </div>
        )}

        <div className="intel-section-title">Resources by Agency</div>
        <div className="nycem-rollup">
          <div className="rollup-row head">
            <span>AGENCY</span>
            <span>ENRT</span>
            <span>SCENE</span>
            <span>STAGED</span>
            <span>TOTAL</span>
            <span>MAP</span>
          </div>
          {AGENCIES.map((a) => {
            const r = rollup.get(a)!
            return (
              <div key={a} className="rollup-row">
                <span style={{ color: AGENCY_COLOR[a] }}>{a}</span>
                <span>{r.enroute}</span>
                <span>{r.onScene}</span>
                <span>{r.staged}</span>
                <span>
                  <b>{r.total}</b>
                </span>
                <span>
                  <button
                    className={`toggle-chip${agencyToggles[a] ? ' on' : ''}`}
                    onClick={() => toggleAgency(a)}
                    title={`Show/hide ${a} units on the map`}
                  >
                    {agencyToggles[a] ? 'ON' : 'OFF'}
                  </button>
                </span>
              </div>
            )
          })}
        </div>

        <div className="intel-section-title">Interagency Requests</div>
        {requests.length === 0 && <div className="intel-note">NO OPEN REQUESTS</div>}
        {requests.map((r) => (
          <div key={r.id} className={`request-row${r.status === 'OPEN' ? ' open' : ''}`}>
            <span className={`status-chip ${r.status === 'OPEN' ? 'operating' : 'onscene'}`}>{r.status}</span>
            <span className="req-text">
              <b>
                {r.from} → {r.to}
              </b>
              {r.text}
              {r.resolution && <i>{r.resolution}</i>}
            </span>
          </div>
        ))}

        <div className="intel-section-title">Agency Activations</div>
        {activations.length === 0 && <div className="intel-note">NONE LOGGED</div>}
        {activations.map((a, i) => (
          <div key={i} className="safety-row">
            <span className="safety-date">{a.agency}</span>
            <span className="safety-desc">{a.note}</span>
          </div>
        ))}
      </div>
    </aside>
  )
}
