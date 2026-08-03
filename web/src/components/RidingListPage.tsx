import { useEffect, useMemo, useState } from 'react'
import { isApparatus } from '../lib/crews'
import { setDashboardPage } from '../lib/layouts'
import { airTone } from '../lib/scba'
import { fmtWallClock } from '../lib/time'
import { setAppState, useAppSlice } from '../state/store'
import { crewCompositionAllowed } from '../profiles/policy'
import { useProfile } from '../profiles/manifest'
import { crewOf } from '../types'
import type { Unit } from '../types'
import './RidingListPage.css'

// ---------------------------------------------------------------------------
// Dashboard page 2 — RIDING LIST / ACCOUNTABILITY. The paper riding list a
// chief falls back on, digital: one card per apparatus, its riding members
// underneath, and a big PAR button per card. Deliberately plain DOM — zero
// Cesium, huge type — so it keeps working even if the 3D view dies.
// ---------------------------------------------------------------------------

interface Card {
  callsign: string
  status: string
  members: Unit[]
}

/** Natural sort so E-10 lands after E-6, not between E-1 and E-2. */
function byCallsign(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * One card per apparatus (anything that isn't an individual member or a
 * drone). Members ride slash callsigns — "E-6/1" belongs to "E-6" — and a
 * crew whose apparatus isn't itself tracked still gets a card, because the
 * whole point of this board is that nobody goes unaccounted for.
 */
function buildCards(units: Record<string, Unit>): Card[] {
  const members = new Map<string, Unit[]>()
  const apparatus = new Map<string, Unit>()
  for (const u of Object.values(units)) {
    if (u.callsign.includes('/')) {
      const crew = crewOf(u.callsign)
      const list = members.get(crew)
      if (list) list.push(u)
      else members.set(crew, [u])
      continue
    }
    if (!isApparatus(u)) continue
    apparatus.set(u.callsign, u)
  }
  const names = new Set([...apparatus.keys(), ...members.keys()])
  return [...names].sort(byCallsign).map((callsign) => ({
    callsign,
    status: apparatus.get(callsign)?.status ?? '',
    members: (members.get(callsign) ?? []).sort((a, b) => byCallsign(a.callsign, b.callsign)),
  }))
}

/** Shared SCBA thresholds mapped to this board's tone classes. */
function airClass(psi: number): string {
  const tone = airTone(psi)
  return tone === 'low' ? ' red' : tone === 'warn' ? ' amber' : ''
}

/** A completed PAR is a COMMAND event: log it on the incident record (which
 *  also resets the OPS CLOCK's PAR countdown server-side). Returns whether
 *  the record actually took it. */
async function postParComplete(units: string[]): Promise<boolean> {
  try {
    const res = await fetch('/api/timeline', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'ic.par-complete', payload: { units } }),
    })
    return res.ok
  } catch (err) {
    console.error('[par] log failed:', err)
    return false
  }
}

/** Stamp cards only AFTER the record takes the PAR — a green "JUST NOW"
 *  with nothing on the record would be the exact lie this board exists to
 *  prevent. */
function stampPar(callsign: string): void {
  void postParComplete([callsign]).then((ok) => {
    if (ok) setAppState((s) => ({ parChecks: { ...s.parChecks, [callsign]: Date.now() } }))
  })
}

function stampParAll(callsigns: string[]): void {
  if (callsigns.length === 0) return
  void postParComplete(callsigns).then((ok) => {
    if (!ok) return
    const t = Date.now()
    setAppState((s) => {
      const next = { ...s.parChecks }
      for (const c of callsigns) next[c] = t
      return { parChecks: next }
    })
  })
}

function ApparatusCard({ card, par, now, membersAllowed }: { card: Card; par: number | undefined; now: number; membersAllowed: boolean }) {
  // Minutes since last PAR — clamped so a stamp newer than the 10 s tick
  // never reads negative.
  const age = par === undefined ? null : Math.max(0, Math.floor((now - par) / 60_000))
  const tone = age === null ? '' : age > 30 ? ' overdue' : age > 20 ? ' stale' : ''
  const agoLabel = age === null ? null : age < 1 ? 'JUST NOW' : `${age} MIN AGO`
  return (
    <section className={`rp-card${tone}`}>
      <header className="rp-card-head">
        <span className="rp-callsign">{card.callsign}</span>
        {card.status !== '' && <span className="rp-status">{card.status.toUpperCase()}</span>}
      </header>
      {!membersAllowed ? (
        <div className="rp-nodata">MEMBER DETAIL RESTRICTED BY VISIBILITY POLICY</div>
      ) : card.members.length === 0 ? (
        <div className="rp-nodata">NO MEMBER DATA — riding list per MDT</div>
      ) : (
        <ul className="rp-members">
          {card.members.map((m) => {
            const interior = typeof m.floor === 'number' && m.floor > 0
            const psiRaw = m.bio?.airPsi
            // Negative psi is the sim's "no cylinder data" sentinel.
            const psi = typeof psiRaw === 'number' && psiRaw >= 0 ? psiRaw : null
            return (
              <li key={m.uid} className="rp-row">
                <span className="rp-member">{m.callsign}</span>
                <span className={`rp-floor${interior ? ' in' : ''}`}>{interior ? `FL ${m.floor}` : 'EXT'}</span>
                <span className="rp-mstatus">{m.status ? m.status.toUpperCase() : '—'}</span>
                {psi === null ? (
                  <span className="rp-air none">—</span>
                ) : (
                  <span className={`rp-air${airClass(psi)}`}>{Math.round(psi)} PSI</span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <footer className="rp-card-foot">
        {par !== undefined && agoLabel !== null && (
          <div className={`rp-par-when${tone}`}>
            PAR {fmtWallClock(par)}
            <span className="rp-par-ago">{agoLabel}</span>
          </div>
        )}
        <button className="rp-btn rp-par" onClick={() => stampPar(card.callsign)}>
          PAR ✓
        </button>
      </footer>
    </section>
  )
}

export function RidingListPage() {
  const { page, incident, units, parChecks, visibilityPolicy } = useAppSlice((s) => ({ visibilityPolicy: s.visibilityPolicy,
    page: s.dashboardPage,
    incident: s.incident,
    units: s.units,
    parChecks: s.parChecks,
  }))
  const profileRl = useProfile()
  // Same invariant as the roster: member-level detail renders only when the
  // cross-agency policy allows crew composition for this workspace.
  const membersAllowed = crewCompositionAllowed(profileRl, visibilityPolicy)

  // Self-ticking clock so "N MIN AGO" and the stale/overdue tones advance
  // without any store traffic. Only runs while this page is showing.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (page !== 2) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 10_000)
    return () => window.clearInterval(id)
  }, [page])

  const cards = useMemo(() => buildCards(units), [units])
  const totals = useMemo(() => {
    let membersTotal = 0
    let interior = 0
    for (const c of cards) {
      membersTotal += c.members.length
      for (const m of c.members) if (typeof m.floor === 'number' && m.floor > 0) interior++
    }
    return { membersTotal, interior }
  }, [cards])

  if (page !== 2) return null

  return (
    <div className="riding-page" role="region" aria-label="Riding list and PAR accountability board">
      <header className="rp-head">
        <button className="rp-btn rp-back" onClick={() => setDashboardPage(0)}>
          ◀ MAP
        </button>
        <div className="rp-title">
          <h1>RIDING LIST · PAR</h1>
          <div className="rp-address">{incident ? incident.address.toUpperCase() : 'NO ACTIVE INCIDENT'}</div>
        </div>
        <div className="rp-totals">
          <span className="rp-total">{totals.membersTotal} MEMBERS</span>
          <span className="rp-sep">/</span>
          <span className="rp-total in">{totals.interior} INTERIOR</span>
        </div>
        <button
          className="rp-btn rp-par-all"
          onClick={() => stampParAll(cards.map((c) => c.callsign))}
          disabled={cards.length === 0}
        >
          PAR ALL ({cards.length})
        </button>
      </header>
      {cards.length === 0 ? (
        <div className="rp-empty">NO UNITS TRACKED — riding lists build as companies check in</div>
      ) : (
        <div className="rp-grid">
          {cards.map((c) => (
            <ApparatusCard key={c.callsign} card={c} par={parChecks[c.callsign]} now={now} membersAllowed={membersAllowed} />
          ))}
        </div>
      )}
    </div>
  )
}
