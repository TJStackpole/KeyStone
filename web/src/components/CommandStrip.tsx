import { useEffect, useMemo, useState } from 'react'
import { replayEngine } from '../replay'
import { useAppState } from '../state/store'
import type { Agency, AlarmLevel } from '../types'

const ALARMS: { id: AlarmLevel; label: string }[] = [
  { id: '10-75', label: '10-75' },
  { id: 'all-hands', label: 'ALL HANDS' },
  { id: '2nd', label: '2ND ALARM' },
  { id: '3rd', label: '3RD ALARM' },
]

const ALARM_ORDER: AlarmLevel[] = ['10-75', 'all-hands', '2nd', '3rd']
const AGENCIES: Agency[] = ['FDNY', 'EMS', 'NYPD', 'OEM']

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`
}

async function setAlarm(level: AlarmLevel): Promise<void> {
  try {
    await fetch('/api/alarm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level }),
    })
  } catch (err) {
    console.error('[alarm] failed:', err)
  }
}

/** Phase 8 command header: elapsed clock, on-scene counts, alarm level, replay. */
export function CommandStrip() {
  const { incident, units, replay } = useAppState()
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
  const currentAlarm = incident.alarmLevel ?? '10-75'

  if (replay.active) {
    return (
      <div className="command-strip glass replaying">
        <span className="strip-label replay-label">REPLAY 4×</span>
        <button className="strip-btn" onClick={() => replayEngine.setPlaying(!replay.playing)}>
          {replay.playing ? '❚❚' : '▶'}
        </button>
        <input
          className="replay-scrub"
          type="range"
          min={0}
          max={replay.duration}
          value={replay.t}
          onChange={(e) => replayEngine.seek(Number(e.target.value))}
        />
        <span className="strip-mono">
          T+{fmtElapsed(replay.t)} / {fmtElapsed(replay.duration)}
        </span>
        <button className="strip-btn exit" onClick={() => replayEngine.stop()}>
          EXIT REPLAY
        </button>
      </div>
    )
  }

  return (
    <div className="command-strip glass">
      <span className="strip-mono elapsed">T+{fmtElapsed(elapsed)}</span>
      <span className="strip-counts">
        {AGENCIES.filter((a) => counts[a].total > 0).map((a) => (
          <span key={a} className="count-chip">
            {a} <b>{counts[a].onScene}</b>/{counts[a].total}
          </span>
        ))}
      </span>
      <span className="strip-alarms">
        {ALARMS.map((a) => {
          const reached = ALARM_ORDER.indexOf(currentAlarm) >= ALARM_ORDER.indexOf(a.id)
          return (
            <button
              key={a.id}
              className={`alarm-btn${reached ? ' reached' : ''}${currentAlarm === a.id ? ' current' : ''}`}
              onClick={() => void setAlarm(a.id)}
              title={`Transmit ${a.label}`}
            >
              {a.label}
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
