import { changeIncidentType } from '../actions'
import { useAppState } from '../state/store'
import { INCIDENT_TYPES } from '../types'

export function IncidentCard() {
  const { incident } = useAppState()
  if (!incident) return null

  const created = new Date(incident.createdAt)
  const hhmmss = created.toTimeString().slice(0, 8)

  return (
    <section className="incident-card glass">
      <div className="card-head">
        <span className="card-title">Incident</span>
        <span className="incident-id">{incident.id}</span>
        <span className="pulse" title="Active incident" />
      </div>
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
