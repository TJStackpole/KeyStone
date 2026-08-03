import { useState } from 'react'
import './DecisionLogPage.css'
import { transmitAlarm } from '../actions'
import { setDashboardPage } from '../lib/layouts'
import { useAppSlice } from '../state/store'
import type { AlarmLevel, TimelineEvent } from '../types'

// ---------------------------------------------------------------------------
// DECISION LOG — dashboard page 3. The ICS-214 activity log, one-tap: the IC
// hits a benchmark the moment it happens (10-75, all-hands, under control,
// mayday declared...) and it lands on the incident's immutable record with a
// server timestamp. Plain DOM, zero Cesium — the log keeps working if the
// 3D view dies. Alarm benchmarks route through THE alarm path
// (transmitAlarm → /api/alarm), which escalates AND logs on one request —
// never a log entry without the dispatch or vice versa.
// ---------------------------------------------------------------------------

const ALARM_BENCHMARKS: { code: string; level: AlarmLevel }[] = [
  { code: '10-75', level: '10-75' },
  { code: 'ALL HANDS', level: 'all-hands' },
  { code: '2ND ALARM', level: '2nd' },
  { code: '3RD ALARM', level: '3rd' },
  { code: '4TH ALARM', level: '4th' },
  { code: '5TH ALARM', level: '5th' },
]

const LOG_BENCHMARKS = [
  'PROBABLY WILL HOLD',
  'UNDER CONTROL',
  'MAYDAY DECLARED',
  'PAR COMPLETE',
  'EXPOSURE PROBLEM',
  'COLLAPSE ZONE ESTABLISHED',
]

const LOG_KINDS = new Set(['ic.benchmark', 'ic.note', 'ic.par-complete', 'ops.duration-mark', 'ops.par-due'])

function post(kind: string, payload: Record<string, unknown>): void {
  void fetch('/api/timeline', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, payload }),
  }).catch((err) => console.error('[log] post failed:', err))
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
    default:
      return ev.kind
  }
}

function hhmmss(t: string): string {
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** ICS-214-styled printable activity log (AarPanel print→PDF pattern). */
function printIcs214(incident: { address: string; createdAt: string } | null, rows: TimelineEvent[]): void {
  const w = window.open('', '_blank', 'width=760,height=900')
  if (!w) return
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = rows
    .map((ev) => `<tr><td class="t">${esc(hhmmss(ev.t))}</td><td>${esc(rowText(ev))}</td></tr>`)
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
  if (page !== 3) return null

  const rows = timeline.filter((ev) => LOG_KINDS.has(ev.kind)).slice(-200).reverse()

  const sendNote = () => {
    const text = note.trim()
    if (!text) return
    post('ic.note', { text })
    setNote('')
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
          {ALARM_BENCHMARKS.map((b) => (
            <button
              key={b.code}
              className={`dl-btn alarm${alarmLevel === b.level ? ' current' : ''}`}
              disabled={!incident}
              onClick={() => void transmitAlarm(b.level)}
              title={`Transmit ${b.code} — dispatches the escalation AND records the benchmark`}
            >
              {b.code}
            </button>
          ))}
        </div>
        <div className="dl-zone-label">BENCHMARKS — one tap, on the record</div>
        <div className="dl-grid">
          {LOG_BENCHMARKS.map((code) => (
            <button
              key={code}
              className="dl-btn"
              disabled={!incident}
              onClick={() => (code === 'PAR COMPLETE' ? post('ic.par-complete', { units: [] }) : post('ic.benchmark', { code }))}
              title={code === 'PAR COMPLETE' ? 'Logs the PAR and resets the PAR countdown' : `Log "${code}" with a server timestamp`}
            >
              {code}
            </button>
          ))}
        </div>
        <div className="dl-note">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendNote()}
            placeholder="Free-text entry — decisions, orders, conditions…"
            disabled={!incident}
          />
          <button className="dl-btn send" disabled={!incident || !note.trim()} onClick={sendNote}>
            LOG IT
          </button>
        </div>
      </section>

      <section className="dl-log">
        {rows.length === 0 && <div className="dl-empty">Nothing on the record yet — benchmarks and notes land here, newest first.</div>}
        {rows.map((ev, i) => (
          <div key={`${ev.t}:${i}`} className={`dl-row ${ev.kind.startsWith('ops.') ? 'ops' : ev.kind === 'ic.note' ? 'note' : 'bench'}`}>
            <span className="dl-time">{hhmmss(ev.t)}</span>
            <span className="dl-text">{rowText(ev)}</span>
          </div>
        ))}
      </section>
    </div>
  )
}
