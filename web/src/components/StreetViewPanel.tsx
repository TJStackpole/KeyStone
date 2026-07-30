import { useEffect, useRef, useState } from 'react'
import { loadStreetViewLib } from '../lib/gmaps'
import { setAppState, useAppState } from '../state/store'

// ---------------------------------------------------------------------------
// Photographic street view of the incident address (Google Street View via
// the Maps JS API — rendered in our own DOM, key-gated upgrade path per
// CLAUDE.md). Opens aimed at the building's front: the server finds the
// nearest panorama, we compute the pano -> building bearing, and Google's
// native controls handle look-around and walking the block.
// ---------------------------------------------------------------------------

interface Meta {
  status: string
  lat?: number
  lon?: number
}

function bearingDeg(fromLat: number, fromLon: number, toLat: number, toLon: number): number {
  const φ1 = (fromLat * Math.PI) / 180
  const φ2 = (toLat * Math.PI) / 180
  const Δλ = ((toLon - fromLon) * Math.PI) / 180
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

export function StreetViewPanel() {
  const { streetViewOpen, incident } = useAppState()
  const [state, setState] = useState<'loading' | 'ready' | 'nocover' | 'apifail'>('loading')
  const holder = useRef<HTMLDivElement>(null)

  const key = (import.meta.env.GOOGLE_MAPS_API_KEY ?? '').trim()

  useEffect(() => {
    if (!streetViewOpen || !incident || !key) return
    let dead = false
    setState('loading')
    void (async () => {
      try {
        const [meta, lib] = await Promise.all([
          fetch(`/api/streetview/meta?lat=${incident.lat}&lon=${incident.lon}`)
            .then((r) => r.json() as Promise<Meta>)
            .catch(() => ({ status: 'ERROR' }) as Meta),
          loadStreetViewLib(key),
        ])
        if (dead || !holder.current) return
        if (meta.status !== 'OK' && meta.status !== 'ERROR') {
          setState('nocover')
          return
        }
        const heading =
          meta.status === 'OK' && meta.lat !== undefined && meta.lon !== undefined
            ? bearingDeg(meta.lat, meta.lon, incident.lat, incident.lon)
            : 0
        holder.current.innerHTML = ''
        new lib.StreetViewPanorama(holder.current, {
          position: { lat: incident.lat, lng: incident.lon },
          pov: { heading, pitch: 5 },
          zoom: 0.7,
          addressControl: false,
          fullscreenControl: false,
          motionTracking: false,
          motionTrackingControl: false,
          showRoadLabels: true,
        })
        setState('ready')
      } catch (err) {
        console.error('[streetview] JS API failed:', err)
        if (!dead) setState('apifail')
      }
    })()
    return () => {
      dead = true
      if (holder.current) holder.current.innerHTML = ''
    }
  }, [streetViewOpen, incident, key])

  if (!streetViewOpen || !incident) return null

  return (
    <section className="streetview-panel glass">
      <div className="panel-head">
        <span className="card-title">Street View</span>
        <span className="sv-addr">{incident.address}</span>
        <button className="panel-close" onClick={() => setAppState({ streetViewOpen: false })}>
          ✕
        </button>
      </div>
      {!key && (
        <div className="sv-note">
          STREET VIEW IS A KEYED UPGRADE (GOOGLE_MAPS_API_KEY) — KEYLESS INSTALLS: USE THE GND TOOL FOR THE 3D
          STREET-LEVEL VIEW.
        </div>
      )}
      {key && state === 'loading' && <div className="sv-note">FINDING THE NEAREST PANORAMA…</div>}
      {key && state === 'nocover' && <div className="sv-note">NO STREET VIEW COVERAGE AT THIS ADDRESS</div>}
      {key && state === 'apifail' && (
        <div className="sv-note">
          STREET VIEW COULD NOT LOAD — ENABLE "MAPS JAVASCRIPT API" FOR THIS GOOGLE KEY
        </div>
      )}
      {key && (
        <>
          <div ref={holder} className="sv-frame" style={{ display: state === 'ready' ? 'block' : 'none' }} />
          {state === 'ready' && (
            <div className="sv-hint">
              DRAG TO LOOK AROUND · CLICK ARROWS TO MOVE ALONG THE STREET · GOOGLE STREET VIEW
            </div>
          )}
        </>
      )}
    </section>
  )
}
