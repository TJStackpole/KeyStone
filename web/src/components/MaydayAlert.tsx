import { useEffect, useState } from 'react'
import { flyToAlert } from '../actions'
import { setAppState, useAppSlice } from '../state/store'

/**
 * Full-screen emergency alert (mayday / zone breach). The red frame stays up
 * until the alert clears; the card can be acknowledged out of the way. A
 * running clock shows time since transmission — the number every IC watches.
 */
export function MaydayAlert() {
  const { alert } = useAppSlice((s) => ({ alert: s.alert }))
  const [acked, setAcked] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setAcked(false)
    if (!alert) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [alert])

  if (!alert) return null
  const elapsed = alert.at ? Math.max(0, Math.floor((now - Date.parse(alert.at)) / 1000)) : 0
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')

  return (
    <>
      <div className="mayday-frame" />
      {!acked && (
        <div className="mayday-card glass">
          <div className="mayday-title">⚠ {alert.kind.toUpperCase()}</div>
          {alert.callsign && <div className="mayday-unit">{alert.callsign}</div>}
          {alert.text && <div className="mayday-text">{alert.text}</div>}
          <div className="mayday-clock">
            {mm}:{ss} SINCE TRANSMISSION
          </div>
          <div className="mayday-actions">
            {alert.uid && (
              <button className="chip chip-btn" onClick={() => flyToAlert(alert)}>
                CENTER ON MEMBER
              </button>
            )}
            <button className="chip chip-btn amber active" onClick={() => setAcked(true)}>
              ACKNOWLEDGE
            </button>
            <button className="chip chip-btn" onClick={() => setAppState({ alert: null })}>
              CLEAR
            </button>
          </div>
        </div>
      )}
    </>
  )
}
