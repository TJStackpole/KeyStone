import { useEffect, useMemo, useState } from 'react'
import {
  activatePlanAction,
  decideSuggestion,
  exitWatchCommand,
  finishExercise,
  focusPortfolioIncident,
  openInteragencyRequest,
  refreshWatchLayers,
  requestTransition,
  saveRules,
} from '../actions'
import { useAppState } from '../state/store'
import type { InteragencyRequest, RequestPriority, RequestState, TriggerRule } from '../types'

// ---------------------------------------------------------------------------
// Prompt 11 Module 1 — Watch Command: the citywide multi-incident portfolio
// view. One screen: every active incident, the merged event ticker, the
// per-agency status board ("tracked in KeyStone" — never authoritative),
// weather triggers, the request board, and the EOC/plan timeline strip.
// KeyStone is a neutral read-and-coordinate layer; CIMS labels are exact.
// ---------------------------------------------------------------------------

const AGENCIES = ['FDNY', 'NYPD', 'EMS', 'PAPD', 'OEM', 'DEP', 'DOT', 'DOB', 'MTA', 'ConEd']
const BOROUGHS = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island']
const REQ_STATES: RequestState[] = ['opened', 'acknowledged', 'assigned', 'in_progress', 'complete', 'declined']

/** Operator identity for every logged action — required, remembered. */
function useOperator(): [string, (v: string) => void] {
  const [name, setName] = useState(() => localStorage.getItem('ks-operator') ?? '')
  return [
    name,
    (v: string) => {
      setName(v)
      localStorage.setItem('ks-operator', v)
    },
  ]
}

const fmtAge = (iso: string) => {
  const min = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000))
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60}m`
}

/** Elapsed-in-current-state, and whether it breaches the priority threshold. */
function requestElapsed(r: InteragencyRequest, thresholds: Record<RequestPriority, number>) {
  const last = r.transitions[r.transitions.length - 1]
  const inStateMs = Date.now() - Date.parse(last.at)
  const openMs = Date.now() - Date.parse(r.createdAt)
  const active = r.state !== 'complete' && r.state !== 'declined'
  const acked = r.transitions.some((t) => t.state === 'acknowledged')
  const breach = active && !acked && openMs > thresholds[r.priority]
  return { inStateMs, breach }
}

function HoverCard() {
  const { portfolio, portfolioHoverId } = useAppState()
  const pi = portfolio.find((p) => p.id === portfolioHoverId)
  if (!pi) return null
  return (
    <div className="wc-hover glass">
      <b>{pi.address}</b>
      <div className="wc-hover-grid">
        <span>Type</span>
        <i>{pi.type}</i>
        <span>Primary Agency</span>
        <i>{pi.primaryAgency}</i>
        {pi.alarmLevel && (
          <>
            <span>Alarm</span>
            <i>{pi.alarmLevel.toUpperCase()}</i>
          </>
        )}
        <span>Units on scene</span>
        <i>
          {Object.entries(pi.unitsByAgency)
            .map(([a, n]) => `${a} ${n}`)
            .join(' · ') || '—'}
        </i>
        <span>Elapsed</span>
        <i>{fmtAge(pi.startedAt)}</i>
        <span>Open requests</span>
        <i>{pi.openRequests}</i>
      </div>
      <div className="wc-hover-foot">
        {pi.source !== 'board' && <em>SIMULATED</em>} unit counts tracked in KeyStone — click to open tactical view
      </div>
    </div>
  )
}

function SuggestionBanners({ operator }: { operator: string }) {
  const { triggerSuggestions } = useAppState()
  const pending = triggerSuggestions.filter((s) => s.state === 'pending')
  if (!pending.length) return null
  return (
    <div className="wc-banners">
      {pending.map((s) => (
        <div key={s.id} className="wc-banner glass">
          <div className="wc-banner-text">
            <b>
              NWS {s.product.event}
              {s.product.simulated ? ' (SIMULATED)' : ''} meets {s.plan} trigger criteria
            </b>
            <i>
              Suggest {s.plan} activation / EOC Level {s.suggestedEocLevel} · {s.product.headline}
              {s.validateSme ? ' · thresholds VALIDATE—SME' : ''}
            </i>
            <i className="wc-banner-actions">{s.suggestedActions.join(' · ')}</i>
          </div>
          <div className="wc-banner-btns">
            <button
              className="wc-accept"
              onClick={() => {
                void decideSuggestion(s.id, 'accepted', operator || 'unnamed operator')
                void activatePlanAction(s.plan, operator || 'unnamed operator')
              }}
              title="Accept: logs the decision AND activates the plan (timeline band). Suggestions only — nothing auto-activates."
            >
              ACCEPT
            </button>
            <button onClick={() => void decideSuggestion(s.id, 'snoozed', operator || 'unnamed operator')}>
              SNOOZE
            </button>
            <button onClick={() => void decideSuggestion(s.id, 'dismissed', operator || 'unnamed operator')}>
              DISMISS
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

function Ticker() {
  const { tickerFeed } = useAppState()
  const [agency, setAgency] = useState('')
  const [borough, setBorough] = useState('')
  const [minSev, setMinSev] = useState(0)
  const rows = useMemo(
    () =>
      [...tickerFeed]
        .reverse()
        .filter(
          (e) =>
            (!agency || e.agency === agency) &&
            (!borough || e.borough === borough) &&
            (e.severity ?? 0) >= minSev,
        )
        .slice(0, 80),
    [tickerFeed, agency, borough, minSev],
  )
  return (
    <div className="wc-section">
      <div className="wc-section-title">CITYWIDE EVENT TICKER</div>
      <div className="wc-filters">
        <select value={agency} onChange={(e) => setAgency(e.target.value)}>
          <option value="">All agencies</option>
          {AGENCIES.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <select value={borough} onChange={(e) => setBorough(e.target.value)}>
          <option value="">All boroughs</option>
          {BOROUGHS.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
        <select value={minSev} onChange={(e) => setMinSev(Number(e.target.value))}>
          <option value={0}>Any severity</option>
          <option value={3}>Sev ≥ 3</option>
          <option value={4}>Sev ≥ 4</option>
        </select>
      </div>
      <div className="wc-ticker-scroll">
        {rows.length === 0 && <div className="wc-empty">NO EVENTS MATCH THE FILTER</div>}
        {rows.map((e) => (
          <div key={e.id} className={`wc-tick sev${Math.min(5, e.severity ?? 1)}`}>
            <span className="wc-tick-ts">{e.ts.slice(11, 19)}</span>
            <span className="wc-tick-kind">{e.kind}</span>
            <span className="wc-tick-text">{e.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function StatusBoard() {
  const { portfolio } = useAppState()
  const [open, setOpen] = useState<string | null>(null)
  const rollup = useMemo(() => {
    const byAgency = new Map<string, number>()
    for (const pi of portfolio) {
      for (const [a, n] of Object.entries(pi.unitsByAgency)) byAgency.set(a, (byAgency.get(a) ?? 0) + n)
    }
    return [...byAgency.entries()].sort((a, b) => b[1] - a[1])
  }, [portfolio])
  return (
    <div className="wc-section">
      <div className="wc-section-title">
        STATUS BOARD <i className="wc-caveat">UNITS TRACKED IN KEYSTONE — NOT CITYWIDE AVAILABILITY</i>
      </div>
      <div className="wc-rollup">
        {rollup.map(([a, n]) => (
          <span key={a} className="wc-agency-chip">
            {a} <b>{n}</b>
          </span>
        ))}
        {!rollup.length && <div className="wc-empty">NO TRACKED UNITS</div>}
      </div>
      {portfolio.map((pi) => (
        <div key={pi.id}>
          <button className={`wc-inc-row${pi.focused ? ' focused' : ''}`} onClick={() => setOpen(open === pi.id ? null : pi.id)}>
            <span className={`wc-sev s${Math.min(5, pi.severity)}`} />
            <span className="wc-inc-addr">{pi.address}</span>
            <span className="wc-inc-meta">
              {pi.primaryAgency} · {pi.openRequests ? `${pi.openRequests} REQ · ` : ''}
              {fmtAge(pi.startedAt)}
            </span>
          </button>
          {open === pi.id && (
            <div className="wc-inc-detail">
              <div>
                Primary Agency: <b>{pi.primaryAgency}</b>
                {pi.supportingAgencies.length > 0 && <> · Supporting: {pi.supportingAgencies.join(', ')}</>}
              </div>
              <div>
                Units:{' '}
                {Object.entries(pi.unitsByAgency)
                  .map(([a, n]) => `${a} ${n}`)
                  .join(' · ') || '—'}
              </div>
              <button className="wc-open-btn" onClick={() => focusPortfolioIncident(pi.id)}>
                OPEN TACTICAL VIEW →
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function RequestBoard({ operator }: { operator: string }) {
  const { interagencyRequests, requestThresholds, incident } = useAppState()
  const [tab, setTab] = useState<'kanban' | 'queue' | 'metrics'>('kanban')
  const [queueAgency, setQueueAgency] = useState('NYPD')
  const [metrics, setMetrics] = useState<
    { pair: string; priority: string; count: number; medianAckMs: number | null; medianCompleteMs: number | null }[]
  >([])
  const [form, setForm] = useState({ requestingAgency: 'OEM', assignedAgency: 'NYPD', description: '', priority: 'routine' })

  useEffect(() => {
    if (tab !== 'metrics') return
    fetch('/api/requests/metrics')
      .then((r) => r.json())
      .then((b) => setMetrics(b.metrics ?? []))
      .catch(() => setMetrics([]))
  }, [tab, interagencyRequests])

  const nextStates = (s: RequestState): RequestState[] =>
    ({
      opened: ['acknowledged', 'declined'],
      acknowledged: ['assigned', 'declined'],
      assigned: ['in_progress', 'declined'],
      in_progress: ['complete', 'declined'],
      complete: [],
      declined: [],
    })[s] as RequestState[]

  const exportCsv = () => {
    const head = 'pair,priority,count,median_ack_s,median_complete_s'
    const rows = metrics.map(
      (m) =>
        `"${m.pair}",${m.priority},${m.count},${m.medianAckMs !== null ? Math.round(m.medianAckMs / 1000) : ''},${m.medianCompleteMs !== null ? Math.round(m.medianCompleteMs / 1000) : ''}`,
    )
    const blob = new Blob([[head, ...rows].join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'keystone-request-metrics.csv'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const card = (r: InteragencyRequest) => {
    const { inStateMs, breach } = requestElapsed(r, requestThresholds)
    return (
      <div key={r.id} className={`wc-req${breach ? ' breach' : ''}`} title={r.updates.map((u) => `${u.by}: ${u.text}`).join('\n')}>
        <div className="wc-req-head">
          <span className={`wc-req-pri ${r.priority}`}>{r.priority.toUpperCase()}</span>
          <span className="wc-req-pair">
            {r.requestingAgency}→{r.assignedAgency}
          </span>
          <span className="wc-req-age">{Math.floor(inStateMs / 60_000)}m in state</span>
        </div>
        <div className="wc-req-desc">{r.description}</div>
        {r.state === 'declined' && r.declineReason && <div className="wc-req-decline">DECLINED: {r.declineReason}</div>}
        <div className="wc-req-actions">
          {nextStates(r.state).map((s) => (
            <button
              key={s}
              onClick={() => {
                const reason = s === 'declined' ? (window.prompt('Decline reason (required):') ?? '') : undefined
                if (s === 'declined' && !reason) return
                void requestTransition(r.id, s, operator || 'unnamed operator', reason)
              }}
            >
              {s.replace('_', ' ').toUpperCase()}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="wc-section">
      <div className="wc-section-title">
        INTERAGENCY REQUEST TRACKER{' '}
        <i
          className="wc-caveat"
          title="The NYC Comptroller's April 2024 audit recommended a shared interagency tracking and data sharing tool — this module is that accountability layer."
        >
          ⓘ COMPTROLLER APR-2024
        </i>
      </div>
      <div className="wc-filters">
        <button className={tab === 'kanban' ? 'on' : ''} onClick={() => setTab('kanban')}>
          BOARD
        </button>
        <button className={tab === 'queue' ? 'on' : ''} onClick={() => setTab('queue')}>
          AGENCY QUEUE
        </button>
        <button className={tab === 'metrics' ? 'on' : ''} onClick={() => setTab('metrics')}>
          METRICS
        </button>
      </div>
      {tab === 'kanban' && (
        <div className="wc-kanban">
          {REQ_STATES.map((s) => {
            const list = interagencyRequests.filter((r) => r.state === s)
            return (
              <div key={s} className="wc-kanban-col">
                <div className="wc-kanban-head">
                  {s.replace('_', ' ').toUpperCase()} <b>{list.length}</b>
                </div>
                {list.map(card)}
              </div>
            )
          })}
        </div>
      )}
      {tab === 'queue' && (
        <>
          <div className="wc-filters">
            <select value={queueAgency} onChange={(e) => setQueueAgency(e.target.value)}>
              {AGENCIES.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
            <i className="wc-caveat">everything assigned to {queueAgency} right now</i>
          </div>
          <div className="wc-queue">
            {interagencyRequests
              .filter((r) => r.assignedAgency === queueAgency && r.state !== 'complete' && r.state !== 'declined')
              .map(card)}
          </div>
        </>
      )}
      {tab === 'metrics' && (
        <div className="wc-metrics">
          <table>
            <thead>
              <tr>
                <th>Agency pair</th>
                <th>Priority</th>
                <th>N</th>
                <th>Med. ack</th>
                <th>Med. complete</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((m, i) => (
                <tr key={i}>
                  <td>{m.pair}</td>
                  <td>{m.priority}</td>
                  <td>{m.count}</td>
                  <td>{m.medianAckMs !== null ? `${Math.round(m.medianAckMs / 1000)}s` : '—'}</td>
                  <td>{m.medianCompleteMs !== null ? `${Math.round(m.medianCompleteMs / 1000)}s` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="wc-open-btn" onClick={exportCsv}>
            EXPORT CSV
          </button>
        </div>
      )}
      <div className="wc-newreq">
        <select value={form.requestingAgency} onChange={(e) => setForm({ ...form, requestingAgency: e.target.value })}>
          {AGENCIES.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <span>→</span>
        <select value={form.assignedAgency} onChange={(e) => setForm({ ...form, assignedAgency: e.target.value })}>
          {AGENCIES.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
          <option>routine</option>
          <option>urgent</option>
          <option>immediate</option>
        </select>
        <input
          placeholder="New request description…"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
        <button
          disabled={!form.description.trim() || !operator}
          title={operator ? 'Open the request (logs with your name)' : 'Enter your name above first'}
          onClick={() => {
            void openInteragencyRequest({
              incidentId: incident?.id ?? null,
              ...form,
              createdBy: operator,
            })
            setForm({ ...form, description: '' })
          }}
        >
          OPEN
        </button>
      </div>
    </div>
  )
}

function RulesEditor() {
  const { triggerRules } = useAppState()
  const [draft, setDraft] = useState<TriggerRule[] | null>(null)
  const rules = draft ?? triggerRules
  const edit = (i: number, patch: Partial<TriggerRule>) => {
    const next = rules.map((r, j) => (j === i ? { ...r, ...patch } : r))
    setDraft(next)
  }
  return (
    <div className="wc-section">
      <div className="wc-section-title">
        WEATHER TRIGGER RULES <i className="wc-caveat">THRESHOLDS VALIDATE—SME — EDIT AND SAVE IN MINUTES</i>
      </div>
      {rules.map((r, i) => (
        <div key={r.id} className="wc-rule">
          <label className="wc-rule-head">
            <input type="checkbox" checked={r.enabled} onChange={(e) => edit(i, { enabled: e.target.checked })} />
            <b>{r.plan}</b>
            <span>→ suggest EOC L{r.suggestedEocLevel}</span>
            <select
              value={r.suggestedEocLevel}
              onChange={(e) => edit(i, { suggestedEocLevel: Number(e.target.value) as TriggerRule['suggestedEocLevel'] })}
            >
              {[4, 3, 2, 1].map((l) => (
                <option key={l} value={l}>
                  L{l}
                </option>
              ))}
            </select>
          </label>
          <input
            className="wc-rule-match"
            value={r.eventMatch.join(', ')}
            title="NWS product event names that fire this rule (comma-separated)"
            onChange={(e) => edit(i, { eventMatch: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })}
          />
        </div>
      ))}
      {draft && (
        <button
          className="wc-open-btn"
          onClick={() => {
            void saveRules(draft).then((ok) => ok && setDraft(null))
          }}
        >
          SAVE RULES
        </button>
      )}
    </div>
  )
}

/** EOC level history + plan-activation bands over the last two hours. */
function TimelineStrip() {
  const { eoc, planActivations } = useAppState()
  const now = Date.now()
  const SPAN = 2 * 3600_000
  const x = (iso: string) => Math.max(0, Math.min(100, 100 - ((now - Date.parse(iso)) / SPAN) * 100))
  return (
    <div className="wc-strip glass">
      <div className="wc-strip-title">EOC / PLANS · LAST 2H</div>
      <div className="wc-strip-lane">
        {planActivations
          .filter((p) => now - Date.parse(p.activatedAt) < SPAN || !p.deactivatedAt)
          .map((p) => (
            <div
              key={p.id}
              className="wc-plan-band"
              style={{ left: `${x(p.activatedAt)}%`, right: `${100 - (p.deactivatedAt ? x(p.deactivatedAt) : 100)}%` }}
              title={`${p.plan} — activated by ${p.activatedBy} at ${p.activatedAt}${p.deactivatedAt ? `, deactivated ${p.deactivatedAt}` : ' (ACTIVE)'}`}
            >
              {p.plan}
            </div>
          ))}
      </div>
      <div className="wc-strip-lane eoc">
        {eoc.history
          .filter((c) => now - Date.parse(c.changedAt) < SPAN)
          .map((c, i) => (
            <div key={i} className="wc-eoc-mark" style={{ left: `${x(c.changedAt)}%` }} title={`Level ${c.level} — ${c.changedBy} @ ${c.changedAt}`}>
              L{c.level}
            </div>
          ))}
      </div>
    </div>
  )
}

export function WatchCommandPanel() {
  const { watchCommand, portfolio, weatherAlerts, weatherObs, scenario } = useAppState()
  const [operator, setOperator] = useOperator()

  // Markers + weather polygons track state while the view is up.
  useEffect(() => {
    refreshWatchLayers()
  }, [watchCommand, portfolio, weatherAlerts])

  if (!watchCommand) return null

  return (
    <>
      <HoverCard />
      <SuggestionBanners operator={operator} />
      <aside className="wc-left glass">
        <div className="wc-head">
          <span className="card-title">Watch Command</span>
          <span className="wc-count">{portfolio.length} ACTIVE</span>
          <button className="panel-close" onClick={exitWatchCommand} title="Back to the tactical view">
            ✕
          </button>
        </div>
        <input
          className="wc-operator"
          placeholder="Your name (required for logged actions)"
          value={operator}
          onChange={(e) => setOperator(e.target.value)}
        />
        <Ticker />
        {weatherObs && (
          <div className="wc-obs">
            KNYC {weatherObs.tempC !== null ? `${Math.round(weatherObs.tempC)}°C` : '—'} · wind{' '}
            {weatherObs.windKt ?? '—'} kt · precip {weatherObs.precipMmHr ?? 0} mm/h
          </div>
        )}
        {scenario?.exercise && (
          <button className="wc-endex" onClick={() => void finishExercise()} title="End the exercise and generate the HSEEP AAR draft">
            ■ END EXERCISE → GENERATE AAR
          </button>
        )}
      </aside>
      <aside className="wc-right glass">
        <StatusBoard />
        <RequestBoard operator={operator} />
        <RulesEditor />
      </aside>
      <TimelineStrip />
    </>
  )
}
