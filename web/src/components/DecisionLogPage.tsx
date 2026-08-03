import { useState } from 'react'
import './DecisionLogPage.css'
import { transmitAlarm } from '../actions'
import { ALARM_LADDER, alarmRank } from '../lib/alarms'
import { setDashboardPage } from '../lib/layouts'
import { fmtWallClock } from '../lib/time'
import { useAppSlice } from '../state/store'
import type { TimelineEvent } from '../types'

// ---------------------------------------------------------------------------
// DECISION LOG — dashboard page 3. The ICS-214 activity log, one-tap: the IC
// hits a benchmark the moment it happens (10-75, all-hands, under control,
// mayday declared...) and it lands on the incident's immutable record with a
// server timestamp. Plain DOM, zero Cesium — the log keeps working if the
// 3D view dies. Alarm benchmarks route through THE alarm path
// (transmitAlarm → /api/alarm), which escalates AND logs on one request —
// never a log entry without the dispatch or vice versa.
// ---------------------------------------------------------------------------

const LOG_BENCHMARKS = [
  'PROBABLY WILL HOLD',
  'UNDER CONTROL',
  'MAYDAY DECLARED',
  'EXPOSURE PROBLEM',
  'COLLAPSE ZONE ESTABLISHED',
]

const LOG_KINDS = new Set(['ic.benchmark', 'ic.note', 'ic.par-complete', 'ops.duration-mark', 'ops.par-due', 'alert.mayday'])

async function post(kind: string, payload: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch('/api/timeline', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, payload }),
    })
    return res.ok
  } catch (err) {
    console.error('[log] post failed:', err)
    return false
  }
}

function rowText(ev: TimelineEvent): string {
  const p = (ev.payload ?? {}) as Record<string, unknown>
  switch (ev.kind) {
    case 'ic.benchmark':
      return String(p.code ?? 'BENCHMARK')
    case 'ic.note':
      return String(p.text ?? '')
    case 'ic.par-complete': {
      const units = Array.isArray(p.units) ? (p.units as string[]) : []
      return units.length ? `PAR COMPLETE — ${units.join(', ')}` : 'PAR COMPLETE'
    }
    case 'ops.duration-mark':
      return `${String(p.minutes)} MINUTES ON THE BOX`
    case 'ops.par-due':
      return `PAR OVERDUE — ${String(p.sinceMin)} MIN SINCE LAST PAR`
    case 'alert.mayday':
      return `MAYDAY — ${String(p.callsign ?? p.unit ?? p.text ?? 'DECLARED')}`
    default:
      return ev.kind
  }
}

/** ICS-214-styled printable activity log (AarPanel print→PDF pattern). */
function printIcs214(incident: { address: string; createdAt: string } | null, rows: TimelineEvent[]): void {
  const w = window.open('', '_blank', 'width=760,height=900')
  if (!w) return
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = rows
    .map((ev) => `<tr><td class="t">${esc(fmtWallClock(ev.t))}</td><td>${esc(rowText(ev))}</td></tr>`)
    .join('')
  w.document.write(`<!doctype html><html><head><title>ICS-214 Activity Log</title><style>
    body { font: 13px/1.5 Georgia, serif; color: #111; margin: 40px; }
    h1 { font-size: 17px; margin: 0; } .sub { color: #555; font-size: 12px; margin-bottom: 16px; }
    table { border-collapse: collapse; width: 100%; }
    td { padding: 6px 10px; border-bottom: 1px solid #ddd; vertical-align: top; }
    td.t { width: 90px; font-family: monospace; }
    .print { margin-top: 20px; padding: 8px 16px; cursor: pointer; }
    @media print { .print { display: none; } }
  </style></head><body>
  <h1>ACTIVITY LOG (ICS 214)</h1>
  <div class="sub">Incident: ${esc(incident?.address ?? '—')} · Operational period from ${esc(
    incident ? new Date(incident.createdAt).toLocaleString() : '—',
  )} · Prepared ${esc(new Date().toLocaleString())} — KeyStone FDNY</div>
  <table>${body}</table>
  <button class="print" onclick="window.print()">Print / save as PDF</button>
  </body></html>`)
  w.document.close()
}

export function DecisionLogPage() {
  const { page, incident, timeline, alarmLevel } = useAppSlice((s) => ({
    page: s.dashboardPage,
    incident: s.incident,
    timeline: s.timeline,
    alarmLevel: s.incident?.alarmLevel ?? null,
  }))
  const [note, setNote] = useState('')
  const [noteFailed, setNoteFailed] = useState(false)
  if (page !== 3) return null

  const rows = timeline.filter((ev) => LOG_KINDS.has(ev.kind)).slice(-200).reverse()

  const sendNote = async () => {
    const text = note.trim()
    if (!text) return
    setNote('')
    setNoteFailed(false)
    // The one entry that can't be reconstructed — restore the draft if the
    // record never got it, and say so visibly (never console-only).
    if (!(await post('ic.note', { text }))) {
      setNote(text)
      setNoteFailed(true)
    }
  }

  return (
    <div className="declog-page">
      <header className="dl-head">
        <button className="dl-back" onClick={() => setDashboardPage(0)}>
          ◀ MAP
        </button>
        <div>
          <h1>DECISION LOG</h1>
          <div className="dl-sub">{incident ? incident.address : 'NO ACTIVE INCIDENT — entries need a live box'}</div>
        </div>
        <button className="dl-print" onClick={() => printIcs214(incident, [...rows].reverse())} title="ICS-214 activity log, print or save as PDF">
          PRINT ICS-214
        </button>
      </header>

      <section className="dl-benchmarks">
        <div className="dl-zone-label">ALARMS — escalate + log in one press</div>
        <div className="dl-grid">
          {ALARM_LADDER.map((b) => {
            const reached = alarmRank(alarmLevel) >= alarmRank(b.id)
            return (
              <button
                key={b.id}
                className={`dl-btn alarm${alarmLevel === b.id ? ' current' : ''}`}
                disabled={!incident || reached}
                onClick={() => void transmitAlarm(b.id)}
                title={reached ? `${b.label} already transmitted — alarms only climb` : `Transmit ${b.label} — dispatches the escalation AND records the benchmark`}
              >
                {b.label}
              </button>
            )
          })}
        </div>
        <div className="dl-zone-label">BENCHMARKS — log only, one tap on the record</div>
        <div className="dl-grid">
          {LOG_BENCHMARKS.map((code) => (
            <button
              key={code}
              className="dl-btn"
              disabled={!incident}
              onClick={() => void post('ic.benchmark', { code })}
              title={`Log "${code}" with a server timestamp`}
            >
              {code}
            </button>
          ))}
          <button
            className="dl-btn"
            disabled={!incident}
            onClick={() => setDashboardPage(2)}
            title="PAR is taken company-by-company — this opens the RIDING LIST where each stamp goes on the record and resets the PAR clock"
          >
            PAR → RIDING LIST
          </button>
        </div>
        <div className="dl-note">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void sendNote()}
            placeholder="Free-text entry — decisions, orders, conditions…"
            disabled={!incident}
          />
          <button className="dl-btn send" disabled={!incident || !note.trim()} onClick={() => void sendNote()}>
            LOG IT
          </button>
        </div>
        {noteFailed && <div className="dl-note-err">ENTRY DID NOT REACH THE RECORD — check the link and press LOG IT again.</div>}
      </section>

      <section className="dl-log">
        {rows.length === 0 && <div className="dl-empty">Nothing on the record yet — benchmarks and notes land here, newest first.</div>}
        {rows.map((ev, i) => (
          <div key={`${ev.t}:${i}`} className={`dl-row ${ev.kind.startsWith('ops.') ? 'ops' : ev.kind === 'ic.note' ? 'note' : 'bench'}`}>
            <span className="dl-time">{fmtWallClock(ev.t)}</span>
            <span className="dl-text">{rowText(ev)}</span>
          </div>
        ))}
      </section>
    </div>
  )
}
