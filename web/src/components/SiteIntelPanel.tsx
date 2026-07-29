import { useState } from 'react'
import { flyToFeature, toggleLayer } from '../actions'
import { buildingLinks } from '../api/nyc'
import { formatMeters } from '../lib/geo'
import { useAppState } from '../state/store'
import type { LayerStatus, ToggleLayerId } from '../types'

function StatusNote({ status, empty }: { status: LayerStatus; empty?: string }) {
  if (status === 'loading') return <div className="intel-note">QUERYING NYC OPEN DATA…</div>
  if (status === 'unavailable')
    return (
      <div className="intel-note warn">
        <span className="dot" /> LAYER UNAVAILABLE
      </div>
    )
  if (status === 'ok' && empty) return <div className="intel-note">{empty}</div>
  return null
}

const TOGGLES: { id: ToggleLayerId; label: string }[] = [
  { id: 'footprints', label: 'Bldgs' },
  { id: 'hydrants', label: 'Hydrants' },
  { id: 'firehouses', label: 'Houses' },
  { id: 'battalions', label: 'Battalions' },
  { id: 'divisions', label: 'Divisions' },
]

export function SiteIntelPanel() {
  const { incident, intel, layers, layerToggles } = useAppState()
  const [collapsed, setCollapsed] = useState(false)

  if (!incident) return null

  const pluto = intel.pluto
  const hydrants = intel.hydrants.slice(0, 3)
  const firehouses = intel.firehouses.slice(0, 3)

  return (
    <aside className={`intel-panel glass${collapsed ? ' collapsed' : ''}`}>
      <button className="intel-head" onClick={() => setCollapsed((c) => !c)}>
        <span className="card-title">Site Intel</span>
        <span className="intel-bin">{incident.bin ? `BIN ${incident.bin}` : ''}</span>
        <span className={`chev${collapsed ? ' closed' : ''}`}>▾</span>
      </button>

      {!collapsed && (
        <div className="intel-body">
          <div className="intel-toggles">
            {TOGGLES.map((t) => (
              <button
                key={t.id}
                className={`toggle-chip${layerToggles[t.id] ? ' on' : ''}`}
                onClick={() => toggleLayer(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="intel-section">
            <div className="intel-section-title">Structure · PLUTO</div>
            <StatusNote status={layers.pluto} empty={pluto ? undefined : 'NO PARCEL RECORD'} />
            {pluto && (
              <div className="pluto-grid">
                <div>
                  <span>Floors</span>
                  <b>{pluto.numFloors ?? '—'}</b>
                </div>
                <div>
                  <span>Year built</span>
                  <b>{pluto.yearBuilt || '—'}</b>
                </div>
                <div>
                  <span>Land use</span>
                  <b>{pluto.landUse ?? pluto.landUseCode ?? '—'}</b>
                </div>
                <div>
                  <span>Bldg class</span>
                  <b>{pluto.bldgClass ?? '—'}</b>
                </div>
                <div>
                  <span>Lot area</span>
                  <b>{pluto.lotAreaSqFt ? `${pluto.lotAreaSqFt.toLocaleString()} ft²` : '—'}</b>
                </div>
              </div>
            )}
          </div>

          <div className="intel-section">
            <div className="intel-section-title">DOB &amp; Housing · Violations</div>
            <StatusNote
              status={layers.safety}
              empty={intel.safety ? undefined : incident.bin ? 'NO RECORDS' : 'NO BIN FOR THIS LOCATION'}
            />
            {intel.safety && (
              <>
                <div className="safety-grid">
                  <div>
                    <span>DOB viol.</span>
                    <b className={intel.safety.dobActive > 0 ? 'hot' : ''}>
                      {intel.safety.dobActive}
                      <i>/{intel.safety.dobTotal}</i>
                    </b>
                  </div>
                  <div>
                    <span>ECB/OATH</span>
                    <b className={intel.safety.ecbActive > 0 ? 'hot' : ''}>
                      {intel.safety.ecbActive}
                      <i>/{intel.safety.ecbTotal}</i>
                    </b>
                  </div>
                  <div>
                    <span>Complaints</span>
                    <b className={intel.safety.complaintsActive > 0 ? 'hot' : ''}>
                      {intel.safety.complaintsActive}
                      <i>/{intel.safety.complaintsTotal}</i>
                    </b>
                  </div>
                  <div>
                    <span>HPD viol.</span>
                    <b className={intel.safety.hpdOpen > 0 ? 'hot' : ''}>
                      {intel.safety.hpdOpen}
                      <i>/{intel.safety.hpdTotal}</i>
                    </b>
                  </div>
                </div>
                <div className="safety-legend">ACTIVE / TOTAL · NYC OPEN DATA</div>
                {intel.safety.recent.slice(0, 3).map((v, i) => (
                  <div key={i} className="safety-row" title={v.description}>
                    <span className="safety-date">{v.date}</span>
                    <span className="safety-desc">{v.type || v.description || 'DOB violation'}</span>
                  </div>
                ))}
              </>
            )}
            <div className="intel-links">
              {buildingLinks(incident.bin, incident.bbl).map((l) => (
                <a key={l.label} href={l.url} target="_blank" rel="noreferrer" className="link-chip">
                  {l.label} ↗
                </a>
              ))}
            </div>
          </div>

          <div className="intel-section">
            <div className="intel-section-title">Hydrants · nearest 3 (≤300 m)</div>
            <StatusNote status={layers.hydrants} empty={hydrants.length ? undefined : 'NONE WITHIN 300 M'} />
            {hydrants.map((h) => (
              <button key={h.id} className="intel-row" onClick={() => flyToFeature(h.lat, h.lon)}>
                <span className="marker hydrant" />
                <span className="row-name">{h.id.toUpperCase()}</span>
                <span className="row-dist">{formatMeters(h.distanceM)}</span>
              </button>
            ))}
          </div>

          <div className="intel-section">
            <div className="intel-section-title">FDNY Firehouses · nearest 3</div>
            <StatusNote status={layers.firehouses} empty={firehouses.length ? undefined : 'NO DATA'} />
            {firehouses.map((f) => (
              <button key={f.name} className="intel-row" onClick={() => flyToFeature(f.lat, f.lon)}>
                <span className="marker firehouse" />
                <span className="row-name">
                  {f.name}
                  <i>{f.address}</i>
                </span>
                <span className="row-dist">{formatMeters(f.distanceM)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  )
}
