import { useState } from 'react'
import './DecisionLogPage.css'
import { transmitAlarm } from '../actions'
import { ALARM_LADDER, alarmRank } from '../lib/alarms'
import { setDashboardPage } from '../lib/layouts'
import { isApparatus, isAtBox, isEnroute } from '../lib/crews'
import { escapeHtml, openPrintable } from '../lib/printDoc'
import { fmtWallClock } from '../lib/time'
import { getAppState, useAppSlice } from '../state/store'
import type { TimelineEvent } from '../types'
import { CommandVitals } from './CommandVitals'
import { AgencyRequestsBlock } from './MyAgencyRequestsPanel'

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
// The 10-minute drumbeat is one row every 10 min — on a long box it drowns
// the IC's actual entries (a 14-hour incident carries ~85 of them). Hidden
// by default on screen, excluded from the printed ICS-214 entirely; PAR
// lapses stay everywhere — those are the accountability record.
const NOISE_KINDS = new Set(['ops.duration-mark'])

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

/** ICS-214-styled printable activity log — pop-up-blocker-proof via the
 *  shared printDoc path (blocked window → direct system print dialog). */
function printIcs214(incident: { address: string; createdAt: string } | null, rows: TimelineEvent[]): void {
  const body = rows
    .map((ev) => `<tr><td class="t">${escapeHtml(fmtWallClock(ev.t))}</td><td>${escapeHtml(rowText(ev))}</td></tr>`)
    .join('')
  openPrintable({
    title: 'ICS-214 Activity Log',
    heading: 'ACTIVITY LOG (ICS 214)',
    sub: `Incident: ${incident?.address ?? '—'} · Operational period from ${
      incident ? new Date(incident.createdAt).toLocaleString() : '—'
    } · Prepared ${new Date().toLocaleString()} — KeyStone FDNY`,
    bodyHtml: `<table>${body}</table>`,
  })
}

/** One-tap COMMAND PACK: the whole incident on paper — who/what/where,
 *  units by status, water assignments, benchmarks, open requests. The
 *  handoff document for the relieving chief or the after-action file. */
function printCommandPack(): void {
  const s = getAppState()
  const inc = s.incident
  if (!inc) return
  const rigs = Object.values(s.units).filter(isApparatus)
  const byStatus = (pred: (status: string | undefined) => boolean) =>
    rigs
      .filter((u) => pred(u.status))
      .map((u) => u.callsign)
      .join(', ') || '—'
  const bench = s.timeline
    .filter((ev) => LOG_KINDS.has(ev.kind) && !NOISE_KINDS.has(ev.kind))
    .map((ev) => `<tr><td class="t">${escapeHtml(fmtWallClock(ev.t))}</td><td>${escapeHtml(rowText(ev))}</td></tr>`)
    .join('')
  const water = s.timeline
    .filter((ev) => ev.kind === 'water.assign')
    .map((ev) => {
      const p = (ev.payload ?? {}) as Record<string, unknown>
      return `<tr><td class="t">${escapeHtml(fmtWallClock(ev.t))}</td><td>${escapeHtml(String(p.unit))} → HYDRANT ${escapeHtml(String(p.hydrant))}</td></tr>`
    })
    .join('')
  const reqs = s.interagencyRequests
    .filter((r) => r.state !== 'complete' && r.state !== 'declined')
    .map((r) => `<tr><td class="t">${escapeHtml(r.assignedAgency)}</td><td>${escapeHtml(r.description)} — ${escapeHtml(r.state.replace('_', ' ').toUpperCase())}</td></tr>`)
    .join('')
  openPrintable({
    title: 'KeyStone Command Pack',
    heading: 'COMMAND PACK',
    sub: `${inc.address} · ${inc.type}${inc.alarmLevel ? ` · ${inc.alarmLevel.toUpperCase()}` : ''} · stood up ${new Date(inc.createdAt).toLocaleString()} · printed ${new Date().toLocaleString()} — KeyStone FDNY`,
    bodyHtml:
      `<h2>UNITS</h2><table>` +
      `<tr><td class="t">ON SCENE / OPERATING</td><td>${escapeHtml(byStatus(isAtBox))}</td></tr>` +
      `<tr><td class="t">ENROUTE</td><td>${escapeHtml(byStatus(isEnroute))}</td></tr></table>` +
      (water ? `<h2>WATER SUPPLY</h2><table>${water}</table>` : '') +
      `<h2>ACTIVITY (ICS-214)</h2><table>${bench || '<tr><td>No entries.</td></tr>'}</table>` +
      (reqs ? `<h2>OPEN INTERAGENCY REQUESTS</h2><table>${reqs}</table>` : ''),
  })
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
  const [showMarks, setShowMarks] = useState(false)
  if (page !== 3) return null

  const rows = timeline
    .filter((ev) => LOG_KINDS.has(ev.kind) && (showMarks || !NOISE_KINDS.has(ev.kind)))
    .slice(-200)
    .reverse()

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
        <button
          className={`dl-print${showMarks ? '' : ' dim'}`}
          onClick={() => setShowMarks((v) => !v)}
          title="Show the OPS CLOCK's 10-minute duration marks in the log (they never appear on the printed ICS-214 — PAR lapses always do)"
        >
          {showMarks ? '10-MIN MARKS ✓' : '10-MIN MARKS'}
        </button>
        <button
          className="dl-print"
          onClick={() => printIcs214(incident, timeline.filter((ev) => LOG_KINDS.has(ev.kind) && !NOISE_KINDS.has(ev.kind)))}
          title="ICS-214 activity log, print or save as PDF — decisions, benchmarks, notes and PAR lapses; the 10-minute drumbeat is omitted"
        >
          PRINT ICS-214
        </button>
        <button
          className="dl-print"
          disabled={!incident}
          onClick={printCommandPack}
          title="The whole incident on one printout: units by status, water assignments, the activity log, and open interagency requests — the relieving chief's handoff"
        >
          PRINT COMMAND PACK
        </button>
      </header>
      <CommandVitals />

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

      <AgencyRequestsBlock />

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
