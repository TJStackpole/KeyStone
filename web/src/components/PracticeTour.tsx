import { useMovable } from '../lib/movable'
import { setAppState, useAppSlice } from '../state/store'

// ---------------------------------------------------------------------------
// PRACTICE — a guided first run in plain language, for people who don't live
// in software. The checklist watches the SAME store signals as the guidance
// spine, so each step checks itself off the moment the real action happens
// (the glowing control on screen is always the current step). Nothing here
// can break anything: the demo is fully simulated.
// ---------------------------------------------------------------------------

interface TourStep {
  text: string
  done: boolean
}

export function PracticeTour() {
  const mvPractice = useMovable('practice')
  const { on, incident, inspected, isolateMode, viewLock, shapes } = useAppSlice((s) => ({
    on: s.practiceTour,
    incident: !!s.incident,
    inspected: !!s.inspected,
    isolateMode: s.isolateMode,
    viewLock: s.viewLock,
    shapes: s.shapes,
  }))
  if (!on) return null

  const hasPerimeter = Object.values(shapes).some((sh) => sh.kind === 'zone' && sh.zone === 'perimeter')
  const steps: TourStep[] = [
    { text: 'Find the building — type an address up top, or open SCENARIOS and press DEMO', done: incident || inspected },
    { text: 'Press the glowing ACTIVE INCIDENT button — that makes it official', done: incident },
    { text: 'Open ISOLATE (top right) and switch it ON — the view locks onto the building', done: incident && isolateMode },
    { text: 'Try the N / E / S / W buttons and the ▲▼ arrows — you are moving floor to floor', done: viewLock !== 'off' && viewLock !== 'top' },
    { text: 'Press PERIM on the left and click a few points around the block, then press Enter', done: hasPerimeter },
  ]
  const doneCount = steps.filter((st) => st.done).length
  const complete = doneCount === steps.length

  return (
    <aside {...mvPractice} className="practice-tour glass">
      <div className="practice-head">
        <b>PRACTICE RUN</b>
        <span className="practice-count">
          {doneCount}/{steps.length}
        </span>
        <button className="no-drag feed-close" onClick={() => setAppState({ practiceTour: false })} title="End practice">
          ✕
        </button>
      </div>
      <div className="practice-note">Take your time — everything here is simulated. You cannot break anything.</div>
      {steps.map((st, i) => (
        <div key={i} className={`practice-step${st.done ? ' done' : ''}`}>
          <span className="practice-check">{st.done ? '✓' : i + 1}</span>
          <span>{st.text}</span>
        </div>
      ))}
      {complete && (
        <div className="practice-done">
          THAT&apos;S THE WHOLE FLOW — you just ran an incident. Press ✕ END on the incident card (top-left) whenever you like.
        </div>
      )}
    </aside>
  )
}
