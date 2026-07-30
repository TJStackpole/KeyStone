import { useEffect, useState } from 'react'
import { changeIncidentType, endIncident } from '../actions'
import { useAppState } from '../state/store'
import { INCIDENT_TYPES } from '../types'

/** Two-click END control: first click arms CONFIRM, second tears the board down. */
function EndIncidentButton() {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3500)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button
      className={`end-incident${armed ? ' armed' : ''}`}
      aria-pressed={armed}
      aria-live="polite"
      aria-label={armed ? 'Confirm ending the incident — this clears the board' : 'End incident (two-step confirm)'}
      onClick={(e) => {
        e.stopPropagation()
        if (armed) void endIncident()
        else setArmed(true)
      }}
      title="Cancel any drill, demo, or live incident and clear the board"
    >
      {armed ? 'CONFIRM END?' : '✕ END'}
    </button>
  )
}

export function IncidentCard() {
  const { incident } = useAppState()
  const [collapsed, setCollapsed] = useState(false)
  if (!incident) return null

  const created = new Date(incident.createdAt)
  const hhmmss = created.toTimeString().slice(0, 8)

  if (collapsed) {
    return (
      <section className="incident-card glass collapsed">
        <button className="card-head as-btn" onClick={() => setCollapsed(false)}>
          <span className="card-title">Incident</span>
          <span className="incident-id">{incident.id}</span>
          <span className="pulse" title="Active incident" />
          <span className="chev closed">▾</span>
        </button>
      </section>
    )
  }

  return (
    <section className="incident-card glass">
      <button className="card-head as-btn" onClick={() => setCollapsed(true)}>
        <span className="card-title">Incident</span>
        <span className="incident-id">{incident.id}</span>
        <span className="pulse" title="Active incident" />
        <span className="chev">▾</span>
      </button>
      <EndIncidentButton />
      <div className="addr">{incident.address}</div>
      <div className="meta">
        {incident.bin && (
          <span>
            BIN <b>{incident.bin}</b>
          </span>
        )}
        {incident.bbl && (
          <span>
            BBL <b>{incident.bbl}</b>
          </span>
        )}
        <span>
          STOOD UP <b>{hhmmss}</b>
        </span>
      </div>
      <div className="seg" role="radiogroup" aria-label="Incident type">
        {INCIDENT_TYPES.map((t) => (
          <button
            key={t}
            className={incident.type === t ? 'on' : ''}
            role="radio"
            aria-checked={incident.type === t}
            onClick={() => void changeIncidentType(t)}
          >
            {t}
          </button>
        ))}
      </div>
    </section>
  )
}
