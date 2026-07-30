import { jumpScenarioChapter, pauseScenario, playScenario, setScenarioSpeed, stopScenario } from '../actions'
import { useAppState } from '../state/store'

function fmtClock(s: number): string {
  const m = Math.floor(s / 60)
  const ss = Math.floor(s % 60)
  return `T+${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

/**
 * Scenario playback transport (Prompt 8A): DRILL badge, play/pause, speed,
 * chapter jumps. Rendered only while a scenario is loaded — the badge is the
 * always-on "DRILL — SIMULATED INCIDENT" label required by exercise practice.
 */
export function ScenarioBar() {
  const { scenario } = useAppState()
  if (!scenario) return null
  const current = [...scenario.chapters].reverse().find((c) => c.t <= scenario.clock)
  return (
    <div className="scenario-bar glass">
      <span className="drill-badge">DRILL — SIMULATED INCIDENT</span>
      <button
        className="scn-btn"
        onClick={() => void (scenario.playing ? pauseScenario() : playScenario())}
        title={scenario.playing ? 'Pause playback' : 'Play'}
      >
        {scenario.playing ? '❚❚' : '▶'}
      </button>
      <span className="scn-clock">{fmtClock(scenario.clock)}</span>
      {[1, 4, 10].map((x) => (
        <button
          key={x}
          className={`scn-speed${scenario.speed === x ? ' on' : ''}`}
          onClick={() => void setScenarioSpeed(x)}
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
      <button className="scn-btn stop" onClick={() => void stopScenario()} title="End the drill and clear it from the picture">
        ✕
      </button>
    </div>
  )
}
