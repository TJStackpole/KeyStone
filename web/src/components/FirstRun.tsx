import { useEffect, useState } from 'react'
import { runDemoScenario } from '../actions'
import { useAppSlice } from '../state/store'
import './FirstRun.css'

// ---------------------------------------------------------------------------
// First 30 seconds: a fresh install opens to TWO obvious moves instead of a
// blank map with thirty controls. Gone forever after the first incident (or
// the ✕), stored per browser.
// ---------------------------------------------------------------------------

export function FirstRun() {
  const { incident, cadIncident, page } = useAppSlice((s) => ({
    incident: s.incident,
    cadIncident: s.cadIncident,
    page: s.dashboardPage,
  }))
  const [dismissed, setDismissed] = useState(localStorage.getItem('ks-firstrun') === '1')
  const done = () => {
    localStorage.setItem('ks-firstrun', '1')
    setDismissed(true)
  }
  // "Gone forever after the first incident" — persist that, whichever path
  // stood the incident up (search, voice, DISPATCH respond, scenario), so the
  // card doesn't resurrect when the box ends.
  useEffect(() => {
    if (incident || cadIncident) {
      localStorage.setItem('ks-firstrun', '1')
      setDismissed(true)
    }
  }, [incident, cadIncident])
  // page !== 0: never float over full-screen pages (DISPATCH, LOG, BOARD…) —
  // the card itself points users at DISPATCH.
  if (dismissed || incident || cadIncident || page !== 0) return null

  return (
    <div className="firstrun glass">
      <button className="firstrun-x" onClick={done} title="Dismiss — this card only shows once">
        ✕
      </button>
      <div className="firstrun-mark">KEYSTONE</div>
      <div className="firstrun-sub">FDNY INCIDENT COMMAND — COMMON OPERATING PICTURE</div>
      <button
        className="firstrun-primary"
        onClick={() => {
          done()
          void runDemoScenario()
        }}
      >
        ▶ RUN THE DEMO — STRUCTURAL FIRE, 100 GOLD ST
      </button>
      <div className="firstrun-or">
        or <b>search any NYC address</b> above · or open <b>DISPATCH</b> below and press a box to respond
      </div>
      <div className="firstrun-hint">Hold the mic button (or SPACE) and say “what can I say” for voice control.</div>
    </div>
  )
}
