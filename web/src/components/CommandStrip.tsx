import { useEffect, useMemo, useState } from 'react'
import { transmitAlarm } from '../actions'
import { ALARM_LADDER, alarmRank } from '../lib/alarms'
import { fmtElapsed } from '../lib/time'
import { replayEngine } from '../replay'
import { useAppSlice } from '../state/store'
import type { Agency } from '../types'

const AGENCIES: Agency[] = ['FDNY', 'EMS', 'NYPD', 'PAPD', 'OEM']


/**
 * Replay scrub row: subscribes to the engine's fast clock DIRECTLY, so the
 * 8.3 Hz playback tick re-renders only this small row instead of pushing
 * replay.t through the global store and re-rendering every panel.
 */
function ReplayStrip({ playing, duration }: { playing: boolean; duration: number }) {
  const [t, setT] = useState(() => replayEngine.getT())
  useEffect(() => replayEngine.subscribeT(setT), [])
  return (
    <div className="command-strip glass replaying">
      <span className="strip-label replay-label">REPLAY 4×</span>
      <button className="strip-btn" onClick={() => replayEngine.setPlaying(!playing)}>
        {playing ? '❚❚' : '▶'}
      </button>
      <input
        className="replay-scrub"
        type="range"
        min={0}
        max={duration}
        value={t}
        onChange={(e) => replayEngine.seek(Number(e.target.value))}
      />
      <span className="strip-mono">
        T+{fmtElapsed(t)} / {fmtElapsed(duration)}
      </span>
      <button className="strip-btn exit" onClick={() => replayEngine.stop()}>
        EXIT REPLAY
      </button>
    </div>
  )
}

const PAR_PRESETS = [10, 15, 20, 30]

/** OPS CLOCK chips: the 10-minute drumbeat countdown and the PAR cycle.
 *  Interval default 20 min — VALIDATE—SME (FDNY's real cadence TBC); the
 *  preference persists locally and mirrors to the server clock. */
function OpsChips({ incident, timeline }: { incident: { createdAt: string }; timeline: { t: string; kind: string; payload?: unknown }[] }) {
  const [parMin, setParMin] = useState(() => {
    const v = Number(localStorage.getItem('ks-par-interval'))
    return PAR_PRESETS.includes(v) ? v : 20
  })
  // The server clock is authoritative: adopt its interval AND its anchors on
  // mount. The client's timeline window is truncated (~600 events) — on a
  // long box the last mark/PAR can fall out of it, which would pin the MK
  // chip at a past mark and show a false PAR-overdue. Anchors only move
  // forward, so max(client-derived, server snapshot) is always right.
  const [anchors, setAnchors] = useState<{ lastMark: number; lastParAt: number }>({ lastMark: 0, lastParAt: 0 })
  useEffect(() => {
    let dead = false
    fetch('/api/ops/par-interval')
      .then((r) => (r.ok ? r.json() : null))
      .then((p: { minutes?: number; lastMark?: number; lastParAt?: number } | null) => {
        if (dead || !p) return
        if (PAR_PRESETS.includes(Number(p.minutes))) setParMin(Number(p.minutes))
        setAnchors({ lastMark: Number(p.lastMark) || 0, lastParAt: Number(p.lastParAt) || 0 })
      })
      .catch(() => {})
    return () => {
      dead = true
    }
  }, [])

  const started = Date.parse(incident.createdAt)
  let lastPar = Math.max(started, anchors.lastParAt || 0)
  let lastMark = anchors.lastMark
  for (const ev of timeline) {
    if (ev.kind === 'ic.par-complete') {
      const t = Date.parse(ev.t)
      if (t > lastPar) lastPar = t
    } else if (ev.kind === 'ops.duration-mark') {
      const m = Number((ev.payload as { minutes?: number } | undefined)?.minutes)
      if (Number.isFinite(m) && m > lastMark) lastMark = m
    }
  }
  const now = Date.now()
  const parLeft = lastPar + parMin * 60_000 - now
  const parTone = parLeft <= 0 ? ' overdue' : parLeft <= 120_000 ? ' warn' : ''
  // Hold at MK{n} 00:00 until the server's mark actually lands on the record —
  // rolling to the next window early would contradict the banner by ~15 s.
  const dueMark = Math.floor((now - started) / 600_000) * 10
  const nextMark = lastMark >= dueMark ? lastMark + 10 : Math.max(dueMark, 10)

  return (
    <>
      <span className="strip-mono ops-mark" title={`Next duration mark: ${nextMark} minutes on the box`}>
        MK{nextMark} {fmtElapsed(started + nextMark * 60_000 - now)}
      </span>
      <button
        className={`strip-mono par-chip${parTone}`}
        onClick={() => {
          const next = PAR_PRESETS[(PAR_PRESETS.indexOf(parMin) + 1) % PAR_PRESETS.length]
          setParMin(next)
          try {
            localStorage.setItem('ks-par-interval', String(next))
          } catch {
            // storage blocked — session-only preference
          }
          void fetch('/api/ops/par-interval', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ minutes: next }),
          }).catch(() => {})
        }}
        title={`PAR cycle: every ${parMin} min (VALIDATE—SME — confirm FDNY cadence). Complete a PAR on the RIDING LIST (or log one on the DECISION LOG) to reset. Click to change the interval.`}
      >
        PAR {parLeft <= 0 ? `+${fmtElapsed(-parLeft)}` : fmtElapsed(parLeft)}
      </button>
    </>
  )
}

/** Phase 8 command header: elapsed clock, on-scene counts, alarm level, replay. */
export function CommandStrip() {
  const { incident, units, replay, timeline } = useAppSlice((s) => ({ incident: s.incident, units: s.units, replay: s.replay, timeline: s.timeline }))
  const [collapsed, setCollapsed] = useState(false)
  const [, forceTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const counts = useMemo(() => {
    const out: Record<Agency, { onScene: number; total: number }> = {
      FDNY: { onScene: 0, total: 0 },
      EMS: { onScene: 0, total: 0 },
      NYPD: { onScene: 0, total: 0 },
      PAPD: { onScene: 0, total: 0 },
      OEM: { onScene: 0, total: 0 },
      TAK: { onScene: 0, total: 0 },
    }
    for (const u of Object.values(units)) {
      out[u.agency].total++
      if (u.status && u.status !== 'Enroute') out[u.agency].onScene++
    }
    return out
  }, [units])

  if (!incident) return null

  const elapsed = Date.now() - Date.parse(incident.createdAt)
  // null until something is actually transmitted — a fresh box must not
  // render 10-75 as reached/current when no 10-75 ever went out.
  const currentAlarm = incident.alarmLevel ?? null

  if (replay.active) {
    return <ReplayStrip playing={replay.playing} duration={replay.duration} />
  }

  if (collapsed) {
    return (
      <button className="command-strip glass collapsed" onClick={() => setCollapsed(false)} title="Expand command strip">
        <span className="strip-mono elapsed">T+{fmtElapsed(elapsed)}</span>
        <span className="chev closed">▾</span>
      </button>
    )
  }

  return (
    <div className="command-strip glass">
      <button className="strip-collapse" onClick={() => setCollapsed(true)} title="Minimize command strip">
        ▴
      </button>
      <span className="strip-mono elapsed">T+{fmtElapsed(elapsed)}</span>
      <OpsChips incident={incident} timeline={timeline} />
      <span className="strip-counts">
        {AGENCIES.filter((a) => counts[a].total > 0).map((a) => (
          <span key={a} className="count-chip">
            {a} <b>{counts[a].onScene}</b>/{counts[a].total}
          </span>
        ))}
      </span>
      <span className="strip-alarms">
        {ALARM_LADDER.map((a) => {
          const reached = alarmRank(currentAlarm) >= alarmRank(a.id)
          return (
            <button
              key={a.id}
              className={`alarm-btn${reached ? ' reached' : ''}${currentAlarm === a.id ? ' current' : ''}`}
              disabled={reached}
              onClick={() => void transmitAlarm(a.id)}
              title={reached ? `${a.label} already transmitted — alarms only climb` : `Transmit ${a.label}`}
            >
              {a.short}
            </button>
          )
        })}
      </span>
      <button className="strip-btn replay" onClick={() => void replayEngine.start()} title="Re-run the incident timeline at 4×">
        ⟲ REPLAY
      </button>
    </div>
  )
}
