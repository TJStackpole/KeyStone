import { useRef, useState } from 'react'
import { jumpScenarioChapter, pauseScenario, playScenario, seekScenario, setScenarioSpeed, stopScenario } from '../actions'
import { useMovable } from '../lib/movable'
import { useCapability } from '../profiles/manifest'
import { useAppSlice } from '../state/store'

function fmtClock(s: number): string {
  const m = Math.floor(s / 60)
  const ss = Math.floor(s % 60)
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

/**
 * Scenario playback transport (Prompt 8A): DRILL badge, play/pause, speed,
 * chapter jumps. Rendered only while a scenario is loaded — the badge is the
 * always-on "DRILL — SIMULATED INCIDENT" label required by exercise practice.
 */
export function ScenarioBar() {
  const mvScenariobar = useMovable('scenario-bar')
  const { scenario } = useAppSlice((s) => ({ scenario: s.scenario }))
  const canEndExercise = useCapability('aar.hseep-exercise')
  // Pointer-capture scrubbing: live ghost fill while dragging, seeks
  // throttled to ~150 ms, final seek on release.
  const [ghostFrac, setGhostFrac] = useState<number | null>(null)
  const lastSeek = useRef(0)
  if (!scenario) return null
  const current = [...scenario.chapters].reverse().find((c) => c.t <= scenario.clock)
  const atEnd = scenario.duration > 0 && scenario.clock >= scenario.duration
  const minLeft = scenario.duration > 0 ? Math.max(0, Math.ceil((scenario.duration - scenario.clock) / Math.max(1, scenario.speed) / 60)) : 0

  const fracFrom = (clientX: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }

  return (
    <div {...mvScenariobar} className="scenario-bar glass">
      <span className="drill-badge">DRILL — SIMULATED INCIDENT</span>
      {atEnd ? (
        <button
          className="scn-btn replay"
          onClick={() => void seekScenario(0).then(() => playScenario())}
          title="Run the drill again from the start"
        >
          ↺ REPLAY
        </button>
      ) : (
        <button
          className="scn-btn"
          onClick={() => void (scenario.playing ? pauseScenario() : playScenario())}
          title={scenario.playing ? 'Pause playback' : 'Play'}
        >
          {scenario.playing ? '❚❚' : '▶'}
        </button>
      )}
      <span className="scn-clock" title={`Elapsed / total drill time (compressed ${scenario.speed}× — ≈${minLeft} real minutes left)`}>
        T+{fmtClock(scenario.clock)}
        {scenario.duration > 0 && <i> / {fmtClock(scenario.duration)}</i>}
      </span>
      {scenario.duration > 0 && (
        <div
          // no-drag: the universal scrub gesture must scrub, never relocate
          // the transport bar (confirmed live footgun).
          className={`scn-progress no-drag${atEnd ? ' done' : ''}`}
          title="Scrub the drill — drag or click to seek"
          onPointerDown={(e) => {
            if (e.button !== 0) return
            const el = e.currentTarget
            el.setPointerCapture(e.pointerId)
            const frac = fracFrom(e.clientX, el)
            setGhostFrac(frac)
            lastSeek.current = Date.now()
            void seekScenario(frac * scenario.duration)
          }}
          onPointerMove={(e) => {
            if (ghostFrac === null || !e.currentTarget.hasPointerCapture(e.pointerId)) return
            const frac = fracFrom(e.clientX, e.currentTarget)
            setGhostFrac(frac)
            if (Date.now() - lastSeek.current > 150) {
              lastSeek.current = Date.now()
              void seekScenario(frac * scenario.duration)
            }
          }}
          onPointerUp={(e) => {
            if (ghostFrac === null) return
            const frac = fracFrom(e.clientX, e.currentTarget)
            setGhostFrac(null)
            void seekScenario(frac * scenario.duration)
          }}
        >
          <div
            className="scn-progress-fill"
            style={{ width: `${Math.min(100, (ghostFrac ?? scenario.clock / scenario.duration) * 100)}%` }}
          />
          {scenario.chapters.map((c) => (
            <span key={c.id} className="scn-progress-tick" style={{ left: `${(c.t / scenario.duration) * 100}%` }} />
          ))}
        </div>
      )}
      {[1, 4, 10].map((x) => (
        <button
          key={x}
          className={`scn-speed${scenario.speed === x ? ' on' : ''}`}
          onClick={() => void setScenarioSpeed(x)}
          title={`${x}× time compression — this ${Math.round(scenario.duration / 60)}-minute drill plays in ≈${Math.max(1, Math.round(scenario.duration / x / 60))} real minutes`}
        >
          {x}×
        </button>
      ))}
      <span className="scn-divider" />
      {scenario.chapters.map((c) => (
        <button
          key={c.id}
          className={`scn-chapter${current?.id === c.id ? ' on' : ''}`}
          onClick={() => void jumpScenarioChapter(c.id)}
          title={`Jump to ${c.title}`}
        >
          {c.title}
        </button>
      ))}
      {(!scenario.exercise || canEndExercise) ? (
        <button className="scn-btn stop" onClick={() => void stopScenario()} title="End the drill and clear it from the picture">
          ✕
        </button>
      ) : (
        <span className="scn-facilitator" title="A live exercise is recording — end it from the NYCEM workspace (switch profiles via the KEYSTONE wordmark)">
          FACILITATOR-CONTROLLED
        </span>
      )}
    </div>
  )
}
