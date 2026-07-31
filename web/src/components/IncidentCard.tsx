import { useEffect, useRef, useState } from 'react'
import { changeIncidentType, editIncidentAddress, endIncident } from '../actions'
import { autocompleteAddress } from '../api/geosearch'
import { useAppState } from '../state/store'
import { INCIDENT_TYPES, type GeoHit, type Incident } from '../types'

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

/**
 * Live address correction — dispatch addresses are wrong often enough that
 * the IC must be able to fix one mid-incident. Picking a geocoded suggestion
 * RELOCATES the incident (camera, footprints, intel move; units, shapes, and
 * the timeline stay); pressing Enter on free text corrects the label only.
 */
function EditableAddress({ incident }: { incident: Incident }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [hits, setHits] = useState<GeoHit[]>([])
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  // Debounced GeoSearch autocomplete (same keyless API as the search bar).
  useEffect(() => {
    if (!editing || text.trim().length < 3) {
      setHits([])
      return
    }
    const t = setTimeout(() => {
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      autocompleteAddress(text.trim(), ac.signal)
        .then(setHits)
        .catch(() => {}) // aborted or offline — suggestions just stay empty
    }, 250)
    return () => clearTimeout(t)
  }, [editing, text])

  const open = () => {
    setText(incident.address)
    setHits([])
    setEditing(true)
  }
  const close = () => {
    abortRef.current?.abort()
    setEditing(false)
    setHits([])
    setSaving(false)
  }
  const commit = async (update: { label: string; hit?: GeoHit }) => {
    if (saving || !update.label.trim()) return // double-commit guard
    setSaving(true)
    setHits([])
    const ok = await editIncidentAddress(update)
    if (ok) close()
    else setSaving(false) // keep the editor open so the correction isn't lost
  }

  if (!editing) {
    return (
      <div className="addr">
        <span className="addr-text">{incident.address}</span>
        <button className="addr-edit-btn" onClick={open} title="Correct the incident address (live)">
          ✎
        </button>
      </div>
    )
  }

  return (
    <div className="addr editing">
      <input
        ref={inputRef}
        className="addr-input"
        value={text}
        disabled={saving}
        placeholder="Corrected address…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            // Prefer an exact geocoded match so a typed-out pick relocates too.
            const exact = hits.find((h) => h.label.toLowerCase() === text.trim().toLowerCase())
            void commit(exact ? { label: exact.label, hit: exact } : { label: text.trim() })
          }
          if (e.key === 'Escape') close()
        }}
      />
      <button className="addr-edit-btn" onClick={close} disabled={saving} title="Cancel">
        ✕
      </button>
      {hits.length > 0 && (
        <ul className="addr-suggest glass">
          {hits.map((h) => (
            <li key={`${h.label}:${h.lat}`}>
              <button disabled={saving} onClick={() => void commit({ label: h.label, hit: h })}>
                {h.label}
                <i>RELOCATES INCIDENT</i>
              </button>
            </li>
          ))}
          <li className="addr-hint">ENTER = LABEL-ONLY CORRECTION · PICK A MATCH TO MOVE THE INCIDENT</li>
        </ul>
      )}
    </div>
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
      <EditableAddress incident={incident} />
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
